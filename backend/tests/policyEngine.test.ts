import { describe, expect, it } from "vitest";
import { ContextLedger } from "../src/gateway/contextLedger.js";
import { evaluate } from "../src/gateway/policyEngine.js";
import { loadPolicy, parsePolicy, PolicyError } from "../src/policy/loader.js";
import { mockTools } from "../src/tools/mockTools.js";
import type { GuardSignal, ToolCall } from "../src/types.js";

const policy = loadPolicy("./src/policy/policy.yaml");

const benign: GuardSignal = { available: true, label: "benign", score: 0.1, provider: "test" };
const injection: GuardSignal = { available: true, label: "injection", score: 0.9, provider: "test" };
const down: GuardSignal = { available: false, label: "unknown", score: 0, provider: "test" };

function call(tool: string, args: Record<string, unknown>, profile = "research_assistant"): ToolCall {
  return { call_id: "c1", run_id: "r1", session_id: "s1", profile, tool, args, requested_at: new Date().toISOString() };
}

function ledgerWith(user: string, page?: string) {
  const ledger = new ContextLedger("r1");
  ledger.addUser(user);
  if (page) {
    const text = mockTools.browse_url({ url: page }, "r1").text;
    ledger.addToolResult("browse_url", "UNTRUSTED", text, { label: page.replace("https://", "") });
  }
  return ledger;
}

const POISONED = "https://news.example.test/ai-trends-2026";
const CLEAN = "https://news.example.test/solar-microgrids";

