import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { z } from "zod";
import type { Policy } from "../policy/loader.js";
import type { Trust } from "../types.js";

/** Built-in tools (the demo's mock tools). Deployments add more in policy.yaml via args_schema. */
export const toolSchemas = {
  browse_url: z.object({ url: z.string().min(1) }).strict(),
  read_email: z.object({ folder: z.string().optional(), limit: z.number().int().positive().max(20).optional() }).strict(),
  query_db: z
    .object({
      fields: z.array(z.string()).min(1),
      filter: z.object({ city: z.string().optional(), plan: z.string().optional() }).strict().optional(),
    })
    .strict(),
  send_email: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }).strict(),
  send_payment: z
    .object({ payee: z.string().min(1), amount_inr: z.number().positive(), note: z.string().optional() })
    .strict(),
} as const;

export type ToolName = keyof typeof toolSchemas;

/** Trust level of each built-in tool's result when it enters the agent's context (§4). */
export const resultTrust: Record<ToolName, Trust> = {
  browse_url: "UNTRUSTED",
  read_email: "UNTRUSTED",
  query_db: "INTERNAL_DATA",
  send_email: "TRUSTED",
  send_payment: "TRUSTED",
};

export const toolDescriptions: Record<ToolName, string> = {
  browse_url: "Fetch a web page and return its contents as text.",
  read_email: "Read the most recent emails in the user's inbox.",
  query_db: "Query the customer database. Returns customer records projected to the requested fields.",
  send_email: "Send an email.",
  send_payment: "Send a payment in Indian rupees to a UPI payee.",
};

export function isKnownTool(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolSchemas, name);
}

// ---------------------------------------------------------------------------
// Policy-aware lookups
// ---------------------------------------------------------------------------

const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
const ajv = new Ajv({ allErrors: true, strict: false });
(addFormats as unknown as (a: Ajv) => void)(ajv);
const compiled = new Map<string, ValidateFunction>();

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = compiled.get(key);
  if (!fn) {
    fn = ajv.compile(schema);
    compiled.set(key, fn);
  }
  return fn;
}

/** True if Sentinel can validate this tool's arguments (built-in schema or policy args_schema). */
export function hasArgSchema(tool: string, policy: Policy): boolean {
  return Boolean(policy.tools[tool]?.args_schema) || isKnownTool(tool);
}

/** Validate arguments: policy args_schema first, then the built-in schema. No schema => invalid (fail closed). */
export function validateArgs(tool: string, args: unknown, policy: Policy): { ok: true } | { ok: false; issues: string } {
  const schema = policy.tools[tool]?.args_schema;
  if (schema) {
    let fn: ValidateFunction;
    try {
      fn = compile(schema);
    } catch (err) {
      return { ok: false, issues: `policy args_schema for ${tool} is invalid: ${(err as Error).message}` };
    }
    if (fn(args)) return { ok: true };
    const issues = (fn.errors ?? []).map((e) => `${e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(args)"}: ${e.message}`).join("; ");
    return { ok: false, issues };
  }
  if (isKnownTool(tool)) {
    const parsed = toolSchemas[tool].safeParse(args);
    if (parsed.success) return { ok: true };
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ") };
  }
  return { ok: false, issues: `no argument schema for ${tool}` };
}

/** Trust of a tool's output. Unknown tools are UNTRUSTED (fail safe). */
export function trustFor(tool: string, policy?: Policy): Trust {
  const fromPolicy = policy?.tools[tool]?.result_trust;
  if (fromPolicy) return fromPolicy;
  return isKnownTool(tool) ? resultTrust[tool] : "UNTRUSTED";
}

type ClaudeTool = { name: string; description: string; input_schema: { type: "object"; [k: string]: unknown } };

/** JSON schemas handed to Claude in live mode (built-ins plus policy-defined tools). */
export function claudeToolDefinitions(names?: string[], policy?: Policy): ClaudeTool[] {
  const all = names ?? [...new Set([...Object.keys(toolSchemas), ...Object.keys(policy?.tools ?? {})])];
  const out: ClaudeTool[] = [];
  for (const name of all) {
    const fromPolicy = policy?.tools[name];
    if (fromPolicy?.args_schema) {
      out.push({ name, description: fromPolicy.description ?? name, input_schema: { type: "object", ...fromPolicy.args_schema } });
    } else if (isKnownTool(name)) {
      const { $schema: _ignored, ...input_schema } = z.toJSONSchema(toolSchemas[name]) as Record<string, unknown>;
      out.push({ name, description: fromPolicy?.description ?? toolDescriptions[name], input_schema: input_schema as ClaudeTool["input_schema"] });
    }
  }
  return out;
}
