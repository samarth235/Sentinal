// Display-side masking (the outbox/ledger API returns raw synthetic values). Mirrors the backend.
const PAN = /(?<![A-Za-z0-9])([A-Z]{5})([0-9]{4})([A-Z])(?![A-Za-z0-9])/g;
const PHONE = /(?<![A-Za-z0-9])((?:\+91[- ]?)?[6-9][0-9]{9})(?![A-Za-z0-9])/g;

export function maskText(text: string): string {
  return text
    .replace(PAN, (_m, a: string, d: string, z: string) => `${a}${"*".repeat(d.length)}${z}`)
    .replace(PHONE, (m) => m.slice(0, -4).replace(/\d/g, "*") + m.slice(-4));
}

/** PANs in already-masked or raw text. */
export function countPans(text: string): number {
  return (text.match(/(?<![A-Za-z0-9])[A-Z]{5}[0-9*]{4}[A-Z](?![A-Za-z0-9])/g) ?? []).length;
}

export function formatArg(v: unknown, max = 80): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = s.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
