import cors from "cors";
import express from "express";
import { z } from "zod";
import { config } from "./config.js";
import { runLive } from "./agent/agentLoop.js";
import { runScripted } from "./agent/scriptedRun.js";
import { auditChain, bus, httpApprovals, providers } from "./integrations/index.js";
import { attachSocketBridge } from "./integrations/socketBridge.js";
import { startTelegramBot } from "./integrations/telegramBot.js";
import { errorHandler, requireJson, requireToken } from "./http.js";
import { maskDeep } from "./integrations/masking.js";
import { auditRoutes } from "./routes/audit.js";
import { activePolicyHash, approvalTimeoutSeconds, initPolicy, readPolicyFile, PolicyError } from "./policy/loader.js";
import { allDecisions, clearRuns, createRun, getRun, summarize } from "./runs.js";
import { replayDecision } from "./replay.js";
import { getScenario, scenarios } from "./scenarios.js";
import { getLedger, getOutbox, reset } from "./tools/state.js";

// Fail closed: an invalid policy means the server does not start.
try {
  initPolicy(config.policyPath);
} catch (err) {
  console.error(`[sentinel] refusing to start: ${(err as Error).message}`);
  process.exit(1);
}
// Fail closed: a public deployment without an API token would let anyone approve actions.
const startupProblems = [
  (config.production || config.strict) && !config.apiToken && "NODE_ENV=production / SENTINEL_MODE=production requires API_TOKEN",
  config.strict && config.enableTamperDemo && "SENTINEL_MODE=production forbids ENABLE_TAMPER_DEMO=true",
  config.strict && !(config.groqApiKey && config.groqModel) && "SENTINEL_MODE=production requires the Groq guard (GROQ_API_KEY + GROQ_MODEL)",
].filter(Boolean);
if (startupProblems.length) {
  for (const p of startupProblems) console.error(`[sentinel] refusing to start: ${p}`);
  process.exit(1);
}
if (!config.apiToken) console.warn("[sentinel] API_TOKEN not set — state-changing routes are open (local demo only)");

export const app = express();
let bridge: ReturnType<typeof attachSocketBridge> | undefined;
app.use(cors({ origin: config.frontendOrigins, exposedHeaders: ["X-Policy-Hash", "X-Original-Policy-Hash"] }));
app.use("/api", requireJson, requireToken(config.apiToken));
app.use(express.json({ limit: "1mb" }));

const RunBody = z.object({ scenario_id: z.string(), shield: z.boolean(), mode: z.enum(["live", "scripted"]).default("scripted") });
const ApprovalBody = z.object({ approve: z.boolean(), approver: z.string().optional() });

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/scenarios", (_req, res) => {
  res.json(scenarios.map(({ id, title, profile, user_prompt }) => ({ id, title, profile, user_prompt })));
});

app.post("/api/runs", (req, res) => {
  const body = RunBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
  if (config.strict && !body.data.shield) return void res.status(403).json({ error: "shield cannot be turned off in production mode" });
  const scenario = getScenario(body.data.scenario_id);
  if (!scenario) return void res.status(404).json({ error: `unknown scenario ${body.data.scenario_id}` });

  const run = createRun(scenario, body.data.shield, body.data.mode);
  const exec = body.data.mode === "live" ? runLive(run) : runScripted(run);
  exec.catch((err) => console.error(`[sentinel] run ${run.run_id} crashed:`, err));
  res.status(202).json({ run_id: run.run_id });
});

app.get("/api/runs/:run_id", (req, res) => {
  const run = getRun(req.params.run_id);
  if (!run) return void res.status(404).json({ error: "unknown run" });
  // TODO(person-b): status/error are extras beyond RunSummary, handy for the dashboard.
  res.json(maskDeep({ ...summarize(run), status: run.status, error: run.error, policy_hash: run.policy_hash }));
});

app.get("/api/decisions", (req, res) => {
  const runId = typeof req.query.run_id === "string" ? req.query.run_id : undefined;
  res.json(maskDeep(allDecisions(runId)));
});

