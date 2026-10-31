import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // src/ under tsx, dist/ when compiled

/** Version from package.json (npm_package_version is unset under `node dist/index.js`). */
export const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, "../package.json"), "utf8")).version ?? "dev";
  } catch {
    return "dev";
  }
})();

const list = (v: string | undefined, fallback: string) =>
  (v ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === "" ? fallback : v === "true" || v === "1");

export interface NamedToken {
  name: string;
  token: string;
}

/**
 * "secret" or "alice:secret,bob:secret2". Named tokens let the dashboard record WHO approved.
 * A bare token is named after `defaultName`.
 */
export function parseTokens(raw: string | undefined, defaultName: string): NamedToken[] {
  return list(raw, "").map((entry, i) => {
    const idx = entry.indexOf(":");
    if (idx > 0) return { name: entry.slice(0, idx).replace(/[^\w.@-]/g, "").slice(0, 40) || `${defaultName}${i + 1}`, token: entry.slice(idx + 1) };
    return { name: defaultName, token: entry };
  });
}

const production = process.env.NODE_ENV === "production";

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  port: Number(process.env.PORT ?? 4000),
  policyPath: process.env.POLICY_PATH ? path.resolve(process.env.POLICY_PATH) : path.join(here, "policy/policy.yaml"),
  /** Unset => the policy's defaults.approval_timeout_seconds is used. */
  approvalTimeoutOverride: process.env.APPROVAL_TIMEOUT_SECONDS ? Number(process.env.APPROVAL_TIMEOUT_SECONDS) : undefined,
  auditPath: process.env.AUDIT_PATH ?? "./audit.jsonl",

  databaseUrl: process.env.DATABASE_URL ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqModel: process.env.GROQ_MODEL ?? "",
  guardTimeoutMs: Number(process.env.GUARD_TIMEOUT_MS ?? 3000),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramAllowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "",
  telegramAllowedUserIds: list(process.env.TELEGRAM_ALLOWED_USER_IDS, ""),
  /** Public base URL of this backend. When set, Telegram uses a webhook instead of long polling. */
  telegramWebhookUrl: (process.env.TELEGRAM_WEBHOOK_URL ?? "").replace(/\/$/, ""),
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
  telegramNotifyDeny: bool(process.env.TELEGRAM_NOTIFY_DENY, true),
  frontendOrigins: list(process.env.FRONTEND_ORIGIN, "http://localhost:5173"),

  /** Operator tokens: dashboard + every /api route except health/ready/ui-config. */
  operatorTokens: parseTokens(process.env.API_TOKEN, "operator"),
  /** Agent keys: only the /api/v1 gateway routes. Operator tokens work there too. */
  agentKeys: parseTokens(process.env.AGENT_API_KEYS, "agent"),

  /**
   * Demo features: scripted scenarios, shield OFF, /api/reset. On by default in development,
   * off in production unless explicitly enabled (e.g. a hackathon demo deployment).
   */
  demoFeatures: bool(process.env.ENABLE_DEMO_FEATURES, !production),
  enableTamperDemo: process.env.ENABLE_TAMPER_DEMO === "true",
  /** Production refuses to fall back to the regex guard unless this is set. */
  allowHeuristicGuard: bool(process.env.ALLOW_HEURISTIC_GUARD, !production),
  enableRealBrowse: process.env.ENABLE_REAL_BROWSE === "true",

  auditVerifyIntervalMinutes: Number(process.env.AUDIT_VERIFY_INTERVAL_MINUTES ?? 15),
  auditAnchorIntervalMinutes: Number(process.env.AUDIT_ANCHOR_INTERVAL_MINUTES ?? 60),
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 300),
  trustProxy: process.env.TRUST_PROXY ?? (production ? "1" : ""),

  production,
};

/** Startup checks. Any error => the server refuses to start (fail closed). */
export function validateConfig(c: typeof config = config): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (c.production) {
    if (c.operatorTokens.length === 0) errors.push("NODE_ENV=production requires API_TOKEN");
    if (c.operatorTokens.some((t) => t.token.length < 24)) errors.push("API_TOKEN values must be at least 24 characters in production");
    if (c.agentKeys.some((t) => t.token.length < 24)) errors.push("AGENT_API_KEYS values must be at least 24 characters in production");
    if (c.enableTamperDemo && !c.demoFeatures) errors.push("ENABLE_TAMPER_DEMO requires ENABLE_DEMO_FEATURES=true (never enable on a real deployment)");
    if (!(c.groqApiKey && c.groqModel) && !c.allowHeuristicGuard) {
      errors.push("production needs GROQ_API_KEY + GROQ_MODEL, or ALLOW_HEURISTIC_GUARD=true to accept the regex fallback");
    }
    if (!c.databaseUrl) warnings.push("DATABASE_URL not set: the audit log lives on local disk and is lost when the container is replaced");
    if (c.demoFeatures) warnings.push("ENABLE_DEMO_FEATURES=true: shield OFF, reset and scenarios are available (demo deployment)");
    if (c.telegramWebhookUrl && !c.telegramWebhookSecret) errors.push("TELEGRAM_WEBHOOK_URL requires TELEGRAM_WEBHOOK_SECRET");
  } else if (c.operatorTokens.length === 0) {
    warnings.push("API_TOKEN not set: every route is open (local development only)");
  }
  const all = [...c.operatorTokens, ...c.agentKeys].map((t) => t.token);
  if (new Set(all).size !== all.length) errors.push("API_TOKEN and AGENT_API_KEYS must not reuse the same secret");
  return { errors, warnings };
}
