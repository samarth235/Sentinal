# Sentinel

Sentinel is a policy-enforcement gateway between AI agents and their tools. It intercepts every tool call, traces each
high-impact argument back to either the user's request or untrusted content the agent read (a web page, an email), and
decides **ALLOW / DENY / REQUIRE_APPROVAL** with plain-English reasons and evidence spans. Approvals go to Telegram or
the dashboard; every event lands in a SHA-256 hash-chained audit log.

```
backend/   gateway, policy engine, REST + agent API, Telegram bot, audit chain (Node + TypeScript)
frontend/  live dashboard (React + Vite + Tailwind + React Flow)
sdk/       @sentinel-gateway/sdk: wrap any agent's tools in three lines (zero dependencies)
docs/      deploy guide, demo script, slides outline, claims to verify
```

The demo data is synthetic: the built-in tools write to a simulated outbox and ledger, and every demo domain uses `.test`.
Real agents bring their own tools through the SDK; Sentinel decides, the agent's process executes.

## Run locally (no external services needed)

```bash
cd backend && cp .env.example .env && npm install && npm run dev     # http://localhost:4000
cd frontend && cp .env.example .env && npm install && npm run dev    # http://localhost:5173
```

With no keys set, the backend uses the heuristic guard, an in-memory hash chain mirrored to `audit.jsonl`, and
dashboard approvals, so the full demo works offline. Tests: `cd backend && npm test` (set `TEST_DATABASE_URL` to also
run the audit chain against a real Postgres).

## Protect your own agent

```ts
import { SentinelClient } from "@sentinel-gateway/sdk";

const sentinel = new SentinelClient({ baseUrl: process.env.SENTINEL_URL!, apiKey: process.env.SENTINEL_AGENT_KEY! });
const session = await sentinel.startSession({ profile: "research_assistant", userPrompt });
const tools = session.wrap({ browse_url: fetchPage, send_email: sendEmail }); // your real functions
```

Any language can use the REST API directly; see [`sdk/README.md`](sdk/README.md). Add tools without code changes by
giving them an entry (impact, `args_schema`, `result_trust`) in `backend/src/policy/policy.yaml`.

## What's in the box

| Area | What it does |
|---|---|
| Policy engine | Deterministic rules R0–R10, first DENY wins, fails closed on any error. Policy hash recorded on every decision. |
| Provenance + taint | Recipient/payee/amount must come from the user, not from content the agent read; evidence points at the hidden sentence. |
| Guard | Groq classifier as a second opinion (can only escalate). Heuristic fallback, refused in production unless allowed. |
| Agent API (`/api/v1`) | Sessions, context, tool-call checks (wait or poll for approval), result reporting, per-agent keys. |
| Human in the loop | Telegram Approve/Reject, DENY alerts, `/status` `/pending` `/verify` `/replay` `/trace` `/override`, retries, webhook mode. |
| Audit | Hash chain in Postgres (advisory-locked) or JSONL; scheduled verification, truncation detection, head anchors posted to Telegram, append-only DB role script. |
| Forensics | "Every action influenced by this page/email" (`/api/forensics`, dashboard **Trace**, Telegram `/trace`). |
| Privacy | PAN, phone, Aadhaar, Luhn-valid cards, account numbers and API keys masked before the log, socket, Telegram or any response. |
| Hardening | Token auth on every route and the socket, named operator tokens, rate limiting, helmet, readiness probe, graceful shutdown (pending approvals time out, audited), dangling approvals closed on restart. |

## Deploy

Step-by-step (Neon + Railway + Vercel + Telegram + Groq): **[docs/DEPLOY.md](docs/DEPLOY.md)**.
Self-hosted: `cp docker.env.example .env && docker compose up -d --build`.

## Configuration

All settings are documented in [`backend/.env.example`](backend/.env.example). Production (`NODE_ENV=production`)
refuses to start without a 24+ character `API_TOKEN`, with the tamper demo on outside a demo deployment, or with the
regex guard unless `ALLOW_HEURISTIC_GUARD=true`. Demo features (scenarios, shield OFF, reset) are off in production
unless `ENABLE_DEMO_FEATURES=true`.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health`, `/api/ready` | liveness; readiness (audit store reachable) |
| GET | `/api/ui-config` | dashboard bootstrap (no secrets) |
| GET | `/api/scenarios` · POST `/api/runs` · GET `/api/runs/:id` | demo scenarios (`user_prompt` for a custom live task) |
| GET | `/api/decisions?run_id=` · `/api/history` | decisions (memory, then the audit log) |
| GET | `/api/sessions` | agent sessions |
| POST | `/api/approvals/:decision_id` | `{ approve }` — approver is the operator token's name |
| GET | `/api/pending-approvals` · `/api/outbox` · `/api/ledger` | |
| POST | `/api/replay/:decision_id` | re-evaluate against the current policy (works after restarts) |
| GET | `/api/forensics?q=` · `/api/metrics` | forensics; latency p50/p95, verdict counts, guard health |
| GET / POST | `/api/policy` · `/api/policy/reload` | current policy + overrides; hot reload (invalid file keeps the old one) |
| GET | `/api/audit` · `/api/audit/verify` · `/api/audit/head` | chain rows, verification, head hash |
| POST | `/api/reset`, `/api/audit/tamper-demo(/restore)` | demo only |
| * | `/api/v1/...` | agent API, see `sdk/README.md` |
| WS | Socket.io (`auth: { token }`) | `sentinel:event` per event; `sentinel:snapshot` (last 500) on connect |
