# Claims to Verify

Before any statistic or CVE goes on a slide, open the **primary source** and confirm the exact figure.
Drop anything you cannot trace. Values listed under "believed" are unverified recollections, not facts.

| Claim | Verified value | Primary source (accessed 31 Oct 2026) | Verified? |
|---|---|---|---|
| EchoLeak: zero-click prompt injection in Microsoft 365 Copilot, CVE-2025-32711 | CVSS 3.1 **9.3 critical** from Microsoft (the CNA); NIST's own score is **7.5 high**. Say "rated 9.3 critical by Microsoft". | [NVD CVE-2025-32711](https://nvd.nist.gov/vuln/detail/CVE-2025-32711) | ☑ |
| GitHub Copilot / Visual Studio prompt injection leading to code execution, CVE-2025-53773 | CVSS 3.1 **7.8 high** (Microsoft). The blueprint's "9.6" is wrong; do not use it. | [NVD CVE-2025-53773](https://nvd.nist.gov/vuln/detail/CVE-2025-53773) | ☑ |
| Prompt injection is #1 in the OWASP Top 10 for LLM Applications | "LLM01:2025 Prompt Injection" | [genai.owasp.org/llmrisk/llm01-prompt-injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) | ☑ |
| Any AI-security readiness or adoption percentage (e.g. Cisco State of AI Security) | — | the report PDF itself, with page number | ☐ (drop unless checked) |
| Sentinel decision latency | Local measurement: **median 0.21 ms, p95 1.03 ms** over 18 shield-ON decisions (S2/S3/S4, scripted, heuristic guard, dev laptop). Gateway time only. With the Groq guard the network call dominates: re-measure on the demo machine. | `GET /api/decisions` → `latency_ms` | ☑ (re-measure before the pitch) |

Do not claim "under 300 ms" or any other figure that was not measured on the setup being demoed.

Rules:
- Quote latency only from measured `latency_ms` values, and say what was measured (gateway time, excluding the human approval wait).
- When a source gives a different number than "believed", use the source's number.
- Keep the URL and the access date next to each verified claim.
