import { nanoid } from "nanoid";
import type { ArgProvenance, Decision, Evidence, GuardSignal, Impact, Reason, ToolCall, Verdict } from "../types.js";
import type { Policy, ToolPolicy } from "../policy/loader.js";
import { isKnownTool, toolSchemas } from "../tools/registry.js";
import type { ContextLedger } from "./contextLedger.js";
import { computeProvenance, describeLocation } from "./provenance.js";
import { containsSensitive } from "./sensitive.js";

/**
 * The policy engine: a pure, synchronous function from (call, context, policy, guard) to a Decision.
 *
 * Rules run in order. The first DENY wins. REQUIRE_APPROVAL reasons accumulate.
 * ALLOW only if no rule fired. Any exception => DENY (fail closed).
 */

const IMPACT_RANK: Record<Impact, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const atLeastHigh = (impact: Impact) => IMPACT_RANK[impact] >= IMPACT_RANK.high;

interface RuleContext {
  call: ToolCall;
  ledger: ContextLedger;
  policy: Policy;
  guard: GuardSignal;
  toolPolicy: ToolPolicy | undefined;
  impact: Impact;
  tainted: boolean;
  provenance: ArgProvenance[];
}

type RuleResult = { verdict: Exclude<Verdict, "ALLOW">; reason: Reason } | null;

interface Rule {
  id: string;
  check: (ctx: RuleContext) => RuleResult;
}

const deny = (code: Reason["code"], message: string, evidence?: Evidence[]): RuleResult => ({
  verdict: "DENY",
  reason: evidence ? { code, message, evidence } : { code, message },
});

const approve = (code: Reason["code"], message: string): RuleResult => ({
  verdict: "REQUIRE_APPROVAL",
  reason: { code, message },
});

const ARG_LABEL: Record<string, string> = { to: "Recipient", payee: "Payee", amount_inr: "Amount" };

