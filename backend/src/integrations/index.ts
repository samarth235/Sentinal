import { config } from "../config.js";
import { HttpApprovalProvider, type ApprovalProvider } from "./approvals.js";
import type { AuditSink } from "./audit.js";
import { bus } from "./bus.js";
import { HeuristicGuard, type GuardProvider } from "./guard.js";
import { GroqGuard } from "./groqGuard.js";
import { HashChainAuditSink, MemoryChainStore } from "./hashChain.js";
import { createPostgresAudit } from "./postgresAudit.js";
import { approvalTimeoutSeconds as policyTimeout } from "../policy/loader.js";

export interface Providers {
  guard: GuardProvider;
  approvals: ApprovalProvider;
  audit: AuditSink;
}

/** APPROVAL_TIMEOUT_SECONDS if set, otherwise the policy's defaults.approval_timeout_seconds. */
export function approvalTimeoutSeconds(): number {
  try {
    return policyTimeout(config.approvalTimeoutOverride);
  } catch {
    return config.approvalTimeoutOverride ?? 60;
  }
}

/** The HTTP approval queue backs POST /api/approvals, the dashboard and the Telegram bot. */
export const httpApprovals = new HttpApprovalProvider(approvalTimeoutSeconds);

function chooseGuard(): GuardProvider {
  if (config.groqApiKey && config.groqModel) {
    return new GroqGuard({ apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.guardTimeoutMs });
  }
  if (!process.env.VITEST) console.warn("[sentinel] GROQ_API_KEY/GROQ_MODEL not set — using heuristic regex guard");
  return new HeuristicGuard();
}

function chooseAudit(): HashChainAuditSink {
  if (config.databaseUrl) return createPostgresAudit(config.databaseUrl);
  if (!process.env.VITEST) console.warn("[sentinel] DATABASE_URL not set — audit chain kept in memory and mirrored to audit.jsonl");
  return new HashChainAuditSink(new MemoryChainStore(process.env.VITEST ? null : config.auditPath));
}

/** Hash-chained audit log (Postgres when configured, in-memory otherwise). Backs /api/audit/*. */
export const auditChain = chooseAudit();

/** Swap implementations here. */
export const providers: Providers = {
  guard: chooseGuard(),
  approvals: httpApprovals,
  audit: auditChain,
};

bus.useAudit(() => providers.audit);

export { bus };
