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
const MASKED_KEYS = new Set(["account_number"]);

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
  return maskPan(text).replace(PHONE, (m) => keepLast4(m));
}

export function maskDeep<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") return key && MASKED_KEYS.has(key) ? keepLast4(value) : maskText(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, undefined));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]));
  }
  return value;
}
