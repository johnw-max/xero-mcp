# Xero MCP local P0 read-only result

- Run: p0-readonly-final-diagnostic
- Started: 2026-08-13T10:35:34.492Z
- Finished: 2026-08-13T10:35:34.566Z
- Cases: 6; PASS 5; FAIL 1
- Provider write attempts: 0
- Write gate: CLOSED -> CLOSED

| Case | Baseline | Actual | Hard gates | Expected red observed |
| --- | --- | --- | --- | --- |
| DC-CONNECTION-001 | PASS | PASS | yes | no |
| DC-LEDGER-002 | EXPECTED_RED | PASS | yes | no |
| DC-HISTORY-003 | PASS | PASS | yes | no |
| DC-PAYMENT-005 | PASS | PASS | yes | no |
| DC-CREDIT-006 | PASS | PASS | yes | no |
| DC-VERSION-008 | EXPECTED_RED | FAIL | no | yes |

PASS is derived only from parsed model-visible MCP output, independently reserialized transport evidence, Provider call receipts, repository audit state, and local HTTP receipts.
