# Claims to Verify

Before any statistic or CVE goes on a slide, open the **primary source** and confirm the exact figure.
Drop anything you cannot trace. Values listed under "believed" are unverified recollections, not facts.

| Claim | Believed (UNVERIFIED) | Primary source to check | Verified? |
|---|---|---|---|
| EchoLeak: zero-click prompt injection in Microsoft 365 Copilot, CVE-2025-32711 | CVSS 9.3 (critical) | NVD entry for CVE-2025-32711; Microsoft MSRC advisory | ☐ |
| GitHub Copilot / VS Code prompt injection leading to code execution, CVE-2025-53773 | CVSS 7.8 (high) | NVD entry for CVE-2025-53773; MSRC advisory | ☐ |
| Prompt injection is #1 (LLM01) in the OWASP Top 10 for LLM Applications | LLM01 in the 2025 list | genai.owasp.org / OWASP Top 10 for LLM Applications | ☐ |
| Any AI-security readiness or adoption percentage (e.g. Cisco State of AI Security) | — | the report PDF itself, with page number | ☐ |
| Sentinel decision latency | measure, don't recall | `GET /api/decisions` → `latency_ms` from real runs; report the median | ☐ |

Rules:
- Quote latency only from measured `latency_ms` values, and say what was measured (gateway time, excluding the human approval wait).
- When a source gives a different number than "believed", use the source's number.
- Keep the URL and the access date next to each verified claim.
