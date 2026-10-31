import dns from "node:dns/promises";
import net from "node:net";

/**
 * Fetch a public web page for browse_url, refusing anything that could reach the server's own
 * network (SSRF): only http(s), only public IPs (checked for every redirect hop), a short
 * timeout, a size cap and text content only.
 */

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

export class FetchBlockedError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff") ||
      lower.startsWith("64:ff9b:") ||
      lower.startsWith("2001:db8")
    );
  }
  return true;
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchBlockedError(`only http(s) URLs are allowed`);
  if (url.username || url.password) throw new FetchBlockedError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new FetchBlockedError(`host ${host} is not public`);
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new FetchBlockedError(`host ${host} resolves to a non-public address`);
}

export async function safeFetchText(input: string): Promise<{ text: string; finalUrl: string; contentType: string }> {
  let url = new URL(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "SentinelGateway/1.0 (+browse_url)", accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new FetchBlockedError(`redirect without location`);
        url = new URL(loc, url);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!/^text\/|application\/(xhtml\+xml|json|xml)/i.test(contentType)) throw new FetchBlockedError(`content type ${contentType || "unknown"} is not text`);
      const reader = res.body?.getReader();
      if (!reader) return { text: "", finalUrl: url.toString(), contentType };
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));
      return { text: res.ok ? text : `HTTP ${res.status}\n${text.slice(0, 2000)}`, finalUrl: url.toString(), contentType };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchBlockedError(`too many redirects`);
}
