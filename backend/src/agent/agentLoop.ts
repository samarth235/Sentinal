import Anthropic from "@anthropic-ai/sdk";
import type { RunSummary } from "../types.js";
import { config } from "../config.js";
import { buildToolCall, handleToolCall, type GatewayContext } from "../gateway/gateway.js";
import { bus as defaultBus } from "../integrations/index.js";
import { gatewayContext, summarize, type RunRecord } from "../runs.js";
import { claudeToolDefinitions } from "../tools/registry.js";
import { SYSTEM_PROMPT } from "./prompts.js";

const MAX_ITERATIONS = 8;

/**
 * Live mode: a standard Claude tool-use loop. Every tool_use block is routed through the
 * gateway, and whatever the gateway returns (tool output or a BLOCKED message) goes back
 * to the model as the tool_result.
 */
export async function runLive(run: RunRecord, extra: Partial<GatewayContext> = {}, client?: Anthropic): Promise<RunSummary> {
  const bus = extra.bus ?? defaultBus;
  const ctx = gatewayContext(run, extra);
  await bus.publishSafe({ type: "run.started", run_id: run.run_id, scenario_id: run.scenario.id, shield: run.shield, mode: "live" });

  try {
    if (!client && !config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set; use scripted mode");
    const anthropic = client ?? new Anthropic({ apiKey: config.anthropicApiKey });

    run.ledger.addSystem(SYSTEM_PROMPT);
    run.ledger.addUser(run.scenario.user_prompt);

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: run.scenario.user_prompt }];
    const tools = claudeToolDefinitions();

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: config.anthropicModel,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) await bus.publishSafe({ type: "agent.message", run_id: run.run_id, text });

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) break;

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const args = (use.input && typeof use.input === "object" ? use.input : {}) as Record<string, unknown>;
        const { result } = await handleToolCall(buildToolCall(ctx, use.name, args, use.id), ctx);
        results.push({ type: "tool_result", tool_use_id: use.id, content: result });
      }
      messages.push({ role: "user", content: results });
    }
    run.status = "finished";
  } catch (err) {
    run.status = "failed";
    run.error = (err as Error).message;
    await bus.publishSafe({ type: "agent.message", run_id: run.run_id, text: `Run failed: ${run.error}` });
  }

  const summary = summarize(run);
  await bus.publishSafe({ type: "run.finished", run_id: run.run_id, summary });
  return summary;
}
