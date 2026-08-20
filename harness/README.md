# Xero MCP deterministic contract harness

This harness exercises the production `createAccountingMcpServer` over the MCP SDK's linked in-memory transport. It pins the current `0.4.0-rc.1` public contract to 28 tools: three Accounting Case tools plus bounded reads and target controls. It never contacts Xero and gives the server only `xero.read`. A schema-valid `xero_execute_accounting_case` request may therefore enter the Case service so it can inspect exact durable state, but the synthetic ordinary Case is rejected with `SCOPE_MISSING` before preflight, preparation, permit issuance, or Provider write. Production `RECOVERY_REQUIRED` execution may use the same read-only entry only for exact GET reconciliation.

Run from the repository root:

```bash
npx tsx harness/runners/run-contract.ts --run-id local-contract-001
```

Use `--out-dir /tmp/xero-contract-local-001` when release verification should
not create workspace artifacts.

Each run writes:

- `artifacts/harness-runs/<run-id>/contract-results.json`
- `artifacts/harness-runs/<run-id>/tool-receipts.jsonl`

The process exits non-zero if any protocol, 28-tool surface, Case routing, strict-schema, legacy-bypass-tool, dangerous-tool, or write-gate assertion fails. The Agent execute schema accepts only Case/version/request identity; business authority comes from server-side Standing Delegation, not a per-document chat phrase.

The current controlled-write companion is:

```bash
node --import tsx harness/runners/run-p0-accounting-case.ts \
  --run-id local-accounting-case-001
```

It validates the same public 28-tool surface, prepare-without-write, immutable
Case execution under Standing Delegation, Provider receipt plus exact readback,
and same-request replay with one Provider write. See
`harness/P0_CONTROLLED_WRITE_RUNNER.md`. The older object-level controlled-write
runner is retained only as an explicitly legacy internal kernel regression.
