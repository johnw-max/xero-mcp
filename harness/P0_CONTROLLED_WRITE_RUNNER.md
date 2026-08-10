# Local P0 controlled-write runner

This runner executes only the six `CONTROLLED_WRITE` cases selected from
`harness/scenarios/deterministic-contract.p0.json`:

- `DC-IDEMPOTENCY-012`
- `DC-CONCURRENT-012B`
- `DC-DUPLICATE-013`
- `DC-RECOVERY-014`
- `DC-READBACK-014B`
- `DC-REPOSITORY-014C`

It uses the production MCP server, `AccountingService`, and
`InMemoryAccountingRepository` behind a network-free synthetic Xero Provider.
Every case starts with the write gate closed, opens it only for one synthetic
ACCPAY DRAFT scenario, and closes it before the case ends. AUTHORISE and payment
tools are forbidden. The runner never calls Agent2, a browser, or live Xero.

Run it from the Xero MCP project directory:

```bash
npx tsx harness/runners/run-p0-controlled-write.ts \
  --run-id p0-controlled-write-20260806
```

By default, artifacts are written under:

```text
artifacts/harness-runs/<run-id>/p0-controlled-write/
  oracle-results.jsonl
  evidence.jsonl
  provider-records.jsonl
  write-gate-events.jsonl
  summary.md
```

The process exits non-zero when any hard oracle fails. This is intentional: an
unproven case remains `FAIL` rather than being converted into a pass.

Preserved pre-fix evidence (`p0-controlled-write-20260806`):

- 5 PASS / 1 FAIL
- six Provider create calls across six isolated cases
- six Provider DRAFT records
- zero Provider AUTHORISE calls
- all six gates end closed
- the only failure is `DC-CONCURRENT-012B`: one of two barrier-released,
  identical requests sees the first posting in `VALIDATED` and returns
  `CONFLICT`; nevertheless only one Provider write and one record occur

Post-fix evidence (`p0-controlled-write-after-20260806`):

- 6 PASS / 0 FAIL
- the two simultaneous identical requests return the same PostingRequestID and
  InvoiceID, with one new result and one idempotent replay
- exactly one Provider create and one DRAFT record remain in the concurrency
  case
- all six case-scoped write gates finish closed and Provider AUTHORISE remains
  zero

The independently reviewed 0.3.0 final rerun is preserved at
`artifacts/harness-runs/xero-0.3.0-p0-controlled-write-final-20260808/p0-controlled-write/`
and reports 6/6 PASS, six synthetic Provider create calls, six DRAFT records,
zero AUTHORISE calls, and a final closed gate. The full default suite reports
780 PASS with 37 conditional skips; those skipped boundaries were run separately
as required gates: HTTP/OAuth 2/2 PASS and fresh PostgreSQL 35/35 PASS. This still
does not prove the target VPS deployment, Agent2 behavior, or a live Xero
write/read-back.

The pre-fix artifacts are intentionally retained instead of being overwritten,
so the concurrency failure and its correction remain auditable.

Targeted verification:

```bash
npx tsc --noEmit \
  --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --noImplicitOverride --noUnusedLocals --noUnusedParameters \
  --verbatimModuleSyntax --esModuleInterop --skipLibCheck \
  --types node,vitest/globals \
  harness/lib/syntheticXeroWriteProvider.ts \
  harness/runners/run-p0-controlled-write.ts \
  tests/p0-controlled-write-scenario-runner.test.ts

npx vitest run tests/p0-controlled-write-scenario-runner.test.ts
```