describe("policy engine rules", () => {
  it("R0: an exception inside evaluate denies with ENGINE_ERROR", () => {
    const ledger = ledgerWith("hi");
    ledger.isTainted = () => {
      throw new Error("boom");
    };
    const d = evaluate(call("browse_url", { url: CLEAN }), ledger, policy, benign);
    expect(d.verdict).toBe("DENY");
    expect(d.rule_id).toBe("R0");
    expect(d.reasons[0].code).toBe("ENGINE_ERROR");
  });

  it("R1: tool outside the profile is denied", () => {
    const d = evaluate(call("send_payment", { payee: "x@upi", amount_inr: 10 }), ledgerWith("pay x@upi 10"), policy, benign);
    expect([d.verdict, d.rule_id, d.reasons[0].code]).toEqual(["DENY", "R1", "TOOL_NOT_PERMITTED"]);
  });

  it("R1: tool missing from policy (or unknown profile) is denied", () => {
    expect(evaluate(call("delete_everything", {}), ledgerWith("x"), policy, benign).rule_id).toBe("R1");
    expect(evaluate(call("browse_url", { url: CLEAN }, "ghost"), ledgerWith("x"), policy, benign).rule_id).toBe("R1");
  });

  it("R2: invalid args are denied", () => {
    const d = evaluate(call("send_email", { to: "not-an-email", subject: "s" }), ledgerWith("x"), policy, benign);
    expect([d.verdict, d.rule_id, d.reasons[0].code]).toEqual(["DENY", "R2", "INVALID_ARGS"]);
  });

  it("R3: query_db field outside allowed_fields is denied", () => {
    const d = evaluate(call("query_db", { fields: ["name", "pan"] }), ledgerWith("x"), policy, benign);
    expect([d.verdict, d.rule_id, d.reasons[0].code]).toEqual(["DENY", "R3", "SENSITIVE_FIELD_NOT_PERMITTED"]);
    expect(d.reasons[0].message).toContain("pan");
  });

  it("R4: high-impact arg sourced only from untrusted content is denied with evidence", () => {
    const ledger = ledgerWith("Read the page and give me a short summary", POISONED);
    const d = evaluate(call("send_email", { to: "attacker@evil.test", subject: "weekly sync", body: "hi" }), ledger, policy, injection);
    expect([d.verdict, d.rule_id, d.reasons[0].code]).toEqual(["DENY", "R4", "ARG_FROM_UNTRUSTED_CONTENT"]);
    expect(d.reasons[0].evidence?.length).toBeGreaterThan(0);
    expect(d.reasons[0].message).toBe(
      "Recipient attacker@evil.test was not in your request; it came from hidden text on news.example.test/ai-trends-2026.",
    );
  });

  it("R5: sensitive data to an untrusted domain is denied with evidence", () => {
    const ledger = ledgerWith("email the PAN list to ops@partner.test");
    const d = evaluate(call("send_email", { to: "ops@partner.test", subject: "list", body: "ABCPE1234F" }), ledger, policy, benign);
    expect([d.verdict, d.rule_id, d.reasons[0].code]).toEqual(["DENY", "R5", "SENSITIVE_DATA_EGRESS"]);
    expect(d.reasons[0].evidence?.[0].excerpt).toContain("ABCPE1234F");
  });

  it("R5: sensitive data leaking via browse_url is denied", () => {
    const d = evaluate(call("browse_url", { url: "https://x.test/?p=ABCPE1234F" }), ledgerWith("x"), policy, benign);
    expect(d.rule_id).toBe("R5");
  });

  it("R5: sensitive data to a trusted domain needs approval rather than a block", () => {
    const ledger = ledgerWith("email ABCPE1234F to priya@company.test");
    const d = evaluate(call("send_email", { to: "priya@company.test", subject: "s", body: "ABCPE1234F" }), ledger, policy, benign);
    expect(d.verdict).toBe("REQUIRE_APPROVAL");
    expect(d.rule_id).toBe("R5");
    expect(d.reasons[0].code).toBe("SENSITIVE_DATA_EGRESS");
  });

  it("R6: tainted session + guard injection escalates to approval", () => {
    const ledger = ledgerWith("summarise and email to priya@company.test", POISONED);
    const d = evaluate(call("send_email", { to: "priya@company.test", subject: "s", body: "b" }), ledger, policy, injection);
    expect([d.verdict, d.rule_id]).toEqual(["REQUIRE_APPROVAL", "R6"]);
    expect(d.reasons.map((r) => r.code)).toEqual(["GUARD_FLAGGED_INJECTION", "HIGH_IMPACT_REQUIRES_CONFIRMATION"]);
  });

  it("R6: guard can only escalate; it never turns a DENY into ALLOW", () => {
    const d = evaluate(call("query_db", { fields: ["pan"] }), ledgerWith("x", POISONED), policy, benign);
    expect(d.verdict).toBe("DENY");
  });

  it("R6: guard injection on a low-impact call escalates it too", () => {
    const d = evaluate(call("browse_url", { url: CLEAN }), ledgerWith("x", POISONED), policy, injection);
    expect([d.verdict, d.rule_id]).toEqual(["REQUIRE_APPROVAL", "R6"]);
  });

  it("R7: guard unavailable on a high-impact call requires approval", () => {
    const ledger = ledgerWith("email to priya@company.test", CLEAN);
    const d = evaluate(call("send_email", { to: "priya@company.test", subject: "s", body: "b" }), ledger, policy, down);
    expect([d.verdict, d.rule_id, d.reasons[0].code]).toEqual(["REQUIRE_APPROVAL", "R7", "GUARD_UNAVAILABLE"]);
  });

  it("R8: high-impact call with user-sourced args requires confirmation", () => {
    const ledger = ledgerWith("email a summary to priya@company.test", CLEAN);
    const d = evaluate(call("send_email", { to: "priya@company.test", subject: "s", body: "b" }), ledger, policy, benign);
    expect([d.verdict, d.rule_id]).toEqual(["REQUIRE_APPROVAL", "R8"]);
    expect(d.provenance[0].class).toBe("USER_SOURCED");
  });

  it("R9: high-impact arg of unknown provenance adds a reason", () => {
    const d = evaluate(call("send_email", { to: "boss@company.test", subject: "s", body: "b" }), ledgerWith("email my boss"), policy, benign);
    expect(d.verdict).toBe("REQUIRE_APPROVAL");
    expect(d.reasons.map((r) => r.code)).toContain("ARG_PROVENANCE_UNKNOWN");
  });

  it("R10: nothing fired => ALLOW", () => {
    const d = evaluate(call("query_db", { fields: ["name", "city"] }), ledgerWith("list customers"), policy, benign);
    expect([d.verdict, d.rule_id, d.reasons[0].code]).toEqual(["ALLOW", "R10", "POLICY_DEFAULT_ALLOW"]);
  });
});

describe("policy loader", () => {
  it("rejects malformed YAML and schema violations", () => {
    expect(() => parsePolicy("version: 1\n  bad: [")).toThrow(PolicyError);
    expect(() => parsePolicy("version: 2")).toThrow(PolicyError);
    expect(() =>
      parsePolicy(`version: 1
defaults: { fail_mode: open, approval_timeout_seconds: 60, guard_threshold: 0.7 }
trusted_email_domains: []
sensitive: { fields: [], patterns: {} }
tools: {}
profiles: {}`),
    ).toThrow(PolicyError);
  });
});
