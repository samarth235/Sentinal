import { describe, expect, it, beforeAll } from "vitest";
import { config, parseTokens, validateConfig } from "../src/config.js";
import { startAuditMonitor } from "../src/integrations/auditMonitor.js";
import { HashChainAuditSink, MemoryChainStore } from "../src/integrations/hashChain.js";
import { maskText } from "../src/integrations/masking.js";
import { activeOverrides, addOverride, clearOverrides, getPolicy, initPolicy, parsePolicy } from "../src/policy/loader.js";
import { isPrivateAddress, safeFetchText } from "../src/tools/safeFetch.js";
import { decisionsFromAudit, forensics, unresolvedApprovals } from "../src/history.js";
import { validateArgs } from "../src/tools/registry.js";
import type { BusEvent, Decision } from "../src/types.js";

beforeAll(() => initPolicy("./src/policy/policy.yaml"));

describe("startup config checks", () => {
  const prod = { ...config, production: true, strict: false, operatorTokens: parseTokens("alice:" + "x".repeat(30), "operator"), agentKeys: [], groqApiKey: "", groqModel: "", enableTamperDemo: false, databaseUrl: "postgres://x", telegramWebhookUrl: "" };

  it("parses named tokens", () => {
    expect(parseTokens("alice:aaa,bbb", "operator")).toEqual([{ name: "alice", token: "aaa" }, { name: "operator", token: "bbb" }]);
  });

  it("refuses a deployment without a token or with short tokens", () => {
    expect(validateConfig({ ...prod, operatorTokens: [] }).errors.join()).toMatch(/requires API_TOKEN/);
    expect(validateConfig({ ...prod, production: false, strict: true, operatorTokens: [], groqApiKey: "k", groqModel: "m" }).errors.join()).toMatch(/requires API_TOKEN/);
    expect(validateConfig({ ...prod, operatorTokens: parseTokens("short", "op") }).errors.join()).toMatch(/at least 24/);
    expect(validateConfig({ ...prod, agentKeys: prod.operatorTokens }).errors.join()).toMatch(/reuse/);
  });

  it("demo mode in production starts (with a warning); strict mode needs Groq and no tamper demo", () => {
    expect(validateConfig(prod).errors).toEqual([]);
    expect(validateConfig(prod).warnings.join()).toMatch(/SENTINEL_MODE=demo/);
    expect(validateConfig({ ...prod, strict: true }).errors.join()).toMatch(/Groq/);
    expect(validateConfig({ ...prod, strict: true, groqApiKey: "k", groqModel: "m" }).errors).toEqual([]);
    expect(validateConfig({ ...prod, strict: true, groqApiKey: "k", groqModel: "m", enableTamperDemo: true }).errors.join()).toMatch(/TAMPER/);
    expect(validateConfig({ ...prod, telegramWebhookUrl: "https://x.test" }).errors.join()).toMatch(/WEBHOOK_SECRET/);
  });
});

