import { z } from "zod";
import type { Trust } from "../types.js";

export const toolSchemas = {
  browse_url: z.object({ url: z.string().min(1) }).strict(),
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

/** Trust level of each tool's result when it enters the agent's context (§4). */
export const resultTrust: Record<ToolName, Trust> = {
  browse_url: "UNTRUSTED",
  query_db: "INTERNAL_DATA",
  send_email: "TRUSTED",
  send_payment: "TRUSTED",
};

export const toolDescriptions: Record<ToolName, string> = {
  browse_url: "Fetch a web page and return its contents as text.",
  query_db: "Query the customer database. Returns customer records projected to the requested fields.",
  send_email: "Send an email.",
  send_payment: "Send a payment in Indian rupees to a UPI payee.",
};

export function isKnownTool(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(toolSchemas, name);
}

/** JSON schemas handed to Claude in live mode. */
export function claudeToolDefinitions(names: ToolName[] = Object.keys(toolSchemas) as ToolName[]) {
  return names.map((name) => {
    const { $schema: _ignored, ...input_schema } = z.toJSONSchema(toolSchemas[name]) as Record<string, unknown>;
    return { name, description: toolDescriptions[name], input_schema: input_schema as { type: "object"; [k: string]: unknown } };
  });
}
