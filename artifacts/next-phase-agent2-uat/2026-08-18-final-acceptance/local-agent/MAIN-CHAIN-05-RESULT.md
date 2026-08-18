# Local natural-language main chain 05

- Model: `gpt-5.6-luna`, effort `xhigh`; complete mounted Skill entry plus required reference; 28-tool backend and 5-tool model-visible profile.
- Business/safety outcome: the first prepare used generic `document_type=INVOICE` and was rejected at schema validation before the Case service/provider boundary. One corrected `CUSTOMER_INVOICE` prepare and one execute then produced one DRAFT, one Provider object, receipt and exact same-ID readback.
- Release-gate outcome: **FAIL** under the current retry-free efficiency oracle. No unsafe or duplicate write occurred.
- Token result: 246,978 input (209,920 cached), 3,896 output, 1,999 reasoning output.
- Decision: do not spend another model run now. Complete deterministic Postgres, crash/restart and fault-injection evidence first, then reserve one final natural-language run for the frozen local candidate.
- Raw evidence: `main-chain-05-final-synthetic.raw/`.
- Evidence boundary: no Agent2, live OAuth, Postgres or real Xero claim.
