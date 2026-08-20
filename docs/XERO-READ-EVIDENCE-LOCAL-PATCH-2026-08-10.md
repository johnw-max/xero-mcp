# Xero read-evidence local patch

Date: 2026-08-10  
Status: **LOCAL-VERIFIED / NOT DEPLOYED**

## Why this patch exists

The isolated Accounting Skills + Xero UAT showed that the deployed MCP returned ordinary reads as bare `{ "result": ... }` payloads. The Agent therefore had no deterministic current-target, binding-version, audit, observation-time, field-binding, or query-completeness receipt and over-promoted bounded reads into current-ledger facts.

## Local remediation

- Preserve the backward-compatible top-level `result` while adding a normalized evidence envelope.
- Carry the server-owned active binding revision through repository, OAuth token verification, request context, and an opaque Agent receipt; stale revisions are rejected at execution time.
- Return the persisted audit call reference and keep the governance output hash identical to the final sanitized Agent-visible `result`.
- Fail closed for every non-connection-status action when a trusted tenant context is unavailable; revalidate legacy tenant context after execution.
- Mark `xero_connection_status` as `connector_control_plane`. It returns connection health only and cannot prove a ledger target; `xero_get_organisation` remains the target-resolution capability.
- Preserve explicit query bounds and completeness. Collection receipts never claim whole-ledger completeness; exact reads prove object identity, not complete Provider fields.
- For Trial Balance, record `paymentsOnly=false`, distinguish an explicit date from an unresolved Provider default, finalize byte counters and hashes before success is audited, and bound result/evidence metadata including abnormal 90 KB field names.
- Remove raw tenant, organisation, connection, binding, OAuth, and credential locators from Agent-facing read payloads.

## Local verification

- `npm run typecheck`: PASS.
- `npm test` outside the filesystem/network sandbox: 817 passed, 52 environment-gated skips, 0 failed.
- All 52 gated tests were then run in their required environments and passed:
  - OAuth HTTP loopback: 3/3 with `npm run test:http:required`.
  - PostgreSQL 17 integration: 49/49 with `npm run test:postgres:required` against a disposable, safety-named local database; the temporary container was stopped and automatically removed after the run.
- Across the default and required-gate runs, all 869 tests passed in their applicable environments.
- Trial Balance Provider transport suite: 9/9 passed as part of the full run.
- `npm run build`: PASS.
- No external MCP call, OAuth reconnect, Provider write, or deployment was performed by this patch workflow.

## Remaining live release gate

Deploy this source revision to an isolated demo MCP, then repeat the read-only UAT with fresh conversations. Do not replace the production Agent until Organisation, later ledger reads, and Trial Balance all return matching target/binding receipts, the Agent respects bounded-query completeness, and the run remains at zero writes.
