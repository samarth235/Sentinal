import "dotenv/config";
import path from "node:path";

const list = (v: string | undefined, fallback: string) =>
  (v ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  port: Number(process.env.PORT ?? 4000),
  policyPath: path.resolve(process.env.POLICY_PATH ?? "./src/policy/policy.yaml"),
  // Optional override; otherwise policy.yaml defaults.approval_timeout_seconds applies (see approvalTimeoutSeconds()).
  approvalTimeoutOverride: process.env.APPROVAL_TIMEOUT_SECONDS ? Number(process.env.APPROVAL_TIMEOUT_SECONDS) : null,
  auditPath: process.env.AUDIT_PATH ?? "./audit.jsonl",

  // Person B integrations — each one falls back to a stub when unset.
  databaseUrl: process.env.DATABASE_URL ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqModel: process.env.GROQ_MODEL ?? "",
  guardTimeoutMs: Number(process.env.GUARD_TIMEOUT_MS ?? 3000),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramAllowedChatId: process.env.TELEGRAM_ALLOWED_CHAT_ID ?? "",
  telegramAllowedUserIds: list(process.env.TELEGRAM_ALLOWED_USER_IDS, ""),
  frontendOrigins: list(process.env.FRONTEND_ORIGIN, "http://localhost:5173"),
  enableTamperDemo: process.env.ENABLE_TAMPER_DEMO === "true",
  // Shared secret for every state-changing route. Required when NODE_ENV=production.
  apiToken: process.env.API_TOKEN ?? "",
  production: process.env.NODE_ENV === "production",
  // "production" turns off every demo affordance (shield off, reset, tamper demo, heuristic-only guard).
  strict: process.env.SENTINEL_MODE === "production",
};
