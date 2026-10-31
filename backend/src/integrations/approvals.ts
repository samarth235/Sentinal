import type { Decision } from "../types.js";

export type ApprovalResult = { result: "approved" | "rejected" | "timeout"; approver?: string };

export interface ApprovalProvider {
  request(decision: Decision): Promise<ApprovalResult>;
}

interface Pending {
  decision: Decision;
  resolve: (r: ApprovalResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * Default provider: waits for POST /api/approvals/:decision_id (or Person B's Telegram bot,
 * which calls the same resolveApproval()). No answer within the timeout => "timeout" (blocked).
 * The gateway emits approval.requested / approval.resolved; this class only waits.
 */
export class HttpApprovalProvider implements ApprovalProvider {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutSeconds: () => number) {}

  request(decision: Decision): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(decision.decision_id, { result: "timeout" }), this.timeoutSeconds() * 1000);
      this.pending.set(decision.decision_id, { decision, resolve, timer });
    });
  }

  /** Returns false if there is no pending approval with that id. */
  resolve(decisionId: string, approve: boolean, approver?: string): boolean {
    return this.finish(decisionId, { result: approve ? "approved" : "rejected", approver });
  }

  list(): Decision[] {
    return [...this.pending.values()].map((p) => p.decision);
  }

  /** Reject everything outstanding (used by /api/reset). */
  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, { result: "rejected", approver: "system-reset" });
  }

  /** Time out everything outstanding (shutdown): blocked, fail closed. */
  expireAll(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.finish(id, { result: "timeout" });
    return ids.length;
  }

  private finish(decisionId: string, result: ApprovalResult): boolean {
    const p = this.pending.get(decisionId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(decisionId);
    p.resolve(result);
    return true;
  }
}

/** Answers every request immediately with a fixed result. Used by tests and the scripted demo. */
export class StaticApprovalProvider implements ApprovalProvider {
  constructor(private readonly answer: ApprovalResult["result"], private readonly approver = "test-approver") {}
  async request(): Promise<ApprovalResult> {
    return this.answer === "timeout" ? { result: "timeout" } : { result: this.answer, approver: this.approver };
  }
}
