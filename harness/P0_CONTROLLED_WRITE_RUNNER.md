# Accounting Case P0 controlled-write release runner

The current `0.4.0-rc.1` release gate is
`harness/runners/run-p0-accounting-case.ts`. It exercises the production MCP
server over an in-memory MCP transport and exposes only the reviewed 28-tool
Agent surface. The governed write traverses the production
`XeroAccountingCaseService -> AccountingService -> XeroMutationService` stack.
Only the final Xero provider adapter is a deterministic fake; it consumes the
real one-shot provider permit and returns its stored provider record through
exact GET with line, net, tax, and gross economics.

It proves three current contract cases from
`harness/scenarios/accounting-case-deterministic.p0.json`:

- `AC-SURFACE-001`: the public surface is exactly 28 tools; all object-level
  mutation tools are absent and a direct bypass call is rejected;
- `AC-CASE-PREPARE-002`: ordinary business-document intake is normalized into
  a tenant-bound immutable Accounting Case without exposing internal identity,
  target, route or Provider fields, with `ledger_write_claim=NOT_WRITTEN` and
  zero Provider writes;
- `AC-DELEGATION-003`: execute accepts only `case_id`, `case_version`, and
  `request_id`; the stored plan passes exact Standing Delegation preflight;
  one synthetic Xero DRAFT is reported successful only after Provider receipt
  and exact same-ID readback; replay of the same request performs no second
  Provider write.

Every run starts with its synthetic write gate closed, opens it only around the
single isolated Provider write, and closes it in `finally`. AUTHORISE and
payment operations remain zero. No browser, Agent2 API, or live Xero tenant is
contacted.

Run from the repository root:

```bash
node --import tsx harness/runners/run-p0-accounting-case.ts \
  --run-id p0-accounting-case-local-001
```

By default, artifacts are written under:

```text
artifacts/harness-runs/<run-id>/p0-accounting-case/
  oracle-results.json
  evidence.jsonl
  provider-records.json
  summary.md
```

The release regression is:

```bash
npx vitest run tests/p0-controlled-write-scenario-runner.test.ts
```

The regression also mutates the provider GET to an internally consistent but
wrong `100.0000 + 7.2000 = 107.2000` readback. That run must fail its success
oracle, persist `READBACK_MISMATCH`, finalize the Case as
`RECOVERY_REQUIRED`, and keep the provider create count at one across the
runner's second execute call.

The test filename is retained for CI compatibility, but it now imports the
current Accounting Case runner. It does not expose legacy object tools.

## Historical internal runner

`harness/runners/run-p0-controlled-write.ts` and the old `DC-*` scenarios are
**legacy internal mutation-kernel regressions, not a 0.4 release gate**. They
use `unsafeExposeLegacyObjectMutationToolsForTests=true` so historical
idempotency, duplicate, and recovery fixtures remain reproducible. Their
0.3.0 artifacts and six-case results are retained unchanged as historical
evidence; they must not be cited as proof of the current Agent-facing Case
contract.
