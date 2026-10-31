import cors from "cors";
import express from "express";
import { z } from "zod";
import { config } from "./config.js";
import { runLive } from "./agent/agentLoop.js";
import { runScripted } from "./agent/scriptedRun.js";
import { evaluate } from "./gateway/policyEngine.js";
import { safeClassify, NOT_CONSULTED } from "./integrations/guard.js";
import { auditChain, bus, httpApprovals, providers } from "./integrations/index.js";
import { attachSocketBridge } from "./integrations/socketBridge.js";
import { startTelegramBot } from "./integrations/telegramBot.js";
import { errorHandler, requireJson, requireToken } from "./http.js";
import { maskDeep } from "./integrations/masking.js";
import { auditRoutes } from "./routes/audit.js";
import { initPolicy, reloadPolicy, PolicyError } from "./policy/loader.js";
import { allDecisions, clearRuns, createRun, findDecision, getRun, summarize } from "./runs.js";
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
if (config.production && !config.apiToken) {
  console.error("[sentinel] refusing to start: NODE_ENV=production requires API_TOKEN");
  process.exit(1);
}
if (!config.apiToken) console.warn("[sentinel] API_TOKEN not set — state-changing routes are open (local demo only)");

export const app = express();
let bridge: ReturnType<typeof attachSocketBridge> | undefined;
app.use(cors({ origin: config.frontendOrigins }));
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
  res.json(maskDeep({ ...summarize(run), status: run.status, error: run.error }));
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
  httpApprovals.rejectAll();
  reset();
  clearRuns();
  bridge?.clear();
  res.json({ ok: true });
});

/** Re-evaluate a stored call against the CURRENT policy file, with the context the agent had at the time. No execution. */
app.post("/api/replay/:decision_id", async (req, res) => {
  const found = findDecision(req.params.decision_id);
  if (!found) return void res.status(404).json({ error: "unknown decision" });
  let policy;
  try {
    policy = reloadPolicy();
  } catch (err) {
    const status = err instanceof PolicyError ? 422 : 500;
    return void res.status(status).json({ error: (err as Error).message });
  }
  const ledger = found.run.ledger.snapshot(found.ledgerSize);
  const t0 = performance.now();
  const guard = ledger.isTainted()
    ? await safeClassify(providers.guard, { call: found.decision.call, untrustedText: ledger.untrustedText() })
    : NOT_CONSULTED;
  const decision = evaluate(found.decision.call, ledger, policy, guard);
  decision.latency_ms = Math.round((performance.now() - t0) * 100) / 100;
  res.json(maskDeep(decision));
});

app.use(
  auditRoutes(() => auditChain, {
    tamperDemo: config.enableTamperDemo,
    approvalTimeoutSeconds: config.approvalTimeoutSeconds,
    guardProvider: providers.guard.constructor.name,
    telegram: Boolean(config.telegramBotToken && config.telegramAllowedChatId),
    authRequired: Boolean(config.apiToken),
  }),
);

app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`[sentinel] gateway API listening on http://localhost:${config.port}`);
});
bridge = attachSocketBridge(server, bus, config.frontendOrigins);

if (config.telegramBotToken && config.telegramAllowedChatId) {
  startTelegramBot({
    token: config.telegramBotToken,
    allowedChatId: config.telegramAllowedChatId,
    allowedUserIds: config.telegramAllowedUserIds,
    timeoutSeconds: config.approvalTimeoutSeconds,
    bus,
    resolve: (id, approve, approver) => httpApprovals.resolve(id, approve, approver),
    pending: () => httpApprovals.list(),
  });
} else {
  console.warn("[sentinel] TELEGRAM_BOT_TOKEN/TELEGRAM_ALLOWED_CHAT_ID not set — approvals via dashboard/API only");
}
