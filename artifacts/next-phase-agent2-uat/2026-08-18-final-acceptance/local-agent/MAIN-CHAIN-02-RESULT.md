# Local natural-language main chain 02

- Boundary: local deployment-equivalent Agent with synthetic Provider adapter only.
- Model: `gpt-5.6-luna`, effort `high`.
- Business outcome: one synthetic customer-invoice DRAFT reached terminal exact-readback verification.
- Release-gate outcome: **FAIL**. One redundant connection-status read occurred before target pinning, and the first prepare call used four invalid enum/required fields before one corrected prepare.
- Token result: 253,480 input (213,248 cached), 3,401 output, 1,629 reasoning output. Input fell 27.7% from run 01, but the retry-free target was not met.
- Evidence handling finding: both failed runs originally shared `local-agent-run.raw`; the harness now derives a distinct raw directory from each evidence filename so later A/B attempts cannot overwrite earlier raw evidence.
- Evidence boundary: no Agent2, live OAuth, Postgres or real Xero claim.
