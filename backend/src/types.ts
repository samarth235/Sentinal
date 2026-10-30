// SHARED CONTRACTS — Person B imports these. Do not change field names without telling Person B.

export type Trust = "TRUSTED" | "UNTRUSTED" | "INTERNAL_DATA";
export type Impact = "low" | "medium" | "high" | "critical";
export type Verdict = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
export type Outcome =
  | "EXECUTED"            // ALLOW -> tool ran
  | "BLOCKED"             // DENY
  | "APPROVED_EXECUTED"   // REQUIRE_APPROVAL -> human approved -> tool ran
  | "REJECTED"            // REQUIRE_APPROVAL -> human rejected
  | "TIMED_OUT"           // REQUIRE_APPROVAL -> no answer in time -> blocked (fail closed)
  | "UNPROTECTED_EXECUTED"; // shield OFF -> tool ran without checks

export interface ToolCall {
  call_id: string;
  run_id: string;
  session_id: string;
  profile: string;            // agent permission profile, e.g. "research_assistant"
  tool: string;
  args: Record<string, unknown>;
  requested_at: string;       // ISO timestamp
}

export interface ContextSegment {
  segment_id: string;
  source: "user" | "system" | "tool_result";
  tool?: string;              // when source = tool_result
  trust: Trust;
  text: string;
  added_at: string;
}

export interface Evidence {
  segment_id: string;
  source: ContextSegment["source"];
  trust: Trust;
  start: number;              // char offset in segment.text
  end: number;
  excerpt: string;            // ~80 chars around the match, for the UI
}

export type ProvenanceClass = "USER_SOURCED" | "UNTRUSTED_SOURCED" | "UNKNOWN";

export interface ArgProvenance {
  arg: string;
  value: string;
  class: ProvenanceClass;
  evidence: Evidence[];
}

export interface Reason {
  code: ReasonCode;
  message: string;            // plain English, shown to judges
  evidence?: Evidence[];
}

export type ReasonCode =
  | "TOOL_NOT_PERMITTED"
  | "INVALID_ARGS"
  | "SENSITIVE_FIELD_NOT_PERMITTED"
  | "ARG_FROM_UNTRUSTED_CONTENT"
  | "SENSITIVE_DATA_EGRESS"
  | "GUARD_FLAGGED_INJECTION"
  | "GUARD_UNAVAILABLE"
  | "HIGH_IMPACT_REQUIRES_CONFIRMATION"
  | "ARG_PROVENANCE_UNKNOWN"
  | "ENGINE_ERROR"
  | "POLICY_DEFAULT_ALLOW";

export interface GuardSignal {
  available: boolean;
  label: "injection" | "benign" | "unknown";
  score: number;              // 0..1
  provider: string;           // "heuristic-stub" | "groq"
}

export interface Decision {
  decision_id: string;
  call: ToolCall;
  verdict: Verdict;
  rule_id: string;            // first rule that decided, e.g. "R4"
  reasons: Reason[];
  impact: Impact;
  session_tainted: boolean;
  provenance: ArgProvenance[];
  guard: GuardSignal;
  shield: boolean;
  latency_ms: number;         // measured gateway time, excluding human approval wait
  decided_at: string;
  outcome?: Outcome;          // filled in after execution/approval
}

export type BusEvent =
  | { type: "run.started"; run_id: string; scenario_id: string; shield: boolean; mode: "live" | "scripted" }
  | { type: "context.added"; run_id: string; segment: ContextSegment }
  | { type: "tool.requested"; run_id: string; call: ToolCall }
  | { type: "decision.made"; run_id: string; decision: Decision }
  | { type: "approval.requested"; run_id: string; decision: Decision }
  | { type: "approval.resolved"; run_id: string; decision_id: string; result: "approved" | "rejected" | "timeout"; approver?: string }
  | { type: "tool.executed"; run_id: string; decision_id: string; result_preview: string }
  | { type: "agent.message"; run_id: string; text: string }
  | { type: "run.finished"; run_id: string; summary: RunSummary };

export interface RunSummary {
  run_id: string;
  scenario_id: string;
  shield: boolean;
  decisions: Decision[];
  outbox_count: number;
  ledger_count: number;
  attack_succeeded: boolean;  // per scenario's success criteria (§9)
}
