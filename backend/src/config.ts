import "dotenv/config";
import path from "node:path";

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  port: Number(process.env.PORT ?? 4000),
  policyPath: path.resolve(process.env.POLICY_PATH ?? "./src/policy/policy.yaml"),
  approvalTimeoutSeconds: Number(process.env.APPROVAL_TIMEOUT_SECONDS ?? 60),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  auditPath: process.env.AUDIT_PATH ?? "./audit.jsonl",
};
