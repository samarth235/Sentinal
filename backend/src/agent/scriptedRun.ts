import type { RunSummary } from "../types.js";
import { buildToolCall, handleToolCall, type GatewayContext } from "../gateway/gateway.js";
import { bus as defaultBus } from "../integrations/index.js";
import { gatewayContext, summarize, type RunRecord } from "../runs.js";
import { SYSTEM_PROMPT } from "./prompts.js";

/** Replace "{{result:N}}" in string args with the tool result the agent received for call N. */
function fillPlaceholders(value: unknown, results: string[]): unknown {
  if (typeof value === "string") return value.replace(/\{\{result:(\d+)\}\}/g, (_, n) => results[Number(n)] ?? "");
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, results));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, results)]));
  return value;
}

/**
 * Deterministic replay: the user prompt goes into the ledger, then the scenario's scripted
 * tool calls (what a hijacked agent would do) go through the same gateway as live mode.
 */
export async function runScripted(run: RunRecord, extra: Partial<GatewayContext> = {}): Promise<RunSummary> {
  const bus = extra.bus ?? defaultBus;
  const ctx = gatewayContext(run, extra);
  await bus.publishSafe({ type: "run.started", run_id: run.run_id, scenario_id: run.scenario.id, shield: run.shield, mode: "scripted" });

  try {
    run.ledger.addSystem(SYSTEM_PROMPT);
    run.ledger.addUser(run.scenario.user_prompt);

    const results: string[] = [];
    for (const step of run.scenario.scripted_calls) {
      const args = fillPlaceholders(step.args, results) as Record<string, unknown>;
      const { result } = await handleToolCall(buildToolCall(ctx, step.tool, args), ctx);
      results.push(result);
    }
    run.status = "finished";
  } catch (err) {
    run.status = "failed";
    run.error = (err as Error).message;
  }

  const summary = summarize(run);
  await bus.publishSafe({ type: "run.finished", run_id: run.run_id, summary });
  return summary;
}
