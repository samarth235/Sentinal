import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

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

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Bearer-token check for POST routes. With no token configured (local demo), everything passes. */
export function requireToken(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token || req.method !== "POST") return next();
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!sameSecret(given, token)) return void res.status(401).json({ error: "missing or invalid API token" });
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
