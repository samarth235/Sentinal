# @sentinel-gateway/sdk

Route every tool call your AI agent makes through a [Sentinel](../README.md) gateway. Sentinel checks whether the call's
high-impact arguments came from the user or from untrusted content the agent read (a web page, an email), and returns
**allowed / denied / needs human approval** before anything runs. Your tools still run in your process: Sentinel never
sees your credentials.

Zero dependencies. Node 20+, Bun, Deno or the browser.

## Three lines

```ts
import { SentinelClient } from "@sentinel-gateway/sdk";

const sentinel = new SentinelClient({ baseUrl: process.env.SENTINEL_URL!, apiKey: process.env.SENTINEL_AGENT_KEY! });
const session = await sentinel.startSession({ profile: "research_assistant", userPrompt });
const tools = session.wrap({ browse_url: fetchPage, send_email: sendEmail });

await tools.send_email({ to, subject, body }); // runs sendEmail only if Sentinel authorises it
```

- `profile` must exist in the gateway's `policy.yaml`. Tools must have an entry there (built-in tools, or your own with an `args_schema`).
- A blocked call returns Sentinel's explanation as the tool result (so the model can tell the user). Use `{ onBlocked: "throw" }` to get a `ToolBlockedError` instead.
- A call that needs approval waits until someone presses Approve/Reject in Telegram or the dashboard (or the policy timeout blocks it).
- Tool output is reported back automatically. Tools the policy marks `result_trust: UNTRUSTED` (web, email) taint the session.

## Lower level

```ts
const d = await session.check("send_payment", { payee, amount_inr });   // Decision
if (d.authorized) {
  const out = await pay(payee, amount_inr);
  await session.reportResult(d.decision_id, { text: out });
}
await session.recordUntrusted(pdfText, "invoice.pdf");                   // content read outside wrapped tools
await session.end();
```

## Any language: the REST API

```bash
H='-H content-type:application/json -H "authorization: Bearer $KEY"'
curl -X POST $URL/api/v1/sessions $H -d '{"profile":"research_assistant","user_prompt":"Summarise https://news.example.test/a"}'
curl -X POST $URL/api/v1/sessions/$SID/context $H -d '{"source":"untrusted","text":"<page text>","label":"news.example.test/a"}'
curl -X POST $URL/api/v1/sessions/$SID/tool-calls $H -d '{"tool":"send_email","args":{"to":"x@evil.test","subject":"s","body":"b"},"wait":false}'
# -> {"status":"denied","authorized":false,"rule_id":"R4","message":"BLOCKED_BY_SENTINEL: Recipient x@evil.test was not in your request; ..."}
curl $URL/api/v1/decisions/$DID $H                                          # poll a pending approval
curl -X POST $URL/api/v1/sessions/$SID/tool-calls/$DID/result $H -d '{"text":"<tool output>"}'
curl -X POST $URL/api/v1/sessions/$SID/end $H -d '{}'
```

See `examples/claude-agent.ts` for a complete Claude tool-use loop.
