import type { ContextLedger } from "./gateway/contextLedger.js";
import { evaluate } from "./gateway/policyEngine.js";
import { ledgerFromAudit } from "./history.js";
import { NOT_CONSULTED, safeClassify } from "./integrations/guard.js";
import { auditChain, providers } from "./integrations/index.js";
import { readPolicyFile } from "./policy/loader.js";
import { findDecision } from "./runs.js";
import type { Decision } from "./types.js";

export interface ReplayResult {
  decision: Decision;
  /** The decision as it was originally made. */
  original: Decision;
  /** Policy file hash used for the replay (the file as it is now). */
  policy_hash: string;
  /** Policy hash that judged the original call. */
  original_policy_hash: string;
  /** True when the context was rebuilt from the (masked) audit log, e.g. after a restart. */
  reconstructed: boolean;
}

/**
 * Re-evaluate a stored call against the CURRENT policy file, with the context the agent had at the time.
 * No execution, and the live policy is not replaced. Works for calls from before a restart by rebuilding
 * the context from the audit log. Returns null for an unknown decision; throws PolicyError if the file
 * on disk is invalid.
 */
export async function replayDecision(decisionId: string): Promise<ReplayResult | null> {
  let ledger: ContextLedger;
  let original: Decision;
  let originalHash: string;
  let reconstructed = false;

  const found = findDecision(decisionId);
  if (found) {
    ledger = found.run.ledger.snapshot(found.ledgerSize);
    original = found.decision;
    originalHash = found.run.policy_hash;
  } else {
    const fromAudit = ledgerFromAudit(await auditChain.list(), decisionId);
    if (!fromAudit) return null;
    ({ ledger, decision: original } = fromAudit);
    originalHash = original.policy_version ?? "unknown";
    reconstructed = true;
  }

  const { policy, hash } = readPolicyFile();
  const t0 = performance.now();
  const guard = ledger.isTainted() ? await safeClassify(providers.guard, { call: original.call, untrustedText: ledger.untrustedText() }) : NOT_CONSULTED;
  const decision = evaluate(original.call, ledger, policy, guard);
  decision.latency_ms = Math.round((performance.now() - t0) * 100) / 100;
  // Decisions rebuilt from the audit log carry the short (12-char) version; compare like with like.
  const policy_hash = originalHash.length === 12 ? hash.slice(0, 12) : hash;
  return { decision, original, policy_hash, original_policy_hash: originalHash, reconstructed };
}