app.post("/api/approvals/:decision_id", (req, res) => {
  const body = ApprovalBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
  // The server names the channel; a client cannot pass itself off as e.g. "telegram:priya".
  const name = body.data.approver?.replace(/[^\w.@-]/g, "").slice(0, 40);
  const ok = httpApprovals.resolve(req.params.decision_id, body.data.approve, name ? `dashboard:${name}` : "dashboard");
  if (!ok) return void res.status(404).json({ error: "no pending approval with that id" });
  res.json({ ok: true });
});

app.get("/api/pending-approvals", (_req, res) => {
  res.json(maskDeep(httpApprovals.list()));
});

app.get("/api/outbox", (_req, res) => {
  res.json(maskDeep(getOutbox()));
});

app.get("/api/ledger", (_req, res) => {
  res.json(maskDeep(getLedger()));
});

app.post("/api/reset", (_req, res) => {
  if (config.strict) return void res.status(403).json({ error: "reset is disabled in production mode" });
  httpApprovals.rejectAll();
  reset();
  clearRuns();
  bridge?.clear();
  res.json({ ok: true });
});

/** Re-evaluate a stored call against the CURRENT policy file. No execution; the live policy is untouched. */
app.post("/api/replay/:decision_id", async (req, res, next) => {
  try {
    const result = await replayDecision(req.params.decision_id);
    if (!result) return void res.status(404).json({ error: "unknown decision" });
    res.set("X-Policy-Hash", result.policy_hash).set("X-Original-Policy-Hash", result.original_policy_hash);
    res.json(maskDeep(result.decision));
  } catch (err) {
    if (err instanceof PolicyError) return void res.status(422).json({ error: err.message });
    next(err);
  }
});

/** Which policy live runs enforce, and whether the file on disk has changed since startup. */
app.get("/api/policy", (_req, res, next) => {
  try {
    const onDisk = readPolicyFile().hash;
    res.json({ active_hash: activePolicyHash(), file_hash: onDisk, changed_since_start: onDisk !== activePolicyHash() });
  } catch (err) {
    if (err instanceof PolicyError) return void res.json({ active_hash: activePolicyHash(), file_hash: null, changed_since_start: true, error: err.message });
    next(err);
  }
});

app.use(
  auditRoutes(() => auditChain, {
    tamperDemo: config.enableTamperDemo,
    approvalTimeoutSeconds: () => approvalTimeoutSeconds(config.approvalTimeoutOverride),
    guardProvider: providers.guard.constructor.name,
    telegram: Boolean(config.telegramBotToken && config.telegramAllowedChatId),
    authRequired: Boolean(config.apiToken),
    mode: config.strict ? "production" : "demo",
  }),
);

app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`[sentinel] gateway API listening on http://localhost:${config.port}`);
});
bridge = attachSocketBridge(server, bus, config.frontendOrigins);

let telegram: ReturnType<typeof startTelegramBot> | undefined;
if (config.telegramBotToken && config.telegramAllowedChatId) {
  telegram = startTelegramBot({
    token: config.telegramBotToken,
    allowedChatId: config.telegramAllowedChatId,
    allowedUserIds: config.telegramAllowedUserIds,
    timeoutSeconds: () => approvalTimeoutSeconds(config.approvalTimeoutOverride),
    bus,
    resolve: (id, approve, approver) => httpApprovals.resolve(id, approve, approver),
    pending: () => httpApprovals.list(),
    recent: () => allDecisions().slice(-5),
    verify: async () => (auditChain ? auditChain.verify() : null),
    replay: replayDecision,
  });
} else {
  console.warn("[sentinel] TELEGRAM_BOT_TOKEN/TELEGRAM_ALLOWED_CHAT_ID not set — approvals via dashboard/API only");
}

/** Graceful shutdown (Docker/Railway send SIGTERM): stop polling, close sockets, finish in-flight requests. */
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[sentinel] ${signal} received, shutting down`);
  httpApprovals.rejectAll();
  void telegram?.stop().catch(() => undefined);
  bridge?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
