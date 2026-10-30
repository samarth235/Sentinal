import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runScripted } from "../src/agent/scriptedRun.js";
import { buildToolCall, handleToolCall, BLOCKED_PREFIX } from "../src/gateway/gateway.js";
import { HttpApprovalProvider, StaticApprovalProvider } from "../src/integrations/approvals.js";
import { JsonlAuditSink, type AuditSink } from "../src/integrations/audit.js";
import { SentinelBus } from "../src/integrations/bus.js";
import { HeuristicGuard, type GuardProvider } from "../src/integrations/guard.js";
import type { Providers } from "../src/integrations/index.js";
import { initPolicy } from "../src/policy/loader.js";
import { createRun, gatewayContext } from "../src/runs.js";
import { scenarios, getScenario } from "../src/scenarios.js";
import { getLedger, getOutbox, reset } from "../src/tools/state.js";
import type { BusEvent } from "../src/types.js";

beforeAll(() => initPolicy("./src/policy/policy.yaml"));
beforeEach(() => reset());

function harness(overrides: Partial<Providers> = {}) {
  const audit = new JsonlAuditSink(null);
  const bus = new SentinelBus();
  const providers: Providers = { guard: new HeuristicGuard(), approvals: new StaticApprovalProvider("approved"), audit, ...overrides };
  bus.useAudit(() => providers.audit);
  const events: BusEvent[] = [];
  bus.on("event", (e) => events.push(e));
  return { bus, providers, audit, events };
}

