# Deploying Sentinel

Target setup: **Postgres on Neon**, **backend on Railway**, **dashboard on Vercel**, approvals in **Telegram**, guard on **Groq**.
Allow about 30–40 minutes the first time. Everything below happens in your own accounts.

## 0. Generate secrets

Run this three times and keep the outputs somewhere safe (a password manager):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

- **Operator token(s)** — people who use the dashboard. Named form records who approved: `sanjeev:<secret1>,samarth:<secret2>`
- **Agent key** — for the SDK / external agents: `demo-agent:<secret3>`
- **Telegram webhook secret** (only if you use webhook mode, step 6)

## 1. Database — Neon

1. Create a project at neon.tech (region close to your Railway region).
2. Copy the connection string (it ends in `?sslmode=require`). That is `DATABASE_URL`.
3. Nothing else: Sentinel creates the `audit_log` table on first use.

## 2. Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` → copy the token (`TELEGRAM_BOT_TOKEN`).
2. Create a group for approvers (or use a private chat with the bot) and add the bot.
3. Send any message in that chat, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `chat.id` (`TELEGRAM_ALLOWED_CHAT_ID`, negative for groups) and each person's `from.id` (`TELEGRAM_ALLOWED_USER_IDS`, comma-separated).

## 3. Groq guard

Create an API key at console.groq.com (`GROQ_API_KEY`) and pick a current fast instruction model from its model list (`GROQ_MODEL`).
Without Groq the backend falls back to a regex guard in demo mode. `SENTINEL_MODE=production` refuses to start without Groq.

## 4. Backend — Railway

1. railway.com → **New Project → Deploy from GitHub repo** → pick this repository.
2. Service **Settings → Root Directory**: `backend`. Railway finds `backend/Dockerfile` and `backend/railway.json` (health check on `/api/ready`).
3. **Variables** (paste as raw editor):

   ```
   NODE_ENV=production
   API_TOKEN=sanjeev:<secret1>,samarth:<secret2>
   AGENT_API_KEYS=demo-agent:<secret3>
   DATABASE_URL=<neon connection string>
   GROQ_API_KEY=<groq key>
   GROQ_MODEL=<groq model id>
   TELEGRAM_BOT_TOKEN=<bot token>
   TELEGRAM_ALLOWED_CHAT_ID=<chat id>
   TELEGRAM_ALLOWED_USER_IDS=<your ids>
   FRONTEND_ORIGIN=https://<filled in after step 5>
   # Hackathon/demo deployment (shield OFF compare + tamper button). Default SENTINEL_MODE is demo.
   SENTINEL_MODE=demo
   ENABLE_TAMPER_DEMO=true
   # Optional: live mode with Claude, and real web pages in live mode
   ANTHROPIC_API_KEY=<key>
   ENABLE_REAL_BROWSE=true
   ```

4. **Settings → Networking → Generate Domain**. Open `https://<domain>/api/ready` — expect `{"ok":true,...}`.
   If the deploy fails, the logs start with `[sentinel] refusing to start: ...` and say exactly which variable is wrong.

> The tamper demo edits audit rows on purpose. For a real deployment after the event: `SENTINEL_MODE=production`,
> remove `ENABLE_TAMPER_DEMO`, and run `backend/sql/002_least_privilege.sql` (append-only DB role).

## 5. Dashboard — Vercel

1. vercel.com → **Add New → Project** → import this repository.
2. **Root Directory**: `frontend` (framework preset: Vite; `frontend/vercel.json` sets the rest).
3. Environment variable `VITE_API_URL=https://<railway domain>` (no trailing slash). Deploy.
4. Back on Railway, set `FRONTEND_ORIGIN=https://<your-project>.vercel.app` (comma-separate several origins). Railway redeploys.
5. Open the Vercel URL → sign in with one of your operator tokens.

## 6. (Optional) Telegram webhook mode

Long polling is fine with one backend instance (the default `numReplicas: 1`). To scale out, set
`TELEGRAM_WEBHOOK_URL=https://<railway domain>` and `TELEGRAM_WEBHOOK_SECRET=<secret>`; the bot registers
`/telegram/webhook` itself.

## 7. Smoke test (5 minutes)

1. Dashboard: **S2 → Compare off / on** → left card "Attack succeeded", right card "Attack blocked".
2. **S1 → Run** with shield on → a Telegram message with Approve/Reject arrives → Approve → the email shows in the outbox.
3. Telegram: `/status`, `/verify`, `/trace ai-trends`.
4. Audit panel: **Verify** → intact; **Tamper** → broken; restore before the next rehearsal.
5. An external agent through the SDK:

   ```bash
   cd sdk && npm install
   SENTINEL_URL=https://<railway domain> SENTINEL_AGENT_KEY=<secret3> ANTHROPIC_API_KEY=<key> \
     npx tsx examples/claude-agent.ts "Read https://example.com and email a two-line summary to priya@company.test"
   ```

   The session appears live on the dashboard; the email waits for your approval in Telegram.

## Self-hosting instead (Docker)

```bash
export API_TOKEN=admin:$(openssl rand -hex 24) AGENT_API_KEYS=my-agent:$(openssl rand -hex 24)
docker compose up -d --build     # dashboard :8080, API :4000, Postgres in a volume
```
Pass `SENTINEL_MODE`, `GROQ_*`, `TELEGRAM_*` or `ANTHROPIC_API_KEY` through the environment as needed.

## Operating notes

- **Policy changes**: edit `policy.yaml`, deploy, or `POST /api/policy/reload`. Every decision records the policy hash it was made under; `/replay <id>` shows whether a past call would now be decided differently.
- **Audit integrity**: the chain is verified every 15 minutes; a broken or truncated chain alerts Telegram and the dashboard. The head hash is posted to Telegram hourly as an external anchor.
- **Restarts**: approvals that were waiting are recorded as timed out (blocked). Decisions, replay and forensics read from the audit log, so they survive restarts.
- **Metrics**: `GET /api/metrics` (decision latency p50/p95, verdicts, guard availability). Quote latency from here, not from memory.
