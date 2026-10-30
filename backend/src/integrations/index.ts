import { config } from "../config.js";
import { HttpApprovalProvider, type ApprovalProvider } from "./approvals.js";
import { JsonlAuditSink, type AuditSink } from "./audit.js";
import { bus } from "./bus.js";
import { HeuristicGuard, type GuardProvider } from "./guard.js";

export interface Providers {
  guard: GuardProvider;
  approvals: ApprovalProvider;
  audit: AuditSink;
}

/** The HTTP approval queue backs POST /api/approvals and GET /api/pending-approvals. */
export const httpApprovals = new HttpApprovalProvider(() => config.approvalTimeoutSeconds);

/** Swap implementations here (Person B: Groq guard, Telegram approvals, Postgres audit). */
export const providers: Providers = {
  guard: new HeuristicGuard(),
  approvals: httpApprovals,
  audit: new JsonlAuditSink(process.env.VITEST ? null : config.auditPath),
};

bus.useAudit(() => providers.audit);

export { bus };
