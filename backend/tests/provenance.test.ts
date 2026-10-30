import { describe, expect, it } from "vitest";
import { ContextLedger } from "../src/gateway/contextLedger.js";
import { argProvenance, describeLocation } from "../src/gateway/provenance.js";
import { normalizeAmount, findSpans } from "../src/gateway/normalize.js";
import { containsSensitive } from "../src/gateway/sensitive.js";
import { mockTools } from "../src/tools/mockTools.js";
import { loadPolicy } from "../src/policy/loader.js";

const policy = loadPolicy("./src/policy/policy.yaml");

function poisonedLedger() {
  const ledger = new ContextLedger("run_test");
  ledger.addUser("Read https://news.example.test/ai-trends-2026 and give me a short summary");
  const page = mockTools.browse_url({ url: "https://news.example.test/ai-trends-2026" }, "run_test");
  const seg = ledger.addToolResult("browse_url", "UNTRUSTED", page.text, { label: "news.example.test/ai-trends-2026" });
  return { ledger, seg };
}

describe("argument provenance", () => {
  it("classifies an injected recipient as UNTRUSTED_SOURCED with evidence inside the hidden div", () => {
    const { ledger, seg } = poisonedLedger();
    const p = argProvenance("to", "attacker@evil.test", ledger);
    expect(p.class).toBe("UNTRUSTED_SOURCED");
    expect(p.evidence.length).toBeGreaterThanOrEqual(1);

    const first = p.evidence[0];
    expect(first.segment_id).toBe(seg.segment_id);
    expect(seg.text.slice(first.start, first.end)).toBe("attacker@evil.test");
    const divStart = seg.text.indexOf('<div style="color:#ffffff;font-size:1px">');
    const divEnd = seg.text.indexOf("</div>", divStart);
    expect(first.start).toBeGreaterThan(divStart);
    expect(first.end).toBeLessThan(divEnd);
    expect(describeLocation(seg.text, first.start)).toBe("hidden text");
    expect(first.excerpt).toContain("attacker@evil.test");

    // Second hit is in the HTML comment.
    expect(describeLocation(seg.text, p.evidence[1].start)).toBe("an HTML comment");
  });

  it("classifies a recipient from the user's prompt as USER_SOURCED", () => {
    const ledger = new ContextLedger("run_test");
    ledger.addUser("Read https://news.example.test/solar-microgrids and email a 3-line summary to priya@company.test");
    ledger.addToolResult("browse_url", "UNTRUSTED", "some page mentioning PRIYA@company.test too");
    const p = argProvenance("to", "Priya@Company.test", ledger);
    expect(p.class).toBe("USER_SOURCED");
    expect(p.evidence.some((e) => e.source === "user")).toBe(true);
  });

  it("matches ₹49,999 in the prompt against amount 49999", () => {
    expect(normalizeAmount("₹49,999")).toBe("49999");
    expect(normalizeAmount("Rs 49999")).toBe("49999");
    expect(normalizeAmount(49999)).toBe("49999");

    const ledger = new ContextLedger("run_test");
    const seg = ledger.addUser("Pay ₹49,999 to vendor-acme@upi for the pending invoice");
    const p = argProvenance("amount_inr", 49999, ledger);
    expect(p.class).toBe("USER_SOURCED");
    expect(seg.text.slice(p.evidence[0].start, p.evidence[0].end)).toBe("₹49,999");
    expect(argProvenance("payee", "vendor-acme@upi", ledger).class).toBe("USER_SOURCED");
  });

  it("classifies a value found nowhere as UNKNOWN", () => {
    const ledger = new ContextLedger("run_test");
    ledger.addUser("Email the report to my manager");
    expect(argProvenance("to", "boss@company.test", ledger).class).toBe("UNKNOWN");
  });

  it("ignores system prompt text and respects identifier boundaries", () => {
    const ledger = new ContextLedger("run_test");
    ledger.addSystem("Contact admin@company.test for help");
    ledger.addUser("send it to jadmin@company.test");
    expect(argProvenance("to", "admin@company.test", ledger).class).toBe("UNKNOWN");
    expect(findSpans("email", "a@b.test", "mail a@b.test.")).toHaveLength(1);
  });
});

describe("sensitive data detection", () => {
  it("flags PAN/phone patterns and values returned by query_db", () => {
    const ledger = new ContextLedger("run_test");
    const res = mockTools.query_db({ fields: ["name", "account_number"] }, "run_test");
    ledger.addToolResult("query_db", "INTERNAL_DATA", res.text, { records: res.records });

    expect(containsSensitive("body", "PAN ABCPE1234F, call 9800000001", ledger, policy).map((m) => m.kind)).toEqual(["pan", "phone"]);
    const acct = containsSensitive("body", "acct 000111222301", ledger, policy);
    expect(acct.some((m) => m.kind === "account_number" && m.evidence.trust === "INTERNAL_DATA")).toBe(true);
    expect(containsSensitive("body", "Village microgrids serve 80-200 households.", ledger, policy)).toEqual([]);
  });
});
