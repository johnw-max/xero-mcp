# Xero MCP deterministic contract harness

This harness exercises the production `createAccountingMcpServer` over the MCP SDK's linked in-memory transport. It never contacts Xero and gives the server only `xero.read`, so even a schema-valid, explicitly confirmed DRAFT request must stop before the fake provider write method.

Run from the repository root:

```bash
npx tsx harness/runners/run-contract.ts --run-id local-contract-001
```

Each run writes:

- `artifacts/harness-runs/<run-id>/contract-results.json`
- `artifacts/harness-runs/<run-id>/tool-receipts.jsonl`

The process exits non-zero if any protocol, tool-surface, routing, strict-schema, dangerous-tool, or write-gate assertion fails.
