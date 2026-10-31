import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import { config, validateConfig, VERSION } from "./config.js";
import { runLive } from "./agent/agentLoop.js";
import { runScripted } from "./agent/scriptedRun.js";
import { decisionsFromAudit, forensics, metricsFor, unresolvedApprovals } from "./history.js";
import { errorHandler, requireAgentKey, requireJson, requireToken } from "./http.js";
import { startAuditMonitor } from "./integrations/auditMonitor.js";
import { approvalTimeoutSeconds, auditChain, bus, httpApprovals, providers } from "./integrations/index.js";
import { maskDeep } from "./integrations/masking.js";
import { attachSocketBridge } from "./integrations/socketBridge.js";
import { startTelegramBot } from "./integrations/telegramBot.js";
import { activeOverrides, activePolicyHash, addOverride, clearOverrides, getPolicy, initPolicy, MAX_OVERRIDE_MINUTES, PolicyError, readPolicyFile, reloadPolicy } from "./policy/loader.js";
import { replayDecision } from "./replay.js";
import { auditRoutes } from "./routes/audit.js";
import { v1Routes } from "./routes/v1.js";
import { allDecisions, clearRuns, createRun, getRun, listRuns, pruneRuns, summarize } from "./runs.js";
import { getScenario, scenarios } from "./scenarios.js";
import { getLedger, getOutbox, reset } from "./tools/state.js";


// ---------------------------------------------------------------------------
// Startup checks — fail closed.
// ---------------------------------------------------------------------------
try {
  initPolicy(config.policyPath);
} catch (err) {
  console.error(`[sentinel] refusing to start: ${(err as Error).message}`);
  process.exit(1);
}
const checks = validateConfig();
for (const w of checks.warnings) console.warn(`[sentinel] ${w}`);
if (checks.errors.length) {
  for (const e of checks.errors) console.error(`[sentinel] refusing to start: ${e}`);
  process.exit(1);
}

export const app = express();
if (config.trustProxy) app.set("trust proxy", /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(cors({ origin: config.frontendOrigins, exposedHeaders: ["X-Policy-Hash", "X-Original-Policy-Hash"] }));
app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitPerMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => req.path === "/health" || req.path === "/ready",
    message: { error: "too many requests" },
  }),
);
app.use("/api", requireJson, requireToken(config.operatorTokens));
app.use("/api/v1", requireAgentKey(config.agentKeys, config.operatorTokens));
app.use(express.json({ limit: "1mb" }));

let bridge: ReturnType<typeof attachSocketBridge> | undefined;
let telegram: ReturnType<typeof startTelegramBot> | undefined;
let monitor: ReturnType<typeof startAuditMonitor> | undefined;

/** SENTINEL_MODE=production: demo-only routes are refused. */
const notInStrictMode: express.RequestHandler = (req, res, next) => {
  if (config.strict) return void res.status(403).json({ error: `${req.path.replace("/api/", "")} is disabled in production mode` });
  next();
};

const RunBody = z.object({
  scenario_id: z.string(),
  shield: z.boolean(),
  mode: z.enum(["live", "scripted"]).default("scripted"),
  /** Live mode only: replace the scenario's request with your own task. */
  user_prompt: z.string().min(1).max(4000).optional(),
});
const ApprovalBody = z.object({ approve: z.boolean(), approver: z.string().optional() });

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: VERSION });
});

/** Readiness: the audit store must be reachable, because no decision may go unaudited. */
app.get("/api/ready", async (_req, res) => {
  const checksOut: Record<string, string> = {};
  let ok = true;
  try {
    await auditChain.ping();
    checksOut.audit = "ok";
  } catch (err) {
    ok = false;
    checksOut.audit = `error: ${(err as Error).message}`;
  }
  checksOut.policy = getPolicy().policy_version ?? "loaded";
  checksOut.telegram = telegram ? (telegram.health.last_error ? `degraded: ${telegram.health.last_error}` : "ok") : "not configured";
  checksOut.guard = providers.guard.constructor.name;
  res.status(ok ? 200 : 503).json({ ok, checks: checksOut });
});

