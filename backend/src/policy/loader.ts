import { createHash } from "node:crypto";
import fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { canonicalJson } from "../integrations/canonicalJson.js";

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
  /** sha256 of the canonical policy (first 12 hex chars). Recorded on every decision. */
  readonly policy_version?: string;
};
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export class PolicyError extends Error {}

export function policyVersion(p: z.infer<typeof PolicySchema>): string {
  return createHash("sha256").update(canonicalJson(p)).digest("hex").slice(0, 12);
}

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
  return { ...result.data, policy_version: policyVersion(result.data) };
}

export function loadPolicy(policyPath: string): Policy {
  return parsePolicy(fs.readFileSync(policyPath, "utf8"));
}

let current: Policy | null = null;
let currentPath: string | null = null;

/** Load the active policy. Called once at startup; an invalid policy throws and the server refuses to start. */
export function initPolicy(policyPath: string): Policy {
  current = loadPolicy(policyPath);
  currentPath = policyPath;
  return current;
}

/** Re-read the policy file (hot reload, also used by replay). Keeps the old policy if the new one is invalid. */
export function reloadPolicy(): Policy {
  if (!currentPath) throw new PolicyError("Policy not initialised");
  current = loadPolicy(currentPath);
  return getPolicy();
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
