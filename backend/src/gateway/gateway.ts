import { nanoid } from "nanoid";
import type { Decision, ToolCall } from "../types.js";
import { getPolicy, type Policy } from "../policy/loader.js";
import { isKnownTool, resultTrust } from "../tools/registry.js";
import { mockTools } from "../tools/mockTools.js";
import { bus as defaultBus, providers as defaultProviders, type Providers } from "../integrations/index.js";
import type { SentinelBus } from "../integrations/bus.js";
import { NOT_CONSULTED, safeClassify } from "../integrations/guard.js";
import type { ContextLedger } from "./contextLedger.js";
import { engineError, evaluate } from "./policyEngine.js";

export interface GatewayContext {
  run_id: string;
  session_id: string;
  profile: string;
  shield: boolean;
  ledger: ContextLedger;
  policy?: Policy;
  providers?: Providers;
  bus?: SentinelBus;
  /** Called for every decision (store it for the API / replay). */
  onDecision?: (decision: Decision, ledgerSize: number) => void;
  /** Called with the raw result text of every tool that actually ran. */
  onExecuted?: (decision: Decision, resultText: string) => void;
}

export interface GatewayResult {
  /** What goes back to the agent as the tool_result. */
  result: string;
  decision: Decision;
  executed: boolean;
}

export const BLOCKED_PREFIX = "BLOCKED_BY_SENTINEL";

export function buildToolCall(ctx: Pick<GatewayContext, "run_id" | "session_id" | "profile">, tool: string, args: Record<string, unknown>, callId?: string): ToolCall {
  return {
    call_id: callId ?? `call_${nanoid(10)}`,
    run_id: ctx.run_id,
    session_id: ctx.session_id,
    profile: ctx.profile,
    tool,
    args,
    requested_at: new Date().toISOString(),
  };
}

function labelFor(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool !== "browse_url" || typeof args.url !== "string") return undefined;
  try {
    const u = new URL(args.url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return args.url;
  }
}

/** Run the mock tool and record its output in the context ledger. */
function execute(call: ToolCall, ctx: GatewayContext): string {
  if (!isKnownTool(call.tool)) throw new Error(`no implementation for ${call.tool}`);
  const out = mockTools[call.tool](call.args, call.run_id);
  ctx.ledger.addToolResult(call.tool, resultTrust[call.tool], out.text, { label: labelFor(call.tool, call.args), records: out.records });
  return out.text;
}

const preview = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);

/**
 * The policy enforcement point. Every tool call the agent makes goes through here.
 */
