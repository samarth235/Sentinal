# Sentinel

Sentinel is a policy-enforcement gateway between an AI agent and its tools.It intercepts every tool call, traces each high-impact argument back to either the user's request or untrusted
content the agent read, and decides **ALLOW / DENY / REQUIRE_APPROVAL** with plain-English reasons and evidence spans.

All data is synthetic. Nothing is really emailed or paid; every domain uses `.test`.

```
backend/   gateway, policy engine, agent loop, REST API, integrations (Node + TypeScript)
frontend/  live dashboard (React + Vite + Tailwind + React Flow)
docs/      demo script, slides outline, claims to verify
```

## Run locally (no external services needed)

```bash
cd backend && cp .env.example .env && npm install && npm run dev     # http://localhost:4000
cd frontend && cp .env.example .env && npm install && npm run dev    # http://localhost:5173
```

With no keys set, the backend uses the heuristic guard, an in-memory hash-chained audit log (mirrored to
`audit.jsonl`) and dashboard-only approvals, so the full demo still works.

Tests: `cd backend && npm test`. Set `TEST_DATABASE_URL` to also run the audit-chain test against a real Postgres.

## Integrations (each one falls back to a stub when unset)

| Env var(s) | Turns on | Fallback |
|---|---|---|
| `ANTHROPIC_API_KEY` | live mode (Claude tool-use loop) | scripted mode only |
| `GROQ_API_KEY` + `GROQ_MODEL` | Groq guard classifier (can only escalate, fails closed) | heuristic regex guard |
| `DATABASE_URL` | hash-chained audit log in Postgres (migrates on first use) | in-memory chain + `audit.jsonl` |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_ID` | Telegram approvals (only that chat may answer) | dashboard Approve/Reject |
| `TELEGRAM_ALLOWED_USER_IDS` | restrict approvers to these Telegram user ids (use when the chat is a group) | any member of the allowed chat |
| `API_TOKEN` | bearer token required on every `POST /api/*` (runs, approvals, reset, replay, tamper) | open (local demo only; the server refuses to start with `NODE_ENV=production` and no token) |
| `ENABLE_TAMPER_DEMO=true` | `POST /api/audit/tamper-demo` | disabled (never enable in production) |
| `FRONTEND_ORIGIN` | CORS + Socket.io origin | `http://localhost:5173` |

PANs, phone numbers and account numbers are masked (length-preserving) before they reach the audit log,
the socket stream, Telegram or any REST response.

All `POST /api/*` routes require `Content-Type: application/json`, so another website cannot trigger them with a
plain form. Dashboard approvals are recorded as `dashboard` or `dashboard:<name>`; the server sets that prefix, so a
client cannot pose as a Telegram approver. Without `DATABASE_URL`, the chain is reloaded from `audit.jsonl` on start;
a file that fails verification is moved to `audit.jsonl.invalid-<timestamp>` and a new chain begins.

## Added API (on top of `backend/README.md`)

| Method | Path | |
|---|---|---|
| GET | `/api/audit?run_id=` | `{ store, rows }`, chain rows |
| GET | `/api/audit/verify` | `{ valid: true, rows }` or `{ valid: false, broken_at, expected, found }` |
| POST | `/api/audit/tamper-demo` | `{ tampered_seq }` (only with `ENABLE_TAMPER_DEMO=true`) |
| POST | `/api/audit/tamper-demo/restore` | `{ restored: number[] }`, undoes this process's tamper edits (rehearsals) |
| GET | `/api/ui-config` | audit store, tamper flag, approval timeout, guard, telegram, `auth_required` |
| WS | Socket.io | `sentinel:event` per `BusEvent`; `sentinel:snapshot` (last 500) on connect |

## Deploy

- **Backend → Railway:** root `backend/`, start `npm run start`. Set the env vars above, including `NODE_ENV=production`
  and a long random `API_TOKEN` (enter it in the dashboard's "Set token" box). Postgres from Neon/Supabase.
  The Telegram bot uses long polling in the same process.
- **Frontend → Vercel:** root `frontend/`, build `npm run build`, output `dist/`. Set `VITE_API_URL` to the Railway URL,
  and set `FRONTEND_ORIGIN` on the backend to the Vercel URL.
