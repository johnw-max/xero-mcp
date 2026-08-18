# Xero MCP 0.4.0-rc.1 Final Online UAT — 2026-08-15

## Release identity

- Public endpoint: `https://mcp.jiayuanwang.xyz`
- Runtime version: `0.4.0-rc.1`
- Build identity: `254491cdbdb62178f3ea872f69a2ae0a1caccbe6fb2ada0788d0763cdd9dc93f`
- Acceptance source: `c829156164842b32d435260199ad8cc15e1a1e8f8980d51eab95b3ff99dd37ef`
- Source archive: `1edf26d3230af14ae1db8db181971751cd3cdaed4d594bd2ae9294a039095db7`
- Approved control catalog: `e488e6ed0177130d26c686f7964a978cd4fe8ebf02b9ac26035f39e885489fbe`
- Public health: `status=ok`, `writeMode=READ_ONLY`, `processWriteGateEnabled=false`, `toolCount=28`
- Public readiness: HTTP 200, `status=ready`

## Local and isolated release gates

- Product/security/config focused: 11 files / 312 tests PASS.
- OAuth focused: 57 tests PASS; required real HTTP loopback separately 3/3 PASS.
- Listen-bound provider/P0 suites outside the restricted sandbox: 12/12 PASS.
- Fresh disposable PostgreSQL required suites: 15 files / 108 tests PASS, migrations through 039.
- Typecheck PASS, build PASS, `git diff --check` PASS.
- Accepted OCI source/context/runtime smoke PASS: 192-file bundle, migration 039, 28 tools, anonymous 401, malformed request 400.
- Default repository suite is not represented as fully green: reviewer/traceability mechanisms remain intentionally fail-closed and nine sandbox-only loopback failures were separately rerun successfully.

## OAuth and platform integration

| Check | Result | Evidence boundary |
|---|---|---|
| Work -> Xero consent -> organisation selection -> return to Work | PASS | Work showed the MCP as `Connected`; the recent broker flow and authorization code were both consumed exactly once; an active installation/family was created. |
| Work manual-return compatibility | PASS | The server accepted the Work allowlisted manual return without weakening state, PKCE, exact redirect, one-time code, or callback validation. |
| Work Agent tool routing | PLATFORM BLOCKER | One of the two duplicate `Xero 会计助理` entries invoked the unrelated `accountingv2` Google connector; the other returned an empty response without calling a tool. This is Work Agent configuration/orchestration, not MCP OAuth or ledger behavior. |
| Agent2 reconnect | PLATFORM CREDENTIAL BLOCKER | Agent2 sends a different client ID from the server's registered Agent2 client. The MCP correctly returned `invalid_client`; no permissive fallback or fabricated registration was added. |

## Public MCP ledger UAT

The public MCP was exercised with a short-lived access token bound to the just-completed Work installation. The raw token never left the one-shot process and was revoked in the same process after the calls. Aggregate verification afterwards showed zero live UAT access tokens and two revoked UAT tokens from the two bounded runs.

1. `xero_pin_current_organisation` — PASS.
2. `xero_get_organisation` — PASS: `Demo Company (Global)`, USD, COMPANY, ACTIVE.
3. `xero_list_invoices` ACCPAY, AUTHORISED/PAID bounded page — PASS: 20 returned, explicit `hasNextPage=true`; representative current bills included Capital Cab Co, Net Connect, PowerDirect, Bayside Wholesale and Xero.
4. `xero_list_invoices` ACCREC, AUTHORISED/PAID bounded page — PASS: 20 returned, explicit `hasNextPage=true`; representative current invoices included Basket Case, Marine Systems, Bayside Club, Hamilton Smith Ltd and City Limousines.
5. Unknown Accounting Case execution negative — PASS: `NOT_FOUND`, failure layer `RESOURCE`, `provider_mutation_possible=false`.

The tool evidence correctly described AP/AR list results as bounded provider pages, not whole-ledger completeness. Organisation evidence was marked `MCP_READ`; it did not claim original-file verification.

## Zero-write proof

The public UAT ran with `XERO_WRITE_ENABLED=false`. Durable counts immediately before and after the authenticated public calls were identical:

| Durable record | Before | After |
|---|---:|---:|
| Xero mutation requests | 1 | 1 |
| Xero mutation requests with write receipt | 1 | 1 |
| Posting requests | 3 | 3 |
| Posting requests with write receipt | 3 | 3 |
| Accounting Cases | 0 | 0 |

Recent tool audit aggregation recorded two successful organisation reads, four successful invoice-list reads, two successful target pins, and two rejected unknown-case execution negatives. No new provider write record or Case was created.

## Release decision

- **MCP read-only candidate: GO.** OAuth, target binding, real Xero reads, bounded completeness evidence, permission rejection, public health/readiness, source-to-image identity and zero-write behavior are verified.
- **Work business-conversation UX: BLOCKED by platform Agent configuration.** The MCP is connected and independently works; Work must remove the unrelated `accountingv2` dependency and resolve the duplicate Xero Agent definitions before conversational UAT can be called complete.
- **Agent2: BLOCKED by platform client-ID mismatch.** Its configured client ID and the server registry must be updated as one credential pair by the platform owner.
- **Autonomous production writes: NOT RELEASED.** The deployed candidate remains read-only. Formal independent-review/traceability closure is still fail-closed and is not bypassed by this UAT.
- No Git staging, commit, push, or GitHub publication was performed.
