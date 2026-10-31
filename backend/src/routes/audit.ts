import { Router } from "express";
import type { HashChainAuditSink } from "../integrations/hashChain.js";

/** GET /api/audit, GET /api/audit/verify, POST /api/audit/tamper-demo(/restore), GET /api/ui-config */
export interface UiConfig {
  tamperDemo: boolean;
  approvalTimeoutSeconds: () => number;
  guardProvider: string;
  telegram: boolean;
  authRequired: boolean;
  mode: "demo" | "production";
}

export function auditRoutes(getChain: () => HashChainAuditSink | null, opts: UiConfig): Router {
  const router = Router();

  router.get("/api/audit", async (req, res, next) => {
    try {
      const chain = getChain();
      if (!chain) return void res.status(503).json({ error: "hash-chained audit not configured" });
      const runId = typeof req.query.run_id === "string" ? req.query.run_id : undefined;
      res.json({ store: chain.store.kind, rows: await chain.list(runId) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/audit/verify", async (_req, res, next) => {
    try {
      const chain = getChain();
      if (!chain) return void res.status(503).json({ error: "hash-chained audit not configured" });
      res.json(await chain.verify());
    } catch (err) {
      next(err);
    }
  });

  /** What the dashboard needs to know about this deployment. */
  router.get("/api/ui-config", (_req, res) => {
    res.json({
      audit_store: getChain()?.store.kind ?? null,
      tamper_demo: opts.tamperDemo,
      approval_timeout_seconds: opts.approvalTimeoutSeconds(),
      guard_provider: opts.guardProvider,
      telegram: opts.telegram,
      auth_required: opts.authRequired,
      mode: opts.mode,
    });
  });

  router.post("/api/audit/tamper-demo", async (_req, res, next) => {
    try {
      if (!opts.tamperDemo) return void res.status(403).json({ error: "tamper demo disabled" });
      const chain = getChain();
      if (!chain) return void res.status(503).json({ error: "hash-chained audit not configured" });
      const tampered_seq = await chain.tamper();
      if (tampered_seq === null) return void res.status(409).json({ error: "no decision rows to tamper with yet" });
      res.json({ tampered_seq });
    } catch (err) {
      next(err);
    }
  });

  /** Undo the tamper demo so the next rehearsal starts from an intact chain. */
  router.post("/api/audit/tamper-demo/restore", async (_req, res, next) => {
    try {
      if (!opts.tamperDemo) return void res.status(403).json({ error: "tamper demo disabled" });
      const chain = getChain();
      if (!chain) return void res.status(503).json({ error: "hash-chained audit not configured" });
      res.json({ restored: await chain.restore() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
