import { createHash } from "node:crypto";
import fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const ImpactSchema = z.enum(["low", "medium", "high", "critical"]);

const ToolPolicySchema = z.object({
  impact: ImpactSchema,
  provenance_args: z.array(z.string()).default([]),
  egress_args: z.array(z.string()).default([]),
  recipient_arg: z.string().optional(),
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

export type Policy = z.infer<typeof PolicySchema>;
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export class PolicyError extends Error {}

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
  return result.data;
}

export function loadPolicy(policyPath: string): Policy {
  return parsePolicy(fs.readFileSync(policyPath, "utf8"));
}

/** sha256 of the policy file bytes: identifies exactly which policy produced a decision. */
export const policyHashOf = (text: string) => createHash("sha256").update(text).digest("hex");

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
 * policy loaded at startup, so a replay can never change enforcement as a side effect.
 */
export function readPolicyFile(): { policy: Policy; hash: string } {
  if (!currentPath) throw new PolicyError("Policy not initialised");
  const text = fs.readFileSync(currentPath, "utf8");
  return { policy: parsePolicy(text), hash: policyHashOf(text) };
}

/** Hash of the policy currently enforced by live runs. */
export function activePolicyHash(): string {
  if (!currentHash) throw new PolicyError("Policy not initialised");
  return currentHash;
}

/** Approval timeout: APPROVAL_TIMEOUT_SECONDS if set, else the policy default. */
export function approvalTimeoutSeconds(override: number | null): number {
  return override ?? getPolicy().defaults.approval_timeout_seconds;
}

export function getPolicy(): Policy {
  if (!current) throw new PolicyError("Policy not initialised");
  return current;
}
