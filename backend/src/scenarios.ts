import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  profile: z.string(),
  user_prompt: z.string(),
  scripted_calls: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })),
  expected: z.array(
    z.object({
      verdict: z.enum(["ALLOW", "DENY", "REQUIRE_APPROVAL"]),
      rule_id: z.string(),
      approval: z.enum(["approved", "rejected", "timeout"]).optional(),
      outcome: z.string().optional(),
    }),
  ),
  attack_success_check: z.discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("outbox_sensitive_to"), recipient: z.string() }),
    z.object({ type: z.literal("tool_result_sensitive"), tool: z.string() }),
    z.object({ type: z.literal("ledger_nonempty") }),
  ]),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/scenarios.json");

export const scenarios: Scenario[] = z.array(ScenarioSchema).parse(JSON.parse(fs.readFileSync(file, "utf8")));

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}
