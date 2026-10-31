/**
 * Privacy masking for anything that leaves the gateway (audit rows, socket events, Telegram).
 *
 * Masking is LENGTH-PRESERVING so evidence offsets (start/end into segment text) stay valid:
 *   PAN    ABCPE1234F  -> ABCPE****F
 *   phone  9800000001  -> ******0001
 *   account_number field values -> all but last 4 digits starred
 */
const PAN = /(?<![A-Za-z0-9])([A-Z]{5})([0-9]{4})([A-Z])(?![A-Za-z0-9])/g;
const PHONE = /(?<![A-Za-z0-9])((?:\+91[- ]?)?[6-9][0-9]{9})(?![A-Za-z0-9])/g;
const AADHAAR = /(?<![A-Za-z0-9])([2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4})(?![A-Za-z0-9])/g;
const CARD = /(?<![A-Za-z0-9])((?:[0-9][ -]?){12,18}[0-9])(?![A-Za-z0-9])/g;
// API keys / tokens: well-known prefixes, keep the prefix and the last 4 chars.
const SECRET = /\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|[0-9]{8,10}:[A-Za-z0-9_-]{35})\b/g;
const MASKED_KEYS = new Set(["account_number", "password", "api_key", "apikey", "secret", "token", "authorization"]);

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function maskSecret(m: string): string {
  const keep = m.match(/^(sk-ant-|sk-|gsk_|ghp_|github_pat_|xox[abprs]-|AKIA|[0-9]{8,10}:)/)?.[0] ?? "";
  return keep + "*".repeat(Math.max(0, m.length - keep.length - 4)) + m.slice(-4);
}

export function maskPan(pan: string): string {
  return pan.replace(PAN, (_m, a: string, digits: string, z: string) => `${a}${"*".repeat(digits.length)}${z}`);
}

function keepLast4(s: string): string {
  let seen = 0;
  return [...s]
    .reverse()
    .map((ch) => (/\d/.test(ch) && seen++ >= 4 ? "*" : ch))
    .reverse()
    .join("");
}

export function maskText(text: string): string {
  return maskPan(text)
    .replace(SECRET, (m) => maskSecret(m))
    .replace(CARD, (m) => {
      const digits = m.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? keepLast4(m) : m;
    })
    .replace(AADHAAR, (m) => keepLast4(m))
    .replace(PHONE, (m) => keepLast4(m));
}

export function maskDeep<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") {
    if (key && MASKED_KEYS.has(key.toLowerCase())) return key === "account_number" ? keepLast4(value) : "*".repeat(Math.min(value.length, 12));
    return maskText(value);
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, undefined));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]));
  }
  return value;
}