function sourceLabel(ctx: RuleContext, ev: Evidence): string {
  const seg = ctx.ledger.get(ev.segment_id);
  const where = seg ? describeLocation(seg.text, ev.start) : "untrusted content";
  const label = ctx.ledger.labels.get(ev.segment_id) ?? (seg?.tool ? `the ${seg.tool} result` : "untrusted content");
  return `${where} on ${label}`;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const R1_toolNotPermitted: Rule = {
  id: "R1",
  check: ({ call, policy, toolPolicy }) => {
    const profile = policy.profiles[call.profile];
    if (!profile) return deny("TOOL_NOT_PERMITTED", `Unknown agent profile "${call.profile}"; no tools are permitted.`);
    if (!toolPolicy || !isKnownTool(call.tool))
      return deny("TOOL_NOT_PERMITTED", `Tool ${call.tool} has no policy entry, so it is not permitted.`);
    if (!profile.allowed_tools.includes(call.tool))
      return deny("TOOL_NOT_PERMITTED", `The ${call.profile} profile is not permitted to use ${call.tool}.`);
    return null;
  },
};

const R2_invalidArgs: Rule = {
  id: "R2",
  check: ({ call }) => {
    if (!isKnownTool(call.tool)) return deny("INVALID_ARGS", `No argument schema for ${call.tool}.`);
    const parsed = toolSchemas[call.tool].safeParse(call.args);
    if (parsed.success) return null;
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
    return deny("INVALID_ARGS", `Arguments for ${call.tool} are invalid (${issues}).`);
  },
};

const R3_sensitiveFields: Rule = {
  id: "R3",
  check: ({ call, policy }) => {
    if (call.tool !== "query_db") return null;
    const allowed = policy.profiles[call.profile]?.query_db?.allowed_fields ?? [];
    const fields = (call.args.fields as string[]) ?? [];
    const blocked = fields.filter((f) => !allowed.includes(f));
    if (blocked.length === 0) return null;
    return deny(
      "SENSITIVE_FIELD_NOT_PERMITTED",
      `The ${call.profile} profile may not read field${blocked.length > 1 ? "s" : ""} ${blocked.join(", ")} from the customer database.`,
    );
  },
};

const R4_argFromUntrusted: Rule = {
  id: "R4",
  check: (ctx) => {
    if (!atLeastHigh(ctx.impact)) return null;
    const bad = ctx.provenance.filter((p) => p.class === "UNTRUSTED_SOURCED");
    if (bad.length === 0) return null;
    const message = bad
      .map((p) => {
        const label = ARG_LABEL[p.arg] ?? `Argument "${p.arg}"`;
        return `${label} ${p.value} was not in your request; it came from ${sourceLabel(ctx, p.evidence[0])}.`;
      })
      .join(" ");
    return deny("ARG_FROM_UNTRUSTED_CONTENT", message, bad.flatMap((p) => p.evidence));
  },
};

const R5_sensitiveEgress: Rule = {
  id: "R5",
  check: ({ call, ledger, policy, toolPolicy }) => {
    const egressArgs = toolPolicy?.egress_args ?? [];
    if (egressArgs.length === 0) return null;

    let destinationTrusted = false;
    if (call.tool !== "browse_url" && toolPolicy?.recipient_arg) {
      const recipient = String(call.args[toolPolicy.recipient_arg] ?? "").trim().toLowerCase();
      const domain = recipient.split("@")[1] ?? "";
      destinationTrusted = policy.trusted_email_domains.includes(domain);
    }
    if (destinationTrusted) return null;

    const hits = egressArgs.flatMap((arg) => {
      const v = call.args[arg];
      return v === undefined ? [] : containsSensitive(arg, String(v), ledger, policy);
    });
    if (hits.length === 0) return null;

    const kinds = [...new Set(hits.map((h) => h.kind))].join(", ");
    const dest =
      call.tool === "browse_url"
        ? "a URL"
        : toolPolicy?.recipient_arg
          ? `${String(call.args[toolPolicy.recipient_arg])}, which is outside the trusted domains`
          : "an untrusted destination";
    return deny("SENSITIVE_DATA_EGRESS", `This ${call.tool} call would send sensitive data (${kinds}) to ${dest}.`, hits.map((h) => h.evidence));
  },
};

const R6_guardFlagged: Rule = {
  id: "R6",
  check: ({ tainted, guard, policy }) => {
    if (!tainted || guard.label !== "injection" || guard.score < policy.defaults.guard_threshold) return null;
    return approve(
      "GUARD_FLAGGED_INJECTION",
      `Content the agent read looks like a prompt injection (score ${guard.score.toFixed(2)} from ${guard.provider}), so a human must confirm.`,
    );
  },
};

const R7_guardUnavailable: Rule = {
  id: "R7",
  check: ({ guard, impact }) => {
    if (guard.available || !atLeastHigh(impact)) return null;
    return approve("GUARD_UNAVAILABLE", `The injection classifier is unavailable, so this ${impact}-impact action needs human confirmation.`);
  },
};

const R8_highImpact: Rule = {
  id: "R8",
  check: ({ call, impact }) => {
    if (!atLeastHigh(impact)) return null;
    return approve("HIGH_IMPACT_REQUIRES_CONFIRMATION", `${call.tool} is a ${impact}-impact action, so a human must confirm it.`);
  },
};

const R9_provenanceUnknown: Rule = {
  id: "R9",
  check: ({ impact, provenance }) => {
    if (!atLeastHigh(impact)) return null;
    const unknown = provenance.filter((p) => p.class === "UNKNOWN");
    if (unknown.length === 0) return null;
    const list = unknown.map((p) => `${ARG_LABEL[p.arg] ?? p.arg} ${p.value}`).join(", ");
    return approve("ARG_PROVENANCE_UNKNOWN", `${list} did not appear in your request or anything the agent read; the model chose it.`);
  },
};

export const RULES: Rule[] = [
  R1_toolNotPermitted,
  R2_invalidArgs,
  R3_sensitiveFields,
  R4_argFromUntrusted,
  R5_sensitiveEgress,
  R6_guardFlagged,
  R7_guardUnavailable,
  R8_highImpact,
  R9_provenanceUnknown,
];

// ---------------------------------------------------------------------------
// evaluate()
// ---------------------------------------------------------------------------

export function evaluate(call: ToolCall, ledger: ContextLedger, policy: Policy, guard: GuardSignal): Decision {
  const base = {
    decision_id: `dec_${nanoid(10)}`,
    call,
    guard,
    shield: true,
    latency_ms: 0,
    decided_at: new Date().toISOString(),
  };

  try {
    const toolPolicy = policy.tools[call.tool];
    const impact: Impact = toolPolicy?.impact ?? "critical";
    const tainted = ledger.isTainted();
    const provenance = toolPolicy ? computeProvenance(toolPolicy.provenance_args, call.args, ledger) : [];
    const ctx: RuleContext = { call, ledger, policy, guard, toolPolicy, impact, tainted, provenance };

    const approvals: { id: string; reason: Reason }[] = [];
    for (const rule of RULES) {
      const result = rule.check(ctx);
      if (!result) continue;
      if (result.verdict === "DENY") {
        return { ...base, verdict: "DENY", rule_id: rule.id, reasons: [result.reason], impact, session_tainted: tainted, provenance };
      }
      approvals.push({ id: rule.id, reason: result.reason });
    }

    if (approvals.length > 0) {
      return {
        ...base,
        verdict: "REQUIRE_APPROVAL",
        rule_id: approvals[0].id,
        reasons: approvals.map((a) => a.reason),
        impact,
        session_tainted: tainted,
        provenance,
      };
    }

    return {
      ...base,
      verdict: "ALLOW",
      rule_id: "R10",
      reasons: [{ code: "POLICY_DEFAULT_ALLOW", message: `No policy rule objected to this ${impact}-impact ${call.tool} call.` }],
      impact,
      session_tainted: tainted,
      provenance,
    };
  } catch (err) {
    return engineError(base, err);
  }
}

/** R0: any failure inside the engine denies the call. */
export function engineError(base: Omit<Decision, "verdict" | "rule_id" | "reasons" | "impact" | "session_tainted" | "provenance">, err: unknown): Decision {
  return {
    ...base,
    verdict: "DENY",
    rule_id: "R0",
    reasons: [{ code: "ENGINE_ERROR", message: `Sentinel could not evaluate this call safely (${(err as Error)?.message ?? String(err)}), so it was blocked.` }],
    impact: "critical",
    session_tainted: true,
    provenance: [],
  };
}
