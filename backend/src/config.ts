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
  /** Optional override; otherwise policy.yaml defaults.approval_timeout_seconds applies (see approvalTimeoutSeconds()). */
  approvalTimeoutOverride: process.env.APPROVAL_TIMEOUT_SECONDS ? Number(process.env.APPROVAL_TIMEOUT_SECONDS) : null,
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
  /**
   * /override (temporary tool permission from chat). Off by default on purpose: a chat command that
   * loosens policy makes the approval channel an attack surface. Opt in only with a user allow-list.
   */
  telegramOverride: bool(process.env.TELEGRAM_ENABLE_OVERRIDE, false),
  frontendOrigins: list(process.env.FRONTEND_ORIGIN, "http://localhost:5173"),

  /** Operator tokens: dashboard + every /api route except health/ready/ui-config. */
  operatorTokens: parseTokens(process.env.API_TOKEN, "operator"),
  /** Agent keys: only the /api/v1 gateway routes. Operator tokens work there too. */
  agentKeys: parseTokens(process.env.AGENT_API_KEYS, "agent"),

  /**
   * SENTINEL_MODE=production is strict: no shield-off runs, no reset, no tamper demo, and the
   * Groq guard is required. The default ("demo") keeps those affordances for demos and testing.
   */
  strict: process.env.SENTINEL_MODE === "production",
  enableTamperDemo: process.env.ENABLE_TAMPER_DEMO === "true",
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
  const deployed = c.production || c.strict;
  if (deployed) {
    if (c.operatorTokens.length === 0) errors.push("NODE_ENV=production / SENTINEL_MODE=production requires API_TOKEN");
    if (c.operatorTokens.some((t) => t.token.length < 24)) errors.push("API_TOKEN values must be at least 24 characters in production");
    if (c.agentKeys.some((t) => t.token.length < 24)) errors.push("AGENT_API_KEYS values must be at least 24 characters in production");
    if (!c.databaseUrl) warnings.push("DATABASE_URL not set: the audit log lives on local disk and is lost when the container is replaced");
  } else if (c.operatorTokens.length === 0) {
    warnings.push("API_TOKEN not set: every route is open (local development only)");
  }
  if (c.strict) {
    if (c.enableTamperDemo) errors.push("SENTINEL_MODE=production forbids ENABLE_TAMPER_DEMO=true");
    if (!(c.groqApiKey && c.groqModel)) errors.push("SENTINEL_MODE=production requires the Groq guard (GROQ_API_KEY + GROQ_MODEL)");
  } else if (c.production) {
    warnings.push("SENTINEL_MODE=demo: shield-off runs and reset are available (set SENTINEL_MODE=production for a real deployment)");
  }
  if (c.telegramWebhookUrl && !c.telegramWebhookSecret) errors.push("TELEGRAM_WEBHOOK_URL requires TELEGRAM_WEBHOOK_SECRET");
  if (c.telegramOverride && c.telegramAllowedUserIds.length === 0) errors.push("TELEGRAM_ENABLE_OVERRIDE needs TELEGRAM_ALLOWED_USER_IDS");
  if (c.telegramOverride && c.strict) errors.push("SENTINEL_MODE=production forbids TELEGRAM_ENABLE_OVERRIDE");
  const all = [...c.operatorTokens, ...c.agentKeys].map((t) => t.token);
  if (new Set(all).size !== all.length) errors.push("API_TOKEN and AGENT_API_KEYS must not reuse the same secret");
  return { errors, warnings };
}
