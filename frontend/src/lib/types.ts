// Contracts come from Person A's backend — never redefine them here (type-only import, erased at build).
export type {
  ArgProvenance,
  BusEvent,
  ContextSegment,
  Decision,
  Evidence,
  GuardSignal,
  Outcome,
  Reason,
  RunSummary,
  ToolCall,
  Trust,
  Verdict,
} from "../../../backend/src/types.ts";

export interface ScenarioInfo {
  id: string;
  title: string;
  profile: string;
  user_prompt: string;
}

export interface UiConfig {
  audit_store: "postgres" | "memory" | null;
  tamper_demo: boolean;
  approval_timeout_seconds: number;
  guard_provider: string;
  telegram: boolean;
  telegram_mode?: "polling" | "webhook" | null;
  telegram_error?: string | null;
  auth_required: boolean;
  demo_features?: boolean;
  live_mode?: boolean;
  real_browse?: boolean;
  policy_version?: string;
  version?: string;
}

export interface ForensicsHit {
  source: { run_id: string; segment_id: string; label?: string; tool?: string; added_at: string; excerpt: string };
  decisions: { decision_id: string; verdict: string; rule_id: string; outcome?: string; decided_at: string; impact: string; tool: string }[];
}

export interface OutboxEmail {
  id: string;
  run_id: string;
  to: string;
  subject: string;
  body: string;
  sent_at: string;
}

export interface LedgerPayment {
  id: string;
  run_id: string;
  payee: string;
  amount_inr: number;
  note?: string;
  paid_at: string;
}

export interface AuditRow {
  seq: number;
  run_id: string;
  event_type: string;
  payload: unknown;
  created_at: string;
  prev_hash: string;
  hash: string;
}

export type VerifyResult =
  | { valid: true; rows: number }
  | { valid: false; rows: number; broken_at: number; expected: string; found: string };
