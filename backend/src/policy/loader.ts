import { createHash } from "node:crypto";
import fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const ImpactSchema = z.enum(["low", "medium", "high", "critical"]);
const TrustSchema = z.enum(["TRUSTED", "UNTRUSTED", "INTERNAL_DATA"]);

const ToolPolicySchema = z.object({
  impact: ImpactSchema,
  provenance_args: z.array(z.string()).default([]),
  egress_args: z.array(z.string()).default([]),
  recipient_arg: z.string().optional(),
  /** Optional JSON Schema for the arguments. Lets a deployment add tools without code changes. */
  args_schema: z.record(z.string(), z.unknown()).optional(),
  /**
   * Trust of this tool's output when it enters the agent's context. Anything that reads
   * outside content (web, email, tickets, files) must be UNTRUSTED. Unset => built-in default,
   * or UNTRUSTED for tools Sentinel does not know (fail safe).
   */
  result_trust: TrustSchema.optional(),
  description: z.string().optional(),
});

const ProfileSchema = z.object({
  allowed_tools: z.array(z.string()),
  query_db: z.object({ allowed_fields: z.array(z.string()) }).optional(),
});

const RegexString = z.string().refine((s) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}, "invalid regular expression");

export const PolicySchema = z.object({
  version: z.literal(1),
  defaults: z.object({
    fail_mode: z.literal("closed"),
    approval_timeout_seconds: z.number().positive(),
    guard_threshold: z.number().min(0).max(1),
  }),
  trusted_email_domains: z.array(z.string()),
  sensitive: z.object({
    fields: z.array(z.string()),
    patterns: z.record(z.string(), RegexString),
  }),
  tools: z.record(z.string(), ToolPolicySchema),
  profiles: z.record(z.string(), ProfileSchema),
});

export type Policy = z.infer<typeof PolicySchema> & {
  /** First 12 hex chars of the policy file's sha256 (plus any active overrides). Recorded on every decision. */
  readonly policy_version?: string;
};
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export class PolicyError extends Error {}

/** sha256 of the policy file bytes: identifies exactly which policy produced a decision. */
export const policyHashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** Parse + validate policy text. Throws PolicyError on anything invalid (fail closed). */
export function parsePolicy(text: string): Policy {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new PolicyError(`Policy YAML is malformed: ${(err as Error).message}`);
  }
  const result = PolicySchema.safeParse(raw);
  if (!result.success) {
    throw new PolicyError(`Policy failed validation: ${z.prettifyError(result.error)}`);
  }
  return { ...result.data, policy_version: policyHashOf(text).slice(0, 12) };
}

export function loadPolicy(policyPath: string): Policy {
  return parsePolicy(fs.readFileSync(policyPath, "utf8"));
}

let current: Policy | null = null;
let currentPath: string | null = null;
let currentHash: string | null = null;

/** Load the active policy. Called once at startup; an invalid policy throws and the server refuses to start. */
export function initPolicy(policyPath: string): Policy {
  const text = fs.readFileSync(policyPath, "utf8");
  current = parsePolicy(text);
  currentPath = policyPath;
  currentHash = policyHashOf(text);
  return current;
}

/**
 * Read the policy file as it is now, WITHOUT installing it (used by replay). Live runs keep the
 * installed policy, so a replay can never change enforcement as a side effect.
 */
export function readPolicyFile(): { policy: Policy; hash: string } {
  if (!currentPath) throw new PolicyError("Policy not initialised");
  const text = fs.readFileSync(currentPath, "utf8");
  return { policy: parsePolicy(text), hash: policyHashOf(text) };
}

/** Deliberate hot reload (POST /api/policy/reload): install the file on disk. An invalid file keeps the old policy. */
export function reloadPolicy(): Policy {
  const { policy, hash } = readPolicyFile();
  current = policy;
  currentHash = hash;
  return getPolicy();
}

/** Hash of the policy file currently enforced by live runs. */
export function activePolicyHash(): string {
  if (!currentHash) throw new PolicyError("Policy not initialised");
  return currentHash;
}

/** Approval timeout: APPROVAL_TIMEOUT_SECONDS if set, else the policy default. */
export function approvalTimeoutSeconds(override: number | null | undefined): number {
  if (override && override > 0) return override;
  return getPolicy().defaults.approval_timeout_seconds;
}

// ---------------------------------------------------------------------------
// Temporary overrides (Telegram /override). They can only ADD a tool to a profile's
// allow-list for a bounded time. Every other rule (schema, provenance, egress, approval)
// still runs, and grants/expiries are audited by the caller.
// ---------------------------------------------------------------------------

export interface PolicyOverride {
  id: string;
  profile: string;
  tool: string;
  expires_at: number; // epoch ms
  granted_by: string;
}

const overrides: PolicyOverride[] = [];
let overrideSeq = 0;
export const MAX_OVERRIDE_MINUTES = 60;

export function addOverride(o: Omit<PolicyOverride, "id">): PolicyOverride {
  const base = getBasePolicy();
  if (!base.profiles[o.profile]) throw new PolicyError(`Unknown profile ${o.profile}`);
  if (!base.tools[o.tool]) throw new PolicyError(`Tool ${o.tool} has no policy entry`);
  const entry = { ...o, id: `ovr_${++overrideSeq}` };
  overrides.push(entry);
  return entry;
}

export function activeOverrides(now = Date.now()): PolicyOverride[] {
  for (let i = overrides.length - 1; i >= 0; i--) if (overrides[i].expires_at <= now) overrides.splice(i, 1);
  return [...overrides];
}

export function clearOverrides(): number {
  const n = overrides.length;
  overrides.length = 0;
  return n;
}

function getBasePolicy(): Policy {
  if (!current) throw new PolicyError("Policy not initialised");
  return current;
}

/** The active policy: the file plus any unexpired overrides. */
export function getPolicy(): Policy {
  const base = getBasePolicy();
  const active = activeOverrides();
  if (active.length === 0) return base;
  const profiles = structuredClone(base.profiles);
  for (const o of active) {
    const p = profiles[o.profile];
    if (p && !p.allowed_tools.includes(o.tool)) p.allowed_tools.push(o.tool);
  }
  const ids = active.map((o) => o.id).join(",");
  return { ...base, profiles, policy_version: `${base.policy_version}+ovr:${ids}` };
}
