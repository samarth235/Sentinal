import { nanoid } from "nanoid";
import type { Decision, ToolCall, Trust } from "../types.js";
import { config } from "../config.js";
import { getPolicy, type Policy } from "../policy/loader.js";
import { trustFor } from "../tools/registry.js";
import { browseReal, isFixtureUrl, mockTools, type ToolResult } from "../tools/mockTools.js";
import { bus as defaultBus, providers as defaultProviders, type Providers } from "../integrations/index.js";
import type { SentinelBus } from "../integrations/bus.js";
import { NOT_CONSULTED, safeClassify } from "../integrations/guard.js";
import type { ContextLedger } from "./contextLedger.js";
import { engineError, evaluate } from "./policyEngine.js";

/** Runs a tool for real. Return the text the agent sees, plus structured rows for INTERNAL_DATA tools. */
export type ToolExecutor = (call: ToolCall) => Promise<ToolResult> | ToolResult;

export interface GatewayContext {
  run_id: string;
  session_id: string;
  profile: string;
  shield: boolean;
  ledger: ContextLedger;
  policy?: Policy;
  providers?: Providers;
  bus?: SentinelBus;
  /** How allowed calls run. Defaults to the built-in mock tools (demo). */
  executor?: ToolExecutor;
  /**
   * Remote agents run tools on their own side: Sentinel decides, the caller executes and then
   * reports the result with recordToolResult(). When true, nothing runs inside the gateway.
   */
  deferExecution?: boolean;
  /** Called for every decision (store it for the API / replay). */
  onDecision?: (decision: Decision, ledgerSize: number) => void;
  /** Called with the raw result text of every tool that actually ran. */
  onExecuted?: (decision: Decision, resultText: string) => void;
}

export interface GatewayResult {
  /** What goes back to the agent as the tool_result (a BLOCKED message when not executed). */
  result: string;
  decision: Decision;
  executed: boolean;
  /** True when the call was allowed or approved (with deferExecution, the caller may now run it). */
  authorized: boolean;
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

export function labelFor(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === "read_email") return "inbox";
  if (tool !== "browse_url" || typeof args.url !== "string") return undefined;
  try {
    const u = new URL(args.url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return args.url;
  }
}

export const mockExecutor: ToolExecutor = (call) => {
  if (call.tool === "browse_url" && config.enableRealBrowse && typeof call.args.url === "string" && !isFixtureUrl(call.args.url)) {
    return browseReal(call.args.url);
  }
  const impl = mockTools[call.tool];
  if (!impl) throw new Error(`no implementation for ${call.tool}`);
  return impl(call.args, call.run_id);
};

/** Put a tool's output into the context ledger with the trust level the policy gives that tool. */
export function recordToolResult(ctx: GatewayContext, call: Pick<ToolCall, "tool" | "args">, out: ToolResult, trustOverride?: Trust) {
  const trust = trustOverride ?? trustFor(call.tool, ctx.policy ?? safePolicy());
  ctx.ledger.addToolResult(call.tool, trust, out.text, { label: out.label ?? labelFor(call.tool, call.args), records: out.records });
}

async function execute(call: ToolCall, ctx: GatewayContext): Promise<string> {
  const out = await (ctx.executor ?? mockExecutor)(call);
  const text = typeof out?.text === "string" ? out.text : JSON.stringify(out ?? "");
  recordToolResult(ctx, call, { ...out, text });
  return text;
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
    decision.outcome = "UNPROTECTED_EXECUTED";
    if (ctx.deferExecution) {
      await bus.publishSafe({ type: "decision.made", run_id: ctx.run_id, decision });
      return { result: "", decision, executed: false, authorized: true };
    }
    let text: string;
    try {
      text = await execute(call, ctx);
    } catch (err) {
      text = `Tool error: ${(err as Error).message}`;
    }
    decision.latency_ms = round(performance.now() - t0);
    ctx.onExecuted?.(decision, text);
    await bus.publishSafe({ type: "decision.made", run_id: ctx.run_id, decision });
    await bus.publishSafe({ type: "tool.executed", run_id: ctx.run_id, decision_id: decision.decision_id, result_preview: preview(text) });
    return { result: text, decision, executed: true, authorized: true };
  }

  // --- Shield ON ---
  const t0 = performance.now();
  const ledgerSize = ctx.ledger.segments.length;
  let decision: Decision;
  try {
    const policy = ctx.policy ?? getPolicy();
    const guard = ctx.ledger.isTainted()
      ? await safeClassify(providers.guard, { call, untrustedText: ctx.ledger.untrustedText() }, config.guardTimeoutMs + 250)
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

  let authorized = false;
  if (decision.verdict === "ALLOW") {
    authorized = true;
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
    if (answer.result === "approved" && audited) authorized = true;
    else decision.outcome = answer.result === "approved" ? "BLOCKED" : answer.result === "rejected" ? "REJECTED" : "TIMED_OUT";
  }

  const approved = decision.verdict === "REQUIRE_APPROVAL";
  if (authorized && ctx.deferExecution) {
    // The caller runs the tool; its result arrives later through recordToolResult().
    decision.outcome = approved ? "APPROVED_EXECUTED" : "EXECUTED";
    await bus.publishSafe({ type: "decision.made", run_id: ctx.run_id, decision });
    return { result: "", decision, executed: false, authorized: true };
  }

  let executed = false;
  let text = "";
  if (authorized) {
    try {
      text = await execute(call, ctx);
      executed = true;
    } catch (err) {
      text = `Tool error: ${(err as Error).message}`;
    }
    decision.outcome = executed ? (approved ? "APPROVED_EXECUTED" : "EXECUTED") : "BLOCKED";
  }

  await bus.publishSafe({ type: "decision.made", run_id: ctx.run_id, decision });

  if (executed) {
    ctx.onExecuted?.(decision, text);
    await bus.publishSafe({ type: "tool.executed", run_id: ctx.run_id, decision_id: decision.decision_id, result_preview: preview(text) });
    return { result: text, decision, executed, authorized };
  }
  return { result: authorized ? text : blockedMessage(decision), decision, executed, authorized };
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
