# G5 — Agent2 deployment identity pre-check

Date: 2026-08-18. Performed with unauthenticated, read-only public metadata
requests only. No credentials were used and no write was attempted.

Raw evidence in this directory: `healthz.json`,
`oauth-protected-resource.json`, `oauth-authorization-server.json`.

## Endpoints observed

| Endpoint | Result |
|---|---|
| `https://agent2.zcloak.ai/` | HTTP 200 (SPA shell) |
| `https://mcp.jiayuanwang.xyz/healthz` | HTTP 200, full runtime attestation |
| `https://mcp.jiayuanwang.xyz/.well-known/oauth-protected-resource` | HTTP 200 |
| `https://mcp.jiayuanwang.xyz/.well-known/oauth-authorization-server` | HTTP 200 |
| `https://mcp.jiayuanwang.xyz/mcp` (POST `initialize`, no auth) | HTTP 401 `invalid_token` — correctly fail-closed |

## Identity comparison: deployed vs frozen local candidate

| Field | Deployed | Local candidate | Match |
|---|---|---|:--:|
| `version` | `0.4.0-rc.1` | `0.4.0-rc.1` | yes |
| `toolCount` | 28 | 28 | yes |
| `toolsetHash` | `a43155caabe2f4f4ba0c23f1ad37d6abdfdb4761bad3527884d1e9969b730e87` | same | **yes** |
| `accountingCaseCompiler` | `0.11.0` | `0.11.0` | yes |
| `accountingCaseProviderContract` | `xero-accounting-case-provider-v13` | same | yes |
| `publicToolProfile` | `xero-accounting-case-business-intake-v3` | same | yes |
| `requiredMigration` | `039_accounting_case_expired_target_residual_continuation.sql` | `040_xero_native_idempotency_recovery_claim.sql` | **NO** |
| `attestationHash` | `4fb494b464459d6c04d305b97cb8658229d8b8dd664963bf678a5f8285957cfe` | `6c10c33273546119debeb79aef2a1b75c6b0d4aeb90085da5e253ea882956822` | **NO** |
| `acceptanceSourceSha256` | `c829156164842b32d435260199ad8cc15e1a1e8f8980d51eab95b3ff99dd37ef` | `dbf0ce4da0818e217a6dc76a432b11d3e35e5be6a0ae4360781f86498395fd74` | **NO** |

Local values recomputed from `dist/xeroRelease.js`, `dist/security/hash.js` and
`dist/mcp/toolNames.js` on the frozen candidate.

**The deployed instance is not the accepted local candidate.** The public tool
surface is identical, which is why a casual online check would look correct — but
the enforcement stack differs. Most consequentially, the deployment requires
migration **039** while the candidate requires **040**
(`040_xero_native_idempotency_recovery_claim.sql`), the migration that carries the
XF-001 no-ID unknown-write recovery claim. **Agent2 is running a build that
predates this round's headline P0 fix.**

## Write posture

| Field | Value | Meaning |
|---|---|---|
| `writeMode` | `READ_ONLY` | no provider write is possible |
| `processWriteGateEnabled` | `false` | the process write gate is closed |
| `authorityWriteKillSwitchEnabled` | `false` | kill switch not engaged; irrelevant while read-only |
| `standingDelegationsConfigSha256` | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` | this is `sha256("[]")` — **zero standing delegations are configured** |
| `firmGovernance.status` | `NOT_REQUIRED`, `requiredDelegationCount: 0`, `authorityCount: 0` | no firm governance authority in force |

The execution authority declared by the build is `STANDING_DELEGATION`, and the
deployment has none configured. Even with a working browser session and a valid
OAuth authorization, a DRAFT write on Agent2 today would fail closed at the
delegation check — the same `STANDING_DELEGATION_ACTION_MISMATCH` class of refusal
observed locally.

## Scope posture

`scopes_supported` is exactly `["xero.read", "xero.draft.write"]` on both the
protected-resource and authorization-server metadata. This matches the narrowed
XF-003 model: no Manual Journal, item or settings write scope is offered. Note that
existing authorizations may still carry previously granted scopes until
re-authorized, which metadata alone cannot show.

## Verdict: **G5 NO-GO**

Three independent, mutually sufficient reasons Agent2 cannot host G6 today:

1. **Source drift.** The deployed build is not the accepted candidate and predates
   the P0 idempotency-recovery migration. The round's own stop conditions name
   this explicitly: "Agent2 实际使用的 build/toolset/policy 与 Gate L 候选不同".
2. **Write disabled.** `READ_ONLY` with the process write gate closed.
3. **No standing delegation.** The build's declared execution authority has nothing
   configured to authorise.

None of these is fixable from a browser. They require a host deployment of the
frozen candidate, a migration to 040, a configured standing delegation for the
intended action, and the write gate opened for exactly one installation and tenant.

## Additional environment blocker for UI testing

The in-app browser cannot render the Agent2 SPA: every same-origin asset request
(`/assets/*.js`, `/assets/*.css`) fails with `net::ERR_BLOCKED_BY_CLIENT`,
reproducibly across reloads, leaving only the loading skeleton. No Chrome instance
is connected for the alternative browser surface either. Conversational UI testing
on Agent2 therefore needs the Claude in Chrome extension connected — which would
also carry the existing logged-in session, avoiding any credential entry.

Given the G5 NO-GO above, this is not currently the binding constraint: even a
fully working browser session could not produce a valid G6 result against this
deployment.