// ---------------------------------------------------------------------------
// Demo runs (scenarios, shield OFF/ON, live Claude)
// ---------------------------------------------------------------------------
app.get("/api/scenarios", (_req, res) => {
  res.json(scenarios.map(({ id, title, profile, user_prompt }) => ({ id, title, profile, user_prompt })));
});

app.post("/api/runs", (req, res) => {
  const body = RunBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
  if (config.strict && !body.data.shield) return void res.status(403).json({ error: "shield cannot be turned off in production mode" });
  const base = getScenario(body.data.scenario_id);
  if (!base) return void res.status(404).json({ error: `unknown scenario ${body.data.scenario_id}` });
  if (body.data.user_prompt && body.data.mode !== "live") return void res.status(400).json({ error: "a custom user_prompt needs live mode" });
  const scenario = body.data.user_prompt ? { ...base, id: `${base.id}:custom`, title: "Custom task", user_prompt: body.data.user_prompt } : base;

  const run = createRun(scenario, body.data.shield, body.data.mode);
  const exec = body.data.mode === "live" ? runLive(run) : runScripted(run);
  exec.catch((err) => console.error(`[sentinel] run ${run.run_id} crashed:`, err));
  res.status(202).json({ run_id: run.run_id });
});

app.get("/api/runs/:run_id", (req, res) => {
  const run = getRun(req.params.run_id);
  if (!run) return void res.status(404).json({ error: "unknown run" });
  res.json(maskDeep({ ...summarize(run), status: run.status, error: run.error, mode: run.mode, title: run.scenario.title, policy_hash: run.policy_hash }));
});

/** Active and recent agent sessions (SDK / REST gateway users). */
app.get("/api/sessions", (_req, res) => {
  res.json(
    maskDeep(
      listRuns()
        .filter((r) => r.mode === "sdk")
        .map((r) => ({
          session_id: r.run_id,
          title: r.scenario.title,
          profile: r.scenario.profile,
          agent: r.agent,
          status: r.status,
          tainted: r.ledger.isTainted(),
          decisions: r.decisions.length,
          last_activity: new Date(r.last_activity).toISOString(),
        })),
    ),
  );
});

/** Decisions: from memory for live runs, from the audit log for anything older (survives restarts). */
app.get("/api/decisions", async (req, res, next) => {
  try {
    const runId = typeof req.query.run_id === "string" ? req.query.run_id : undefined;
    const inMemory = allDecisions(runId);
    if (runId && inMemory.length) return void res.json(maskDeep(inMemory));
    const fromAudit = decisionsFromAudit(await auditChain.list(runId), { runId });
    const seen = new Set(inMemory.map((d) => d.decision_id));
    res.json(maskDeep([...fromAudit.filter((d) => !seen.has(d.decision_id)), ...inMemory]));
  } catch (err) {
    next(err);
  }
});

app.get("/api/history", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 2000);
    res.json(maskDeep(decisionsFromAudit(await auditChain.list(), { limit })));
  } catch (err) {
    next(err);
  }
});

/** "Show me every action influenced by this email / page." */
app.get("/api/forensics", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (q.trim().length < 3) return void res.status(400).json({ error: "q must be at least 3 characters" });
    res.json(maskDeep(forensics(await auditChain.list(), q)));
  } catch (err) {
    next(err);
  }
});

