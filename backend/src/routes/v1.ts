import { Router, type Response } from "express";
import { z } from "zod";
import { buildToolCall, blockedMessage, handleToolCall, recordToolResult, type GatewayContext } from "../gateway/gateway.js";
import type { SentinelBus } from "../integrations/bus.js";
import { maskDeep } from "../integrations/masking.js";
import { getPolicy } from "../policy/loader.js";
import { createSession, findDecision, gatewayContext, getRun, summarize, type RunRecord } from "../runs.js";
import type { Decision } from "../types.js";

/**
 * Gateway API for external agents (any language, any framework).
 *
 *   POST /api/v1/sessions                          open a session for one agent task
 *   POST /api/v1/sessions/:id/context              record what the user asked / what the agent read
 *   POST /api/v1/sessions/:id/tool-calls           ask before running a tool -> allow / deny / pending
 *   GET  /api/v1/decisions/:id                     poll a pending approval
 *   POST /api/v1/sessions/:id/tool-calls/:decision_id/result   report the tool's output (feeds taint tracking)
 *   POST /api/v1/sessions/:id/end                  close the session
 *
 * Tools run on the agent's side; Sentinel only authorises them. Every step is audited.
 */

const SessionBody = z.object({
  profile: z.string().min(1),
  title: z.string().max(120).optional(),
  user_prompt: z.string().max(100_000).optional(),
  shield: z.boolean().optional(),
});

const ContextBody = z.object({
  source: z.enum(["user", "untrusted", "internal", "system"]),
  text: z.string().max(500_000),
  label: z.string().max(300).optional(),
  tool: z.string().max(100).optional(),
  records: z.array(z.record(z.string(), z.unknown())).max(5000).optional(),
});

const ToolCallBody = z.object({
  tool: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()),
  call_id: z.string().max(200).optional(),
  /** true (default): hold the request until a human answers a REQUIRE_APPROVAL. false: return 202 and poll. */
  wait: z.boolean().default(true),
});

const ResultBody = z.object({
  text: z.string().max(500_000),
  records: z.array(z.record(z.string(), z.unknown())).max(5000).optional(),
  label: z.string().max(300).optional(),
});

type Status = "allowed" | "denied" | "pending" | "rejected" | "timed_out";

function statusOf(d: Decision): Status {
  if (d.outcome === "EXECUTED" || d.outcome === "APPROVED_EXECUTED" || d.outcome === "UNPROTECTED_EXECUTED") return "allowed";
  if (d.outcome === "REJECTED") return "rejected";
  if (d.outcome === "TIMED_OUT") return "timed_out";
  if (d.outcome === "BLOCKED") return "denied";
  return d.verdict === "DENY" ? "denied" : "pending";
}

export function publicDecision(d: Decision) {
  const status = statusOf(d);
  return maskDeep({
    decision_id: d.decision_id,
    status,
    /** Run the tool only when this is true. */
    authorized: status === "allowed",
    verdict: d.verdict,
    rule_id: d.rule_id,
    outcome: d.outcome ?? null,
    impact: d.impact,
    reasons: d.reasons.map((r) => ({ code: r.code, message: r.message })),
    message: status === "allowed" || status === "pending" ? null : blockedMessage(d),
    session_tainted: d.session_tainted,
    latency_ms: d.latency_ms,
    policy_version: d.policy_version ?? null,
  });
}

export interface V1Options {
  bus: SentinelBus;
  demoFeatures: boolean;
}