describe("SSRF guard for real browsing", () => {
  it("classifies private and public addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses internal hosts and non-http schemes before fetching", async () => {
    await expect(safeFetchText("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/non-public/);
    await expect(safeFetchText("http://localhost:4000/api/audit")).rejects.toThrow(/not public/);
    await expect(safeFetchText("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(safeFetchText("http://user:pw@example.com")).rejects.toThrow(/credentials/);
  });
});

describe("masking", () => {
  it("masks Luhn-valid cards, Aadhaar and API keys, keeps ordinary numbers and lengths", () => {
    const input = "card 4111 1111 1111 1111, ref 1234567890123, aadhaar 2345 6789 0123, key sk-ant-abcdefghijklmnop1234";
    const out = maskText(input);
    expect(out).toContain("**** **** **** 1111");
    expect(out).toContain("1234567890123");
    expect(out).toContain("**** **** 0123");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out.length).toBe(input.length);
  });
});

describe("policy", () => {
  it("adds a policy version and validates policy-defined tools with JSON Schema", () => {
    expect(getPolicy().policy_version).toMatch(/^[0-9a-f]{12}$/);
    expect(validateArgs("create_ticket", { title: "t", body: "b" }, getPolicy())).toEqual({ ok: true });
    const bad = validateArgs("create_ticket", { title: "t", body: "b", extra: 1 }, getPolicy());
    expect(bad.ok).toBe(false);
    expect(validateArgs("unknown_tool", {}, getPolicy())).toMatchObject({ ok: false });
  });

  it("rejects invalid policies (fail closed)", () => {
    expect(() => parsePolicy("version: 2")).toThrow(/validation/);
  });

  it("overrides only add a tool for a bounded time and change the policy version", () => {
    const before = getPolicy().policy_version;
    expect(getPolicy().profiles.research_assistant.allowed_tools).not.toContain("send_payment");
    addOverride({ profile: "research_assistant", tool: "send_payment", expires_at: Date.now() + 60_000, granted_by: "test" });
    expect(getPolicy().profiles.research_assistant.allowed_tools).toContain("send_payment");
    expect(getPolicy().policy_version).not.toBe(before);
    expect(() => addOverride({ profile: "research_assistant", tool: "rm_rf", expires_at: Date.now() + 1000, granted_by: "t" })).toThrow();
    clearOverrides();
    addOverride({ profile: "research_assistant", tool: "send_payment", expires_at: Date.now() - 1, granted_by: "test" });
    expect(activeOverrides()).toHaveLength(0);
    expect(getPolicy().profiles.research_assistant.allowed_tools).not.toContain("send_payment");
  });
});

describe("audit history and monitor", () => {
  const dec = (id: string, run: string, verdict: Decision["verdict"], outcome?: Decision["outcome"]): BusEvent => ({
    type: "decision.made",
    run_id: run,
    decision: { decision_id: id, verdict, rule_id: "R4", outcome, decided_at: new Date().toISOString(), call: { run_id: run, tool: "send_email" }, shield: true, latency_ms: 1, guard: { provider: "x" } } as unknown as Decision,
  });

  it("derives decisions, dangling approvals and forensics from the chain", async () => {
    const chain = new HashChainAuditSink(new MemoryChainStore(null));
    await chain.append({ type: "context.added", run_id: "r1", segment: { segment_id: "s1", source: "tool_result", tool: "browse_url", trust: "UNTRUSTED", text: "mail drop@evil.test", added_at: "2000-01-01T00:00:00Z", label: "evil.test/page" } });
    await chain.append(dec("d1", "r1", "DENY"));
    await chain.append(dec("d1", "r1", "DENY", "BLOCKED"));
    await chain.append({ type: "approval.requested", run_id: "r1", decision: { decision_id: "d2" } as Decision });
    const rows = await chain.list();
    expect(decisionsFromAudit(rows)).toHaveLength(1);
    expect(decisionsFromAudit(rows)[0].outcome).toBe("BLOCKED");
    expect(unresolvedApprovals(rows)).toEqual([{ decision_id: "d2", run_id: "r1" }]);
    const hits = forensics(rows, "evil.test/page");
    expect(hits[0].decisions.map((d) => d.decision_id)).toEqual(["d1"]);
  });

  it("alerts on tampering and on tail truncation, and anchors the head", async () => {
    const store = new MemoryChainStore(null);
    const chain = new HashChainAuditSink(store);
    for (let i = 0; i < 3; i++) await chain.append({ type: "agent.message", run_id: "r", text: `m${i}` });
    const sent: string[] = [];
    const m = startAuditMonitor({ chain, verifyEveryMinutes: 0, anchorEveryMinutes: 0, notify: (t) => void sent.push(t) });
    expect((await m.verify()).last_result).toBe("valid");
    await m.anchor();
    expect(sent.at(-1)).toMatch(/anchor\nrow #3/);
    store.rows.pop(); // delete the newest row: still a valid chain, but shorter
    expect((await m.verify()).last_result).toBe("truncated");
    expect(sent.at(-1)).toMatch(/TRUNCATED/);
    m.stop();
  });
});
