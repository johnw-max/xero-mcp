# Local P0 read-only scenario runner

This runner executes the seven pre-live Xero cases selected from
`harness/scenarios/deterministic-contract.p0.json` through the production MCP
server, production `AccountingService`, production schemas, and production
Agent-facing bounds. Xero is replaced only at the Provider boundary by the
pinned synthetic ledger fixture; the repository is the production in-memory
implementation.

It covers:

- exact 43-tool surface, OAuth connection binding, read-only scope, and exact tenant;
- account/tax reference data and independently balanced Trial Balance totals;
- a 5,000-row Trial Balance source fixture whose v2 result is independently reserialized and checked as `content-only`, with a 96 KiB model-text limit, 128 KiB complete `CallToolResult` limit, 5,000 returned visited-node limit, and explicit truncation/completeness evidence;
- bounded source inspection (20,000 JSON nodes, 1 MiB measured bytes, 256 nesting levels) and rejection of forged byte/completeness metadata;
- two-page AP history, exact-ID bill readback, and all four AP settlement movement types;
- no-match and duplicate-match preparation that fails closed without a write;
- unknown payment currency/association without inference;
- bounded credit-note associations with explicit truncation;
- package, MCP initialize, `/healthz`, and `/readyz` version consistency.

Run it from the Xero MCP project directory:

```sh
npm exec tsx -- harness/runners/run-p0-readonly.ts --run-id p0-readonly-local-001
```

Optional output directory:

```sh
npm exec tsx -- harness/runners/run-p0-readonly.ts \
  --run-id p0-readonly-local-001 \
  --output-dir /tmp/xero-p0-readonly-local-001
```

Default artifacts are written below
`artifacts/harness-runs/<run-id>/p0-readonly/`:

- `oracle-results.jsonl`: one JSON-Schema-compatible run record;
- `evidence.jsonl`: MCP calls/outputs, Provider calls, repository audits, and local HTTP receipts;
- `summary.md`: compact case-level result table.

The write gate starts and ends closed. The runner sends one schema-valid create
probe under an `xero.read`-only context and requires rejection before the
Provider write method; any Provider write attempt fails the safety oracle.

Latest evidence: `artifacts/harness-runs/xero-0.3.0-p0-readonly-final-20260808/p0-readonly/`
records candidate `0.3.0` with 7/7 PASS, zero Provider writes, and a closed
write gate. This is synthetic, network-free evidence: it does not call Agent2,
the public MCP, or live Xero.

`EXPECTED_RED` is not a success status. If an expected defect is reproduced,
the case remains `FAIL` with `expected_red_observed=true`. If the defect is
fixed and every hard oracle is evidenced, the case becomes `PASS` with
`expected_red_observed=false`.
