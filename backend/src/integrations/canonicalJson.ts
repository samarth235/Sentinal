/**
 * Stable JSON for hashing: keys sorted recursively, no whitespace, undefined dropped
 * (same as JSON.stringify). The same object always produces the same string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value ?? null))));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