export function v1Routes(opts: V1Options): Router {
  const router = Router();
  /** decision_id -> result already reported (each authorisation runs once). */
  const reported = new Set<string>();

  function ownSession(req: { params: { id?: string } }, res: Response): RunRecord | undefined {
    const run = req.params.id ? getRun(req.params.id) : undefined;
    if (!run || run.mode !== "sdk") return void res.status(404).json({ error: "unknown session" });
    if (run.agent !== res.locals.agent && res.locals.agent !== "anonymous" && !isOperator(res)) {
      return void res.status(403).json({ error: "this session belongs to another agent key" });
    }
    if (run.status !== "running") return void res.status(409).json({ error: "session has ended" });
    run.last_activity = Date.now();
    return run;
  }

  const contexts = new WeakMap<RunRecord, GatewayContext>();
  const ctxFor = (run: RunRecord) => {
    let ctx = contexts.get(run);
    if (!ctx) {
      ctx = gatewayContext(run, { bus: opts.bus, deferExecution: true });
      contexts.set(run, ctx);
    }
    return ctx;
  };

  router.post("/api/v1/sessions", async (req, res) => {
    const body = SessionBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
    const policy = getPolicy();
    if (!policy.profiles[body.data.profile]) return void res.status(400).json({ error: `unknown profile ${body.data.profile}` });
    if (body.data.shield === false && !opts.demoFeatures) return void res.status(403).json({ error: "shield cannot be disabled on this deployment" });

    const run = createSession({ profile: body.data.profile, title: body.data.title, agent: String(res.locals.agent ?? "anonymous"), shield: body.data.shield }, opts.bus);
    await opts.bus.publishSafe({ type: "run.started", run_id: run.run_id, scenario_id: "sdk", shield: run.shield, mode: "sdk", title: run.scenario.title, profile: run.scenario.profile });
    if (body.data.user_prompt) run.ledger.addUser(body.data.user_prompt);
    res.status(201).json({ session_id: run.run_id, profile: run.scenario.profile, shield: run.shield, policy_version: policy.policy_version });
  });

  router.get("/api/v1/sessions/:id", (req, res) => {
    const run = getRun(req.params.id);
    if (!run || run.mode !== "sdk") return void res.status(404).json({ error: "unknown session" });
    res.json(
      maskDeep({
        session_id: run.run_id,
        profile: run.scenario.profile,
        title: run.scenario.title,
        status: run.status,
        tainted: run.ledger.isTainted(),
        decisions: run.decisions.map(publicDecision),
      }),
    );
  });

  router.post("/api/v1/sessions/:id/context", (req, res) => {
    const run = ownSession(req, res);
    if (!run) return;
    const body = ContextBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
    const { source, text, label, tool, records } = body.data;
    const seg =
      source === "user"
        ? run.ledger.addUser(text)
        : source === "system"
          ? run.ledger.addSystem(text)
          : run.ledger.addToolResult(tool ?? "external", source === "untrusted" ? "UNTRUSTED" : "INTERNAL_DATA", text, { label, records });
    res.status(201).json({ segment_id: seg.segment_id, tainted: run.ledger.isTainted() });
  });

  router.post("/api/v1/sessions/:id/tool-calls", async (req, res, next) => {
    try {
      const run = ownSession(req, res);
      if (!run) return;
      const body = ToolCallBody.safeParse(req.body);
      if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });

      const base = ctxFor(run);
      let onDecided!: (d: Decision) => void;
      const decided = new Promise<Decision>((r) => (onDecided = r));
      const ctx: GatewayContext = {
        ...base,
        onDecision: (d, size) => {
          base.onDecision?.(d, size);
          onDecided(d);
        },
      };
      const call = buildToolCall(ctx, body.data.tool, body.data.args, body.data.call_id);
      const done = handleToolCall(call, ctx);
      done.catch((err) => console.error(`[sentinel] v1 tool-call ${call.call_id} failed:`, err));

      const first = await Promise.race([decided, done.then((r) => r.decision)]);
      if (first.verdict === "REQUIRE_APPROVAL" && !body.data.wait) {
        return void res.status(202).json(publicDecision(first));
      }
      const final = await done;
      res.json(publicDecision(final.decision));
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/v1/decisions/:id", (req, res) => {
    const found = findDecision(req.params.id);
    if (!found || found.run.mode !== "sdk") return void res.status(404).json({ error: "unknown decision" });
    if (found.run.agent !== res.locals.agent && res.locals.agent !== "anonymous" && !isOperator(res)) {
      return void res.status(403).json({ error: "this decision belongs to another agent key" });
    }
    res.json(publicDecision(found.decision));
  });

  router.post("/api/v1/sessions/:id/tool-calls/:decision_id/result", async (req, res) => {
    const run = ownSession(req, res);
    if (!run) return;
    const body = ResultBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
    const decision = run.decisions.find((d) => d.decision_id === req.params.decision_id);
    if (!decision) return void res.status(404).json({ error: "unknown decision for this session" });
    if (statusOf(decision) !== "allowed") return void res.status(409).json({ error: "this call was not authorised, so it has no result to record" });
    if (reported.has(decision.decision_id)) return void res.status(409).json({ error: "result already recorded" });
    reported.add(decision.decision_id);

    const ctx = ctxFor(run);
    recordToolResult(ctx, decision.call, { text: body.data.text, records: body.data.records, label: body.data.label });
    run.executed.push({ decision_id: decision.decision_id, tool: decision.call.tool, text: body.data.text });
    const preview = body.data.text.length > 300 ? `${body.data.text.slice(0, 300)}…` : body.data.text;
    await opts.bus.publishSafe({ type: "tool.executed", run_id: run.run_id, decision_id: decision.decision_id, result_preview: preview });
    res.status(201).json({ ok: true, tainted: run.ledger.isTainted() });
  });

  router.post("/api/v1/sessions/:id/end", async (req, res) => {
    const run = ownSession(req, res);
    if (!run) return;
    run.status = "finished";
    const summary = summarize(run);
    await opts.bus.publishSafe({ type: "run.finished", run_id: run.run_id, summary });
    res.json(maskDeep({ ok: true, decisions: summary.decisions.length }));
  });

  return router;
}

function isOperator(res: Response): boolean {
  return typeof res.locals.agent === "string" && res.locals.isOperatorToken === true;
}
