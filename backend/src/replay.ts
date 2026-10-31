import { evaluate } from "./gateway/policyEngine.js";
import { NOT_CONSULTED, safeClassify } from "./integrations/guard.js";
import { providers } from "./integrations/index.js";
import { readPolicyFile } from "./policy/loader.js";
import { findDecision } from "./runs.js";
import type { Decision } from "./types.js";

export interface ReplayResult {
  decision: Decision;
  /** Policy file hash used for the replay (the file as it is now). */
  policy_hash: string;
  /** Policy hash that judged the original run. */
  original_policy_hash: string;
}

/**
 * Re-evaluate a stored call against the CURRENT policy file, with the context the agent had at the time.
 * No execution, and the live policy is not replaced. Returns null for an unknown decision;
 * throws PolicyError if the file on disk is invalid.
 */
export async function replayDecision(decisionId: string): Promise<ReplayResult | null> {
  const found = findDecision(decisionId);
  if (!found) return null;
  const { policy, hash } = readPolicyFile();
  const ledger = found.run.ledger.snapshot(found.ledgerSize);
  const t0 = performance.now();
  const guard = ledger.isTainted()
    ? await safeClassify(providers.guard, { call: found.decision.call, untrustedText: ledger.untrustedText() })
    : NOT_CONSULTED;
  const decision = evaluate(found.decision.call, ledger, policy, guard);
  decision.latency_ms = Math.round((performance.now() - t0) * 100) / 100;
  return { decision, policy_hash: hash, original_policy_hash: found.run.policy_hash };
}
