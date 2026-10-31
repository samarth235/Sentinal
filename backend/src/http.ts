import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { NamedToken } from "./config.js";

/**
 * State-changing routes only accept JSON. A cross-site <form> cannot send application/json
 * without a CORS preflight, so this blocks drive-by POSTs from other pages.
 */
export function requireJson(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    return void res.status(415).json({ error: "Content-Type must be application/json" });
  }
  next();
}

/** Constant-time comparison (hash first so different lengths do not leak). */
function sameSecret(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

/** Which named token (if any) matches. Checks every entry so timing does not reveal the position. */
export function matchToken(tokens: NamedToken[], given: string): NamedToken | undefined {
  let found: NamedToken | undefined;
  for (const t of tokens) if (given && sameSecret(given, t.token) && !found) found = t;
  return found;
}

export function bearer(req: Request): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

const normalise = (tokens: string | NamedToken[]): NamedToken[] =>
  typeof tokens === "string" ? (tokens ? [{ name: "operator", token: tokens }] : []) : tokens;

/** Paths under /api that need no token (load balancer health checks, dashboard bootstrap). */
export const OPEN_PATHS = new Set(["/health", "/ready", "/ui-config"]);

/**
 * Operator auth for every /api route (reads included: the audit log, decisions and outbox are
 * sensitive). /api/v1/* is skipped here and guarded by agentAuth. With no tokens configured
 * (local development) everything passes. Sets res.locals.operator to the token's name.
 */
export function requireToken(tokens: string | NamedToken[]) {
  const list = normalise(tokens);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS" || OPEN_PATHS.has(req.path) || req.path.startsWith("/v1/")) return next();
    if (list.length === 0) return next();
    const who = matchToken(list, bearer(req));
    if (!who) return void res.status(401).json({ error: "missing or invalid API token" });
    res.locals.operator = who.name;
    next();
  };
}

/** Agent auth for /api/v1: an agent key or an operator token. Open only when neither is configured. */
export function requireAgentKey(agentKeys: NamedToken[], operatorTokens: NamedToken[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (agentKeys.length === 0 && operatorTokens.length === 0) {
      res.locals.agent = "anonymous";
      return next();
    }
    const given = bearer(req);
    const agent = matchToken(agentKeys, given);
    const operator = agent ? undefined : matchToken(operatorTokens, given);
    const who = agent ?? operator;
    if (!who) return void res.status(401).json({ error: "missing or invalid agent API key" });
    res.locals.agent = who.name;
    res.locals.isOperatorToken = Boolean(operator);
    next();
  };
}

/** Map body-parser failures to client errors instead of a generic 500. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const e = err as { status?: number; type?: string; message?: string };
  if (e?.type === "entity.parse.failed") return void res.status(400).json({ error: "malformed JSON body" });
  if (e?.type === "entity.too.large") return void res.status(413).json({ error: "request body too large" });
  if (typeof e?.status === "number" && e.status >= 400 && e.status < 500) {
    return void res.status(e.status).json({ error: e.message ?? "bad request" });
  }
  console.error("[sentinel] request error:", err);
  res.status(500).json({ error: "internal error" });
}
