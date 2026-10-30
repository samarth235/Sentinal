// Value normalisation for provenance matching (§8.2). Deterministic string handling only.

export type ValueKind = "email" | "id" | "amount" | "url" | "text";

export function normalizeEmail(v: string): string {
  return v.trim().toLowerCase().replace(/^mailto:/, "");
}

export function normalizeId(v: string): string {
  return v.trim().toLowerCase();
}

/** "₹49,999" / "Rs 49999" / "INR 49,999.00" / 49999 -> "49999". Returns null if not a number. */
export function normalizeAmount(v: string | number): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v)) : null;
  const cleaned = v
    .trim()
    .toLowerCase()
    .replace(/₹|\brs\.?|\binr\b|,|\s/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return String(Math.round(Number(cleaned)));
}

/** Lowercase host; compare host + path. */
export function normalizeUrl(v: string): string {
  try {
    const u = new URL(v.trim());
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return normalizeText(v);
  }
}

export function normalizeText(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

export function kindForArg(arg: string): ValueKind {
  if (["to", "cc", "bcc", "recipient", "email"].includes(arg)) return "email";
  if (["payee", "upi", "upi_id"].includes(arg)) return "id";
  if (arg.startsWith("amount")) return "amount";
  if (arg === "url") return "url";
  return "text";
}

export function normalizeValue(kind: ValueKind, v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : JSON.stringify(v ?? "");
  switch (kind) {
    case "email":
      return normalizeEmail(s);
    case "id":
      return normalizeId(s);
    case "amount":
      return normalizeAmount(typeof v === "number" ? v : s);
    case "url":
      return normalizeUrl(s);
    case "text":
      return normalizeText(s);
  }
}

export interface Span {
  start: number;
  end: number;
}

const ID_CHAR = /[a-z0-9._%+\-@]/i;

/**
 * Find every occurrence of an already-normalised value in raw text and return spans in
 * ORIGINAL text offsets, using the same normalisation on the text side.
 */
export function findSpans(kind: ValueKind, needle: string, text: string): Span[] {
  if (!needle) return [];
  if (kind === "amount") return findAmountSpans(needle, text);
  if (kind === "url") return findUrlSpans(needle, text);
  if (kind === "email" || kind === "id") return findTokenSpans(needle, text);
  return findTextSpans(needle, text);
}

/** Case-insensitive search with identifier boundaries, so "bob@x.test" does not match "jbob@x.test". */
function findTokenSpans(needle: string, text: string): Span[] {
  const hay = text.toLowerCase();
  const spans: Span[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    const end = i + needle.length;
    const before = i > 0 ? hay[i - 1] : "";
    const after = hay[end] ?? "";
    const afterNext = hay[end + 1] ?? "";
    const okBefore = !before || !ID_CHAR.test(before);
    // A trailing "." is sentence punctuation unless another identifier char follows it.
    const okAfter = !after || !ID_CHAR.test(after) || (after === "." && !/[a-z0-9]/i.test(afterNext));
    if (okBefore && okAfter) spans.push({ start: i, end });
    i = hay.indexOf(needle, i + 1);
  }
  return spans;
}

function findAmountSpans(needle: string, text: string): Span[] {
  const re = /(?:₹|\brs\.?|\binr)?\s?\d[\d,]*(?:\.\d+)?/gi;
  const spans: Span[] = [];
  for (const m of text.matchAll(re)) {
    // Do not match digits that are part of a larger token (e.g. a phone or account number).
    const prev = m.index > 0 ? text[m.index - 1] : "";
    if (prev && /[a-z0-9]/i.test(prev)) continue;
    if (normalizeAmount(m[0]) === needle) {
      const lead = m[0].length - m[0].trimStart().length;
      spans.push({ start: m.index + lead, end: m.index + m[0].length });
    }
  }
  return spans;
}

function findUrlSpans(needle: string, text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) {
    if (normalizeUrl(m[0].replace(/[.,;]+$/, "")) === needle) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** Lowercase + whitespace-collapse the text while keeping a map back to original offsets. */
function findTextSpans(needle: string, text: string): Span[] {
  let norm = "";
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inSpace && norm.length > 0) {
        norm += " ";
        map.push(i);
      }
      inSpace = true;
    } else {
      norm += ch.toLowerCase();
      map.push(i);
      inSpace = false;
    }
  }
  const spans: Span[] = [];
  let i = norm.indexOf(needle);
  while (i !== -1) {
    spans.push({ start: map[i], end: map[i + needle.length - 1] + 1 });
    i = norm.indexOf(needle, i + 1);
  }
  return spans;
}

export function excerpt(text: string, start: number, end: number, width = 80): string {
  const pad = Math.max(0, Math.floor((width - (end - start)) / 2));
  const from = Math.max(0, start - pad);
  const to = Math.min(text.length, end + pad);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}