export async function handleToolCall(call: ToolCall, ctx: GatewayContext): Promise<GatewayResult> {
  const bus = ctx.bus ?? defaultBus;
  const providers = ctx.providers ?? defaultProviders;
  await bus.publishSafe({ type: "tool.requested", run_id: ctx.run_id, call });

  // --- Shield OFF: run the tool with no checks (for the before/after demo). ---
  if (!ctx.shield) {
    const t0 = performance.now();
    const impact = (ctx.policy ?? safePolicy())?.tools[call.tool]?.impact ?? "critical";
    const decision: Decision = {
      decision_id: `dec_${nanoid(10)}`,
      call,
      verdict: "ALLOW",
      rule_id: "SHIELD_OFF",
      reasons: [],
      impact,
      session_tainted: ctx.ledger.isTainted(),
      provenance: [],
      guard: { ...NOT_CONSULTED, provider: "shield-off" },
      shield: false,
      latency_ms: 0,
      decided_at: new Date().toISOString(),
    };
    ctx.onDecision?.(decision, ctx.ledger.segments.length);
    let text: string;
    try {
      text = execute(call, ctx);
    } catch (err) {
      text = `Tool error: ${(err as Error).message}`;
    }
    decision.outcome = "UNPROTECTED_EXECUTED";
    decision.latency_ms = round(performance.now() - t0);
    ctx.onExecuted?.(decision, text);
    await bus.publishSafe({ type: "decision.made", run_id: ctx.run_id, decision });
    await bus.publishSafe({ type: "tool.executed", run_id: ctx.run_id, decision_id: decision.decision_id, result_preview: preview(text) });
    return { result: text, decision, executed: true };
  }

  // --- Shield ON ---
  const t0 = performance.now();
  const ledgerSize = ctx.ledger.segments.length;
  let decision: Decision;
  try {
    const policy = ctx.policy ?? getPolicy();
    const guard = ctx.ledger.isTainted()
      ? await safeClassify(providers.guard, { call, untrustedText: ctx.ledger.untrustedText() })
      : NOT_CONSULTED;
    decision = evaluate(call, ctx.ledger, policy, guard);
  } catch (err) {
    decision = engineError(baseFor(call), err);
  }
  decision.shield = true;
  decision.latency_ms = round(performance.now() - t0);
  ctx.onDecision?.(decision, ledgerSize);

  // No unaudited actions: if the decision cannot be audited, the call is denied.
  try {
    await bus.publish({ type: "decision.made", run_id: ctx.run_id, decision });
  } catch (err) {
    Object.assign(decision, engineError(baseFor(call), new Error(`audit log unavailable: ${(err as Error).message}`)), {
      decision_id: decision.decision_id,
      shield: true,
      latency_ms: decision.latency_ms,
    });
  }

  let executed = false;
  let text = "";

  if (decision.verdict === "ALLOW") {
    ({ executed, text } = runTool(call, ctx));
    decision.outcome = executed ? "EXECUTED" : "BLOCKED";
  } else if (decision.verdict === "DENY") {
    decision.outcome = "BLOCKED";
  } else {
    await bus.publishSafe({ type: "approval.requested", run_id: ctx.run_id, decision });
    let answer: Awaited<ReturnType<Providers["approvals"]["request"]>>;
    try {
      answer = await providers.approvals.request(decision);
    } catch {
      answer = { result: "timeout" };
    }
    let audited = true;
    try {
      await bus.publish({ type: "approval.resolved", run_id: ctx.run_id, decision_id: decision.decision_id, result: answer.result, approver: answer.approver });
    } catch {
      audited = false;
    }
    if (answer.result === "approved" && audited) {
      ({ executed, text } = runTool(call, ctx));
      decision.outcome = executed ? "APPROVED_EXECUTED" : "BLOCKED";
    } else {
      decision.outcome = answer.result === "approved" ? "BLOCKED" : answer.result === "rejected" ? "REJECTED" : "TIMED_OUT";
    }
  }

  await bus.publishSafe({ type: "decision.made", run_id: ctx.run_id, decision });

  if (executed) {
    ctx.onExecuted?.(decision, text);
    await bus.publishSafe({ type: "tool.executed", run_id: ctx.run_id, decision_id: decision.decision_id, result_preview: preview(text) });
    return { result: text, decision, executed };
  }
  return { result: blockedMessage(decision), decision, executed };
}

function runTool(call: ToolCall, ctx: GatewayContext): { executed: boolean; text: string } {
  try {
    return { executed: true, text: execute(call, ctx) };
  } catch (err) {
    return { executed: false, text: `Tool error: ${(err as Error).message}` };
  }
}

export function blockedMessage(decision: Decision): string {
  const why =
    decision.outcome === "REJECTED"
      ? "A human reviewer rejected this action."
      : decision.outcome === "TIMED_OUT"
        ? "No human approved this action in time, so it was blocked."
        : decision.reasons.map((r) => r.message).join(" ");
  return `${BLOCKED_PREFIX}: ${why} (rule ${decision.rule_id}, decision ${decision.decision_id})`;
}

function baseFor(call: ToolCall) {
  return {
    decision_id: `dec_${nanoid(10)}`,
    call,
    guard: { available: false, label: "unknown" as const, score: 0, provider: "none" },
    shield: true,
    latency_ms: 0,
    decided_at: new Date().toISOString(),
  };
}

function safePolicy(): Policy | undefined {
  try {
    return getPolicy();
  } catch {
    return undefined;
  }
}

const round = (ms: number) => Math.round(ms * 100) / 100;
