# Local natural-language main chain 03

- Model: `gpt-5.6-luna`, effort `high`; synthetic Provider only.
- Business outcome: one DRAFT, one Provider object, terminal receipt plus exact same-ID readback.
- Release-gate outcome: **FAIL**. The Agent called connection status before target pinning and made one invalid prepare by combining `PER_LINE` with document-default accounting/tax fields; the corrected prepare and execute then succeeded.
- Token result: 222,836 input (182,784 cached), 3,700 output, 1,745 reasoning output. This is 36.5% lower input than run 01, but still too expensive and not retry-free.
- Decision: stop prompt accretion. Preserve the 28-tool MCP backend, but investigate a deployment-equivalent narrow model-visible tool profile for typed Accounting Case execution. Local and Agent2 must use the same profile before the next paid Agent run.
- Raw evidence: `main-chain-03.raw/`.
- Evidence boundary: no Agent2, live OAuth, Postgres or real Xero claim.
