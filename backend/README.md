# Sentinel — core engine (Person A)

A policy-enforcement gateway between an AI agent and its tools. Every tool call is intercepted,
the provenance of its high-impact arguments is traced back to either the user's request or
untrusted content the agent read, and a deterministic policy engine returns
**ALLOW / DENY / REQUIRE_APPROVAL** with plain-English reasons and evidence spans.

All data is synthetic. No real emails or payments are ever sent; all domains use `.test`.

## Run

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY for live mode
npm install
npm test                  # provenance, every policy rule, 5 scenarios x shield ON/OFF, agent API, fail-closed
npm run dev               # API on http://localhost:4000
```

Before/after demo (scripted mode, fully deterministic):

```bash
curl -XPOST localhost:4000/api/runs -H 'content-type: application/json' \
  -d '{"scenario_id":"S2_injection","shield":false,"mode":"scripted"}'
curl localhost:4000/api/outbox     # PANs addressed to attacker@evil.test
curl -XPOST localhost:4000/api/reset
curl -XPOST localhost:4000/api/runs -H 'content-type: application/json' \
  -d '{"scenario_id":"S2_injection","shield":true,"mode":"scripted"}'
curl localhost:4000/api/outbox     # []
```

Use `"mode":"live"` to run the same scenario against Claude (needs `ANTHROPIC_API_KEY`).
Live mode uses a deliberately misconfigured system prompt (`src/agent/prompts.ts`) so the
shield-OFF run shows the attack; the gateway's guarantees do not depend on the model or prompt,
because it judges tool calls, not text.

## How a decision is made

`src/gateway/policyEngine.ts` is a pure, synchronous function. Rules run in order; the first
DENY wins; REQUIRE_APPROVAL reasons accumulate; ALLOW only if nothing fired.

| Rule | Check | Verdict |
|---|---|---|
| R0 | Exception inside the engine | DENY |
| R1 | Tool not in profile / not in policy | DENY |
| R2 | Args fail schema | DENY |
| R3 | `query_db` field not allowed for profile | DENY |
| R4 | High-impact arg found only in untrusted content | DENY (+ evidence) |
| R5 | Sensitive data leaving to an untrusted destination | DENY (+ evidence) |
| R6 | Tainted session and guard flags injection | REQUIRE_APPROVAL |
| R7 | Guard unavailable on a high-impact call | REQUIRE_APPROVAL |
| R8 | High-impact call | REQUIRE_APPROVAL |
| R9 | High-impact arg of unknown provenance | REQUIRE_APPROVAL |
| R10 | Nothing fired | ALLOW |

Provenance is deterministic string matching after normalisation (emails, UPI ids, amounts
like `₹49,999` = `49999`, URLs). The guard classifier can only escalate; it never turns a DENY
into an ALLOW.

Fail closed: invalid policy => server refuses to start; guard error/timeout => approval
required; approval timeout => `TIMED_OUT` (blocked); engine exception or audit failure => DENY.

## SDK: three-line integration

```ts
import { createSentinel } from "./src/sdk.js";

const sentinel = createSentinel({ policyPath, providers });
const guardedTools = sentinel.wrap({ send_email: realSendEmail, browse_url: realFetch }, { profile: "research_assistant" });
// each guardedTools[name](args) is decided by Sentinel, then runs YOUR function (null = built-in mock tool)
```

Agents in another process or language use the HTTP gateway (`/api/v1`) and the `sdk/` package instead.

Call `guardedTools.recordUser(prompt)` with the user's request so provenance knows what the
user actually asked for.

## Integration points for Person B

- `src/types.ts` — shared contracts (Decision, BusEvent, RunSummary, ...).
- `src/integrations/index.ts` — swap `providers.guard` (Groq), `providers.approvals`
  (Telegram; call `httpApprovals.resolve(decision_id, approve, approver)` or POST
  `/api/approvals/:decision_id`), `providers.audit` (hash-chained Postgres).
- `bus.on("event", fn)` from `src/integrations/bus.ts` receives every `BusEvent`; forward it
  over Socket.io. Note `decision.made` is emitted twice per call: once when decided (before
  execution) and again with `outcome` filled in — key the UI on `decision_id`.

## REST API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/scenarios` | `{ id, title, profile, user_prompt }[]` |
| POST | `/api/runs` | `{ scenario_id, shield, mode }` -> `{ run_id }` (async) |
| GET | `/api/runs/:run_id` | `RunSummary` (+ `status`, `error`) |
| GET | `/api/decisions?run_id=` | `Decision[]` |
| POST | `/api/approvals/:decision_id` | `{ approve, approver? }` |
| GET | `/api/pending-approvals` | `Decision[]` |
| GET | `/api/outbox` / `/api/ledger` | the "damage" views |
| POST | `/api/reset` | clear outbox, ledger, runs, pending approvals |
| POST | `/api/replay/:decision_id` | re-evaluate against the current policy (no execution) |
