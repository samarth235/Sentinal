/**
 * A real Claude tool-use agent protected by Sentinel.
 *
 *   SENTINEL_URL=https://your-backend.up.railway.app SENTINEL_AGENT_KEY=... ANTHROPIC_API_KEY=... \
 *     npx tsx examples/claude-agent.ts "Read https://example.com and email a summary to priya@company.test"
 *
 * The tools here are real functions in YOUR process (fetch a page, "send" an email to a log).
 * Sentinel decides; this process executes. Watch the decisions appear live on the dashboard.
 */
import Anthropic from "@anthropic-ai/sdk";
import { SentinelClient } from "../src/index.js";

const prompt = process.argv.slice(2).join(" ") || "Read https://example.com and email a two-line summary to priya@company.test";

const sentinel = new SentinelClient({ baseUrl: process.env.SENTINEL_URL ?? "http://localhost:4000", apiKey: process.env.SENTINEL_AGENT_KEY });
const session = await sentinel.startSession({ profile: "research_assistant", userPrompt: prompt, title: "Claude example agent" });

// Your real tool implementations.
const tools = session.wrap(
  {
    browse_url: async ({ url }: { url: string }) => {
      const res = await fetch(url);
      const html = await res.text();
      return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 20_000);
    },
    send_email: async ({ to, subject, body }: { to: string; subject: string; body: string }) => {
      console.log(`\n📧 (pretend) email to ${to}: ${subject}\n${body}\n`);
      return `Email sent to ${to}`;
    },
  },
  { onDecision: (tool, d) => console.log(`[sentinel] ${tool}: ${d.status} (${d.rule_id}) ${d.message ?? ""}`) },
);

const definitions: Anthropic.Tool[] = [
  { name: "browse_url", description: "Fetch a web page as text.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  {
    name: "send_email",
    description: "Send an email.",
    input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
  },
];

const anthropic = new Anthropic();
const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
for (let i = 0; i < 8; i++) {
  const res = await anthropic.messages.create({ model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", max_tokens: 1500, tools: definitions, messages });
  messages.push({ role: "assistant", content: res.content });
  for (const b of res.content) if (b.type === "text") console.log(b.text);
  const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!uses.length) break;
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const use of uses) {
    const fn = (tools as Record<string, (a: Record<string, unknown>) => Promise<string>>)[use.name];
    const content = fn ? await fn(use.input as Record<string, unknown>) : `Unknown tool ${use.name}`;
    results.push({ type: "tool_result", tool_use_id: use.id, content });
  }
  messages.push({ role: "user", content: results });
}
await session.end();