describe("scenarios, scripted mode", () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: shield ON matches expected decisions`, async () => {
      const approval = scenario.expected.find((e) => e.approval)?.approval ?? "rejected";
      const h = harness({ approvals: new StaticApprovalProvider(approval) });
      const run = createRun(scenario, true, "scripted", h.bus);
      const summary = await runScripted(run, { bus: h.bus, providers: h.providers });

      expect(summary.decisions.map((d) => [d.verdict, d.rule_id])).toEqual(scenario.expected.map((e) => [e.verdict, e.rule_id]));
      scenario.expected.forEach((e, i) => e.outcome && expect(summary.decisions[i].outcome).toBe(e.outcome));
      expect(summary.attack_succeeded).toBe(false);
      for (const d of summary.decisions) {
        expect(d.shield).toBe(true);
        expect(d.latency_ms).toBeGreaterThanOrEqual(0);
        expect(d.reasons.length).toBeGreaterThan(0);
      }
      // Every decision was audited.
      expect(h.audit.records.some((r) => r.event.type === "run.finished")).toBe(true);
    });

    it(`${scenario.id}: shield OFF runs every call unprotected`, async () => {
      const h = harness();
      const run = createRun(scenario, false, "scripted", h.bus);
      const summary = await runScripted(run, { bus: h.bus, providers: h.providers });
      expect(summary.decisions.every((d) => d.outcome === "UNPROTECTED_EXECUTED" && d.rule_id === "SHIELD_OFF")).toBe(true);
      expect(summary.attack_succeeded).toBe(scenario.attack_success_check.type !== "none");
    });
  }

  it("S1 sends the legitimate email after approval", async () => {
    const h = harness({ approvals: new StaticApprovalProvider("approved") });
    const run = createRun(getScenario("S1_legit")!, true, "scripted", h.bus);
    await runScripted(run, { bus: h.bus, providers: h.providers });
    expect(getOutbox(run.run_id).map((e) => e.to)).toEqual(["priya@company.test"]);
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(true);
  });

  it("S2: shield OFF leaks PANs to the attacker; shield ON sends nothing", async () => {
    const off = harness();
    const runOff = createRun(getScenario("S2_injection")!, false, "scripted", off.bus);
    await runScripted(runOff, { bus: off.bus, providers: off.providers });
    const leaked = getOutbox(runOff.run_id);
    expect(leaked).toHaveLength(1);
    expect(leaked[0].to).toBe("attacker@evil.test");
    expect(leaked[0].body).toContain("ABCPE1234F");

    const on = harness();
    const runOn = createRun(getScenario("S2_injection")!, true, "scripted", on.bus);
    const summary = await runScripted(runOn, { bus: on.bus, providers: on.providers });
    expect(getOutbox(runOn.run_id)).toHaveLength(0);
    const email = summary.decisions[2];
    expect(email.reasons[0].code).toBe("ARG_FROM_UNTRUSTED_CONTENT");
    const ev = email.reasons[0].evidence![0];
    const seg = runOn.ledger.get(ev.segment_id)!;
    expect(seg.text.slice(ev.start, ev.end)).toBe("attacker@evil.test");
  });

  it("S4: shield ON leaves the payment ledger empty", async () => {
    const h = harness();
    const run = createRun(getScenario("S4_beyond_permission")!, true, "scripted", h.bus);
    await runScripted(run, { bus: h.bus, providers: h.providers });
    expect(getLedger(run.run_id)).toHaveLength(0);
  });
});

describe("fail-closed behaviour", () => {
  const S1 = () => getScenario("S1_legit")!;

  async function taintedEmailCall(overrides: Partial<Providers>) {
    const h = harness(overrides);
    const run = createRun(S1(), true, "scripted", h.bus);
    const ctx = gatewayContext(run, { bus: h.bus, providers: h.providers });
    run.ledger.addUser(S1().user_prompt);
    await handleToolCall(buildToolCall(ctx, "browse_url", { url: "https://news.example.test/solar-microgrids" }), ctx);
    const res = await handleToolCall(buildToolCall(ctx, "send_email", { to: "priya@company.test", subject: "s", body: "b" }), ctx);
    return { res, run, h };
  }

  it("guard throws on a tainted high-impact call => REQUIRE_APPROVAL with GUARD_UNAVAILABLE", async () => {
    const broken: GuardProvider = { classify: async () => { throw new Error("groq down"); } };
    const { res } = await taintedEmailCall({ guard: broken, approvals: new StaticApprovalProvider("rejected") });
    expect(res.decision.verdict).toBe("REQUIRE_APPROVAL");
    expect(res.decision.rule_id).toBe("R7");
    expect(res.decision.reasons[0].code).toBe("GUARD_UNAVAILABLE");
    expect(res.decision.guard.available).toBe(false);
    expect(res.executed).toBe(false);
  });

  it("guard that hangs is treated as unavailable after the timeout", async () => {
    const { safeClassify } = await import("../src/integrations/guard.js");
    const hang: GuardProvider = { classify: () => new Promise(() => {}) };
    const signal = await safeClassify(hang, { call: {} as never, untrustedText: "" }, 20);
    expect(signal.available).toBe(false);
  });

  it("approval timeout => TIMED_OUT and the tool does not run", async () => {
    const approvals = new HttpApprovalProvider(() => 0.05);
    const { res, run } = await taintedEmailCall({ approvals });
    expect(res.decision.outcome).toBe("TIMED_OUT");
    expect(res.result.startsWith(BLOCKED_PREFIX)).toBe(true);
    expect(getOutbox(run.run_id)).toHaveLength(0);
  });

  it("HTTP approval resolves via resolve()", async () => {
    const approvals = new HttpApprovalProvider(() => 5);
    const h = harness({ approvals });
    h.bus.on("approval.requested", (e) => setTimeout(() => approvals.resolve(e.decision.decision_id, true, "judge"), 5));
    const run = createRun(S1(), true, "scripted", h.bus);
    const summary = await runScripted(run, { bus: h.bus, providers: h.providers });
    expect(summary.decisions[1].outcome).toBe("APPROVED_EXECUTED");
  });

  it("policy evaluation throws => DENY with ENGINE_ERROR", async () => {
    const h = harness();
    const run = createRun(S1(), true, "scripted", h.bus);
    const ctx = gatewayContext(run, { bus: h.bus, providers: h.providers });
    run.ledger.isTainted = () => { throw new Error("corrupt ledger"); };
    const res = await handleToolCall(buildToolCall(ctx, "browse_url", { url: "https://news.example.test/solar-microgrids" }), ctx);
    expect(res.decision.verdict).toBe("DENY");
    expect(res.decision.reasons[0].code).toBe("ENGINE_ERROR");
    expect(res.executed).toBe(false);
  });

  it("audit append fails => DENY with ENGINE_ERROR (no unaudited actions)", async () => {
    const failing: AuditSink = { append: async () => { throw new Error("db down"); } };
    const h = harness({ audit: failing });
    const run = createRun(S1(), true, "scripted", h.bus);
    const ctx = gatewayContext(run, { bus: h.bus, providers: h.providers });
    run.ledger.addUser(S1().user_prompt);
    const res = await handleToolCall(buildToolCall(ctx, "browse_url", { url: "https://news.example.test/solar-microgrids" }), ctx);
    expect(res.decision.verdict).toBe("DENY");
    expect(res.decision.reasons[0].code).toBe("ENGINE_ERROR");
    expect(res.executed).toBe(false);
  });
});
