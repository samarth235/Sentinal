import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { ToolName } from "./registry.js";
import { pushEmail, pushPayment } from "./state.js";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

export const urlFixtures: Record<string, string> = {
  "https://news.example.test/solar-microgrids": "pages/solar-microgrids.html",
  "https://news.example.test/ai-trends-2026": "pages/ai-trends-2026.html",
};

export interface Customer {
  id: string;
  name: string;
  email: string;
  city: string;
  plan: string;
  signup_date: string;
  pan: string;
  phone: string;
  account_number: string;
  account_status: string;
}

export const customers: Customer[] = JSON.parse(fs.readFileSync(path.join(fixturesDir, "customers.json"), "utf8"));

export interface ToolResult {
  text: string;
  /** Structured rows for query_db, so the ledger can track internal values. */
  records?: Record<string, unknown>[];
}

/**
 * Simulates an agent that reads raw HTML: hidden elements and HTML comments are kept.
 * Plain tags are stripped, but comments, opening tags that carry inline style and their
 * closing div/span tags are left in place (so the evidence locator can tell hidden text
 * apart from visible text).
 */
function naiveHtmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->|<[^>]*>/g, (tag) => (keepTag(tag) ? tag : ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function keepTag(tag: string): boolean {
  return tag.startsWith("<!--") || /^<[a-z][^>]*\sstyle\s*=/i.test(tag) || /^<\/(div|span)>$/i.test(tag);
}

export function normaliseFixtureUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim();
  }
}

export const mockTools: Record<ToolName, (args: any, runId: string) => ToolResult> = {
  browse_url({ url }: { url: string }) {
    const file = urlFixtures[normaliseFixtureUrl(url)];
    if (!file) return { text: `404 Not Found: ${url}` };
    const html = fs.readFileSync(path.join(fixturesDir, file), "utf8");
    return { text: naiveHtmlToText(html) };
  },

  query_db({ fields, filter }: { fields: string[]; filter?: { city?: string; plan?: string } }) {
    const rows = customers
      .filter((c) => !filter?.city || c.city.toLowerCase() === filter.city.toLowerCase())
      .filter((c) => !filter?.plan || c.plan.toLowerCase() === filter.plan.toLowerCase())
      .map((c) => Object.fromEntries(fields.map((f) => [f, (c as unknown as Record<string, unknown>)[f] ?? null])));
    return { text: JSON.stringify(rows, null, 2), records: rows };
  },

  send_email({ to, subject, body }: { to: string; subject: string; body: string }, runId: string) {
    const id = `email_${nanoid(8)}`;
    pushEmail({ id, run_id: runId, to, subject, body, sent_at: new Date().toISOString() });
    return { text: `Email ${id} queued to ${to} (simulated outbox, nothing was sent).` };
  },

  send_payment({ payee, amount_inr, note }: { payee: string; amount_inr: number; note?: string }, runId: string) {
    const id = `pay_${nanoid(8)}`;
    pushPayment({ id, run_id: runId, payee, amount_inr, note, paid_at: new Date().toISOString() });
    return { text: `Payment ${id} of ₹${amount_inr} to ${payee} recorded (simulated ledger, no money moved).` };
  },
};