app.get("/api/metrics", async (_req, res, next) => {
  try {
    const decisions = decisionsFromAudit(await auditChain.list());
    res.json({
      ...metricsFor(decisions),
      pending_approvals: httpApprovals.list().length,
      active_sessions: listRuns().filter((r) => r.mode === "sdk" && r.status === "running").length,
      audit: monitor?.state ?? null,
      telegram: telegram?.health ?? null,
      policy_version: getPolicy().policy_version,
      overrides: activeOverrides().length,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/approvals/:decision_id", (req, res) => {
  const body = ApprovalBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
  // The server names the channel and, with named API tokens, the person. A client cannot pose as Telegram.
  const operator = typeof res.locals.operator === "string" && res.locals.operator !== "operator" ? res.locals.operator : undefined;
  const typed = body.data.approver?.replace(/[^\w.@-]/g, "").slice(0, 40);
  const name = operator ?? typed;
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

app.post("/api/reset", notInStrictMode, (_req, res) => {
  httpApprovals.rejectAll();
  reset();
  clearRuns();
  bridge?.clear();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------
/** Which policy live runs enforce, whether the file on disk has changed since it was loaded, and active overrides. */
app.get("/api/policy", (_req, res, next) => {
  try {
    let fileHash: string | null = null;
    let fileError: string | undefined;
    try {
      fileHash = readPolicyFile().hash;
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      fileError = err.message;
    }
    res.json({
      active_hash: activePolicyHash(),
      file_hash: fileHash,
      changed_since_start: fileHash !== activePolicyHash(),
      ...(fileError ? { error: fileError } : {}),
      policy: getPolicy(),
      overrides: activeOverrides(),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/policy/reload", async (_req, res) => {
  try {
    const p = reloadPolicy();
    await bus.publishSafe({ type: "system.notice", run_id: "system", level: "info", text: `Policy reloaded (version ${p.policy_version}) by ${res.locals.operator ?? "operator"}` });
    res.json({ ok: true, policy_version: p.policy_version });
  } catch (err) {
    res.status(err instanceof PolicyError ? 422 : 500).json({ error: (err as Error).message, kept: getPolicy().policy_version });
  }
});

/** Re-evaluate a stored call against the CURRENT policy file. No execution; the live policy is untouched. */
app.post("/api/replay/:decision_id", async (req, res, next) => {
  try {
    const result = await replayDecision(req.params.decision_id);
    if (!result) return void res.status(404).json({ error: "unknown decision" });
    res.set("X-Policy-Hash", result.policy_hash).set("X-Original-Policy-Hash", result.original_policy_hash);
    res.json(maskDeep({ ...result.decision, reconstructed: result.reconstructed }));
  } catch (err) {
    if (err instanceof PolicyError) return void res.status(422).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Gateway API for external agents, audit routes
// ---------------------------------------------------------------------------
app.use(v1Routes({ bus, demoFeatures: !config.strict }));

app.use(
  auditRoutes(() => auditChain, {
    tamperDemo: config.enableTamperDemo,
    extra: () => ({
      version: VERSION,
      approval_timeout_seconds: approvalTimeoutSeconds(),
      guard_provider: providers.guard.constructor.name,
      telegram: Boolean(telegram),
      telegram_mode: telegram?.health.mode ?? null,
      telegram_error: telegram?.health.last_error ?? null,
      auth_required: config.operatorTokens.length > 0,
      mode: config.strict ? "production" : "demo",
      live_mode: Boolean(config.anthropicApiKey),
      real_browse: config.enableRealBrowse,
      policy_version: getPolicy().policy_version,
    }),
  }),
);

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
if (config.telegramBotToken && config.telegramAllowedChatId) {
  telegram = startTelegramBot({
    token: config.telegramBotToken,
    allowedChatId: config.telegramAllowedChatId,
    allowedUserIds: config.telegramAllowedUserIds,
    timeoutSeconds: approvalTimeoutSeconds,
    bus,
    resolve: (id, approve, approver) => httpApprovals.resolve(id, approve, approver),
    pending: () => httpApprovals.list(),
    recent: () => allDecisions().slice(-5),
    verify: () => auditChain.verify(),
    replay: replayDecision,
    notifyDeny: config.telegramNotifyDeny,
    webhookUrl: config.telegramWebhookUrl || undefined,
    webhookSecret: config.telegramWebhookSecret || undefined,
    statusExtra: async () => {
      const m = metricsFor(decisionsFromAudit(await auditChain.list()));
      return [
        `Policy: ${getPolicy().policy_version}   Mode: ${config.strict ? "production" : "demo"}   Guard: ${providers.guard.constructor.name}`,
        `Decisions: ${m.decisions} (${Object.entries(m.by_verdict).map(([k, n]) => `${k} ${n}`).join(", ") || "none"})   p50/p95: ${m.latency_ms.p50 ?? "-"}/${m.latency_ms.p95 ?? "-"} ms`,
        `Overrides active: ${activeOverrides().length}`,
      ];
    },
    trace: async (q) => {
      const hits = forensics(await auditChain.list(), q, 10);
      if (!hits.length) return `No untrusted content matching "${q}".`;
      return maskDeep(
        hits
          .map((h) => `📄 ${h.source.label ?? h.source.tool ?? "untrusted"} (run ${h.source.run_id})\n${h.decisions.map((d) => `  • ${d.verdict} ${d.tool} → ${d.outcome ?? "pending"} (${d.decision_id})`).join("\n") || "  (no actions after it)"}`)
          .join("\n"),
      );
    },
    overrides: !config.telegramOverride ? undefined : {
      grant: async (profile, tool, minutes, by) => {
        if (minutes <= 0 || minutes > MAX_OVERRIDE_MINUTES) throw new Error(`minutes must be between 1 and ${MAX_OVERRIDE_MINUTES}`);
        const o = addOverride({ profile, tool, expires_at: Date.now() + minutes * 60_000, granted_by: by });
        await bus.publishSafe({ type: "policy.override", run_id: "system", action: "granted", profile, tool, expires_at: new Date(o.expires_at).toISOString(), by });
        return `✅ ${profile} may use ${tool} for ${minutes} min (until ${new Date(o.expires_at).toISOString()}). Provenance, egress and approval rules still apply.`;
      },
      list: () => {
        const list = activeOverrides();
        return list.length ? list.map((o) => `• ${o.profile} → ${o.tool} until ${new Date(o.expires_at).toISOString()} (by ${o.granted_by})`).join("\n") : "No active overrides.";
      },
      clear: async (by) => {
        const n = clearOverrides();
        await bus.publishSafe({ type: "policy.override", run_id: "system", action: "cleared", by });
        return `Cleared ${n} override(s).`;
      },
    },
  });
  if (telegram.webhook) app.post("/telegram/webhook", telegram.webhook);
} else {
  console.warn("[sentinel] TELEGRAM_BOT_TOKEN/TELEGRAM_ALLOWED_CHAT_ID not set — approvals via dashboard/API only");
}

app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(config.port, () => {
  console.log(`[sentinel] gateway API listening on http://localhost:${config.port} (${config.production ? "production" : "development"})`);
});
bridge = attachSocketBridge(server, bus, config.frontendOrigins, config.operatorTokens);

monitor = startAuditMonitor({
  chain: auditChain,
  verifyEveryMinutes: config.auditVerifyIntervalMinutes,
  anchorEveryMinutes: telegram ? config.auditAnchorIntervalMinutes : 0,
  notify: async (text, kind) => {
    if (kind === "alert") {
      console.error(`[sentinel] ${text}`);
      await bus.publishSafe({ type: "system.notice", run_id: "system", level: "error", text });
    }
    if (telegram) await telegram.notify(text);
  },
});

// Approvals that were waiting when the previous process stopped can never be answered now:
// record them as timed out (blocked), so the audit log has no dangling requests.
void (async () => {
  try {
    const open = unresolvedApprovals(await auditChain.list()).filter((o) => !httpApprovals.list().some((d) => d.decision_id === o.decision_id));
    for (const o of open) {
      await bus.publishSafe({ type: "approval.resolved", run_id: o.run_id, decision_id: o.decision_id, result: "timeout", approver: "system-restart" });
    }
    if (open.length) console.warn(`[sentinel] marked ${open.length} approval(s) left over from a previous process as timed out`);
  } catch (err) {
    console.error("[sentinel] could not check for dangling approvals:", (err as Error).message);
  }
})();

// Expired overrides are audited; idle runs are pruned from memory (the audit log keeps them).
let lastOverrides = new Set<string>();
const housekeeping = setInterval(() => {
  const now = new Set(activeOverrides().map((o) => `${o.id}|${o.profile}|${o.tool}`));
  for (const key of lastOverrides) {
    if (!now.has(key)) {
      const [, profile, tool] = key.split("|");
      void bus.publishSafe({ type: "policy.override", run_id: "system", action: "expired", profile, tool, by: "system" });
    }
  }
  lastOverrides = now;
  pruneRuns(6 * 60 * 60_000);
}, 30_000);
housekeeping.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sentinel] ${signal}: shutting down`);
  const expired = httpApprovals.expireAll(); // fail closed: nobody can answer them after we exit
  if (expired) console.log(`[sentinel] timed out ${expired} pending approval(s)`);
  clearInterval(housekeeping);
  monitor?.stop();
  await new Promise((r) => setTimeout(r, 500)); // let the audit writes for those timeouts land
  await telegram?.stop();
  bridge?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
