# Architecture Review: Write Control Chain (pin → prepare → execute)

**Repo:** `xero-mcp-repo` (Xero Accounting MCP server, v0.4.0-rc.1)
**Review type:** Read-only source review (no writes, no mutating git commands; `npx vitest run` used only to execute existing tests)
**Reviewer date:** 2026-08-18

## Scope and method

Read, in full or in the relevant part, and followed the call graph outward from the
files named in the brief:

- `src/mcp/createServer.ts` (tool registration, `runAudited`/`withTargetSessionInput`,
  the `xero_pin_current_organisation` / `xero_prepare_accounting_case` /
  `xero_execute_accounting_case` wiring)
- `src/services/ledgerTargetSessionService.ts`, `src/services/organisationSwitchService.ts`
- `src/services/xeroAccountingCaseService.ts` (`caseBinding`, `prepare`, `status`,
  `execute`, `#executeOperation`, `#executeNativeDocument`, `#executeCreditNote`,
  `#prepareNativeDocumentOperation`, `#recoverOperation`, `#finalizeRecovery`)
- `src/control-kernel/accountingCaseCompiler.ts`, `accountingCaseReadbackValidator.ts`,
  `accountingMonetary.ts`, `ledgerProviderWritePermit.ts`, `ledgerControlKernel.ts`
- `src/security/xeroProviderWritePermit.ts`, `xeroProviderWritePermitContext.ts`
- `src/policy/xeroBusinessCoordinateAuthority.ts`, `xeroAutonomousActions.ts`,
  `xeroNativeRouteContract.ts`, `xeroAccountingCaseReadbackProjection.ts`
- `src/providers/xeroProvider.ts`, `src/providers/xeroClientManager.ts`
  (`withWriteClient`, `#withFullClient`, `createDraftSupplierBill`/`createDraftSalesInvoice`)
- `src/services/accountingService.ts`, `src/services/xeroMutationService.ts`
  (`#executePreparedInvoiceDraft`, `#createDraftSupplierBill`/`#createDraftSalesInvoice`,
  `resumeAutonomousRecovery`, `#claimNativeIdempotencyRecovery`)
- `src/db/repository.ts`, `src/db/postgresRepository.ts` (`resolveLedgerTargetSession`,
  `saveLedgerTargetSession`, `completeOrganisationSwitch`,
  `projectAccountingCaseOperationFromMutation`), `src/db/inMemoryRepository.ts`
  (parity check)
- `migrations/022_xero_organisation_switch.sql`, `migrations/024_allow_binding_history_per_installation.sql`,
  `migrations/040_xero_native_idempotency_recovery_claim.sql`

Ran `npx vitest run tests/ledger-target-session-service.test.ts` to confirm the
behaviour underlying Finding 1 is real, current, and passing (4/4 tests pass).

I also checked `artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/reviews/SECURITY-REVIEW-AUTH-BOUNDARY.md`,
a prior review already present in the repo. It examined `resolveLedgerTargetSession`
but only for **cross-installation/cross-workspace** isolation (does the WHERE
tuple leak installation A's data to installation B). It did not examine
**same-installation temporal staleness across an organisation switch**, which is
the subject of Finding 1 below — the two are different bug classes and this is
not a duplicate.

## Result summary

| Severity | Count |
|---|---|
| P0 (wrong/duplicate/unauthorised write, false success claim) | **1** |
| P1 (control weakened, not directly exploitable) | **0** |
| P2 (hardening) | **0** |

## Finding 1 (P0): A stale-but-unexpired `target_session_ref` survives an organisation switch and keeps authorising accounting-case writes against the pre-switch tenant

**Where:**
- `src/db/postgresRepository.ts:2941-2989` (`resolveLedgerTargetSession`)
- `src/db/postgresRepository.ts:2632-2879` (`completeOrganisationSwitch`, specifically the
  single-session revocation at lines 2844-2860)
- `src/db/inMemoryRepository.ts:1186-1219` (`resolveLedgerTargetSession`, same behaviour)
- `src/services/organisationSwitchService.ts:78-175` (`start`, which records
  `sourceTargetSessionHash` from only the *one* `target_session_ref` presented to
  `xero_start_organisation_switch`)
- `src/services/ledgerTargetSessionService.ts:55-133` (`issue`, which never revokes
  or bounds any prior still-valid session for the same installation)
- `migrations/024_allow_binding_history_per_installation.sql` (old
  `agent_connection_bindings` rows are deliberately kept `binding_status='ACTIVE'`
  forever as "immutable authorization history")
- Consumed by the write path via `caseBinding()` in
  `src/services/xeroAccountingCaseService.ts:235-266`, which is called from both
  `prepare()` (line 1093) and `execute()` (line 1668) with no independent
  freshness check.

**What breaks:** `xero_pin_current_organisation` can be called more than once for
the same MCP installation while the org has not changed, producing two (or more)
independently valid `target_session_ref` values that both resolve to the same
organisation. When the user later switches organisations via
`xero_start_organisation_switch` → confirmation page → `completeOrganisationSwitch`,
the switch-completion logic revokes **only** the one `ledger_target_sessions` row
whose hash was captured as `sourceTargetSessionHash` at the moment
`xero_start_organisation_switch` was called (postgresRepository.ts:2844-2860). Any
other target session issued earlier for the same installation is left completely
untouched: not expired, not revoked, and — because migration 024 intentionally
never flips old `agent_connection_bindings` rows out of `ACTIVE` status (they are
kept as "immutable authorization history" so historical bindings remain
resolvable) — `resolveLedgerTargetSession` (postgresRepository.ts:2941-2989) still
successfully resolves that stale ref. Its `WHERE` clause requires
`binding.binding_status = 'ACTIVE'` on the (old) binding row and
`target.expires_at > now()`, but **never** joins or filters against
`oauth_installation_active_bindings` — the one table that says which binding is
*currently* selected for the installation. So the stale ref keeps returning the
pre-switch `bindingId`/`connectionId`/`bindingRevision` for as long as its own TTL
lasts (default 30 min, configurable up to 4 h via
`XERO_TARGET_SESSION_TTL_SECONDS`, `src/config.ts:361`), with no signal anywhere
in the response that a switch has since happened.

`caseBinding()` (xeroAccountingCaseService.ts:235-266) — the function both
`prepare()` and `execute()` call to derive the tenant/binding a Case is scoped
to — takes whatever the (possibly stale) resolved `RequestContext` says
(`principal.bindingId`, `principal.connectionId`, `principal.bindingRevision`,
and the tenant id independently re-derived from that same connection via
`provider.resolveContext`). It performs no check against "is this still the
installation's current binding." Everything downstream — the tenant/organisation
cross-check in `prepare()` (line 1074), the one-shot permit's claims
(`ledgerProviderWritePermit.ts`), and the final freshness re-check in
`XeroClientManager.#withFullClient` (`xeroClientManager.ts:396-409`, which
re-resolves the connection **from the same context object**) — is internally
self-consistent, so the write is fully "valid" by every check in the chain. It is
just valid for the *wrong* (pre-switch) organisation. Because the wrongly-targeted
Case is bound to the old tenant, a subsequent `xero_get_accounting_case_status`
call made with the *correct*, current `target_session_ref` will not even see it
(different `AccountingCaseBinding.tenantId`), so the mis-targeted write is not
surfaced by the agent's normal follow-up status check either.

**Concrete failure scenario:**
1. Agent calls `xero_pin_current_organisation` for installation `I` while Org A
   (Client Company A) is the active organisation → gets `ref1` (bound to
   `bindingId=A`, `bindingRevision=1`).
2. Later, still within Org A and before `ref1` expires, the agent calls
   `xero_pin_current_organisation` again (nothing in the tool description or the
   server prevents or discourages this; it is a completely ordinary "re-pin to be
   safe" pattern) → gets `ref2`, also bound to `bindingId=A`, `bindingRevision=1`.
3. User asks to switch to Org B (Client Company B). Agent calls
   `xero_start_organisation_switch` using its most recent pin, `ref2`. The
   confirmation page is completed by the user, switching the installation's
   active binding to Org B (`bindingRevision=2`). `completeOrganisationSwitch`
   revokes `ref2` (the recorded `sourceTargetSessionHash`) — but **`ref1` is
   never touched** and remains fully valid until its own TTL.
4. Agent calls `xero_pin_current_organisation` once more to get `ref3` (Org B) and
   continues normal work. `ref1` is still sitting around (e.g., visible earlier in
   the same tool-call transcript, or re-sent by a retried/duplicated client call).
5. At any point before `ref1`'s TTL elapses, a call to `xero_prepare_accounting_case`
   / `xero_execute_accounting_case` using `ref1` resolves successfully
   (`resolveLedgerTargetSession` has no reason to reject it) and silently prepares
   and **executes a DRAFT bill/invoice against Org A** — the organisation the user
   believes they have already left — while the agent and user both believe every
   subsequent action targets Org B. The tool call returns a normal success payload
   with a real provider receipt and exact readback (Org A's, not Org B's).

**Empirical confirmation:** this exact sequence is already coded, run, and passing
as a unit test, `tests/ledger-target-session-service.test.ts:153-241`
("keeps an independently pinned Company A capability while another pin path
switches to Company B") and its Postgres-integration twin
(`tests/postgres-ledger-target-session.integration.test.ts:34-218`). I ran
`npx vitest run tests/ledger-target-session-service.test.ts` — 4/4 pass. The test
explicitly asserts `resolvedOtherA` (the second, never-used-for-switching pin)
still resolves to `{ bindingId: "target-binding-a", connectionId:
"target-connection-a", bindingRevision: 1 }` **after** the switch to
`target-connection-b` has completed, and that this stale-Org-A context can even be
used to start a *second* organisation switch whose `currentOrganisation` is
reported as `"Client Company A"` — proving the server itself will present Org A as
"the current organisation" through one still-valid capability at the same wall-clock
moment it is presenting Org B as current through another. The test's framing
("concurrent conversations", "another pin path") shows this is an intentional
design choice to let two *different* MCP conversations each hold their own
independent org pin without one's switch invalidating the other's — but nothing
in the protocol distinguishes "a different conversation's pin" from "this same
conversation's own earlier, now-superseded pin." Both look identical to the server.

**Why the write-boundary defenses don't catch this:** I verified the permit/idempotency
chain in detail (see "Areas reviewed and found sound" below) — the one-shot permit,
the idempotency-key-equals-`mutationRequestId` check
(`xeroProviderWritePermitContext.ts:35-53`), and the freshness re-resolve inside
`XeroClientManager.#withFullClient` (`xeroClientManager.ts:396-409`) are all real
and well-built, but every one of them re-derives its expected values from the
*same* `RequestContext` object that was produced once, at tool-call entry, by
`targetSessions.resolve()`. None of them independently ask "is this binding still
the installation's currently active one." A self-consistently stale context passes
every downstream check.

**Severity:** P0. This is a wrong-tenant write (silent cross-client-organisation
draft creation in a multi-tenant accounting-firm deployment) with a false
appearance of correctness — the tool response includes a genuine provider receipt
and exact readback, just for the org the user had already switched away from.

**Suggested direction (not verified as a full fix, offered for triage):** at
minimum, `completeOrganisationSwitch` could revoke *all* not-yet-expired
`ledger_target_sessions` rows for the installation (not just
`source_target_session_hash`) when `changed=true`, trading away the "independent
concurrent conversation" property for correctness of "a switch this
conversation/installation performed always retires every other outstanding pin it
held." If the concurrent-conversation property is intentionally required, the
alternative is to have `resolveLedgerTargetSession` additionally return whether
`bindingId`/`connectionId` still equals the installation's row in
`oauth_installation_active_bindings`, and have `caseBinding()`/`prepare()`/`execute()`
fail closed (or clearly flag) when a write is attempted through a target session
that is no longer the installation's current one.

## Areas reviewed and found sound (compensating controls confirmed)

The brief's other hunt items were checked in comparable depth and traced to real,
load-bearing controls; no further findings are reported for them because I could
not construct a working bypass:

- **Permit / idempotency-key = durable `mutationRequestId`:**
  `src/security/xeroProviderWritePermitContext.ts:35-53` throws `FORBIDDEN`
  (`PROVIDER_IDEMPOTENCY_KEY_MISMATCH`) unless `providerIdempotencyKey ===
  mutationRequestId` exactly, and `src/providers/xeroProvider.ts:1376,1508` always
  pass `mutationRequestId` through as the idempotency key sent to Xero
  (`providerIdempotencyKey = mutationRequestId ?? idempotencyKey`, and
  `mutationRequestId` is always supplied on the accounting-case path). The permit
  itself (`src/control-kernel/ledgerProviderWritePermit.ts`) is a WeakMap-backed,
  process-local, one-shot object; `consumeLedgerProviderWritePermit` flips
  `consumed=true` before comparing claims, so even a mismatched first presentation
  poisons the permit and cannot be retried. Consumption happens in
  `XeroClientManager.#withFullClient` (`xeroClientManager.ts:396-409`) — after
  connection re-resolution but strictly before token refresh/decrypt or any
  provider network I/O.
- **`OUTCOME_UNKNOWN` / lost-response cannot silently double-create:**
  `accountingService.ts` `#createDraftSupplierBill`/`#createDraftSalesInvoice`
  (around lines 1584-1704) route every failure path after the provider boundary
  through `markDraftWriteUnknown`/`WRITE_RESULT_UNKNOWN` and explicitly refuse a
  second create ("no second create is allowed" — line ~1691/1694, 1676-1687); the
  durable posting/mutation-request row is keyed so a replay with the same
  `request_id`/payload hash returns the existing record
  (`#resolveExistingDraftRequest`) instead of writing again.
- **Bounded native-idempotency recovery cannot be re-entered:**
  `xeroMutationService.ts:627-632` explicitly throws `CONFLICT`
  (`RECOVERY_REPLAY_ALREADY_CONSUMED`) if `request.nativeRecoveryClaim !==
  undefined || request.writeReceipt` — the claim is durable and CAS-guarded
  (`markXeroMutationWriteUnknown` with `nativeRecoveryClaim`, enforced further by
  `migrations/040_xero_native_idempotency_recovery_claim.sql`'s partial unique
  index), and the window itself is bounded by
  `XERO_NATIVE_IDEMPOTENCY_RECOVERY_WINDOW_MS` measured from the original
  `writeStartedAt` (`xeroMutationService.ts:661-690`), not extendable by retrying.
- **`READBACK_VERIFIED` requires an economics-comparing readback, atomically:**
  `src/control-kernel/accountingCaseReadbackValidator.ts` compares net/tax/gross
  per line (as exact `bigint` fixed-4 values) and per-line account/tax binding
  hashes between the compiled Case and the provider's returned document/credit-note
  evidence. Critically, this isn't just advisory: `projectAccountingCaseOperationFromMutation`
  in `postgresRepository.ts:8336-8364` (and the in-memory twin,
  `inMemoryRepository.ts:4844`) re-runs `validateXeroAccountingCaseReadbackEconomics`
  *inside* the same transaction that would set the operation to `READBACK_VERIFIED`,
  and downgrades to `READBACK_MISMATCH` if it fails — a state a false success
  cannot silently pass through.
- **Monetary correctness:** `src/control-kernel/accountingMonetary.ts` does all
  arithmetic in `bigint` at a fixed 4-decimal scale with explicit HALF_UP rounding
  (`roundHalfUp`, lines 35-43) — no floating point anywhere in the amount path I
  traced (compiler → bridge → readback validator).
- **Client-supplied server-owned fields:** the public intake schema
  (`src/mcp/xeroAccountingCaseBusinessIntake.ts`) has no field for Xero account
  ID/code, tax type, provider object ID, route, or tenant — only
  `accounting_category`/`tax_class` enums and source-declared amounts/dates. The
  actual Xero `accountId`/`accountCode`/`taxType` are resolved server-side in
  `#prepareNativeDocumentOperation` (`xeroAccountingCaseService.ts:3403-3512`)
  against a sealed, hash-verified tenant COA profile
  (`sealedCategory`/`providerBinding` cross-checks at lines 3444-3460), not from
  client input.
- **Case-version integrity:** every entry point (`prepare`, `status`, `execute`)
  recomputes `accountingCasePlanHash(binding, compiled)` and compares it to the
  persisted `compiledPlanHash` before doing anything else
  (e.g. `xeroAccountingCaseService.ts:1657-1661, 1712-1717, 1764-1769`), so a
  Case cannot be executed against a plan that differs from what was compiled and
  validated at `prepare()` time.

## Notes on verification approach

For Finding 1 I did not just read the code path; I ran the existing unit test that
already encodes this exact scenario end-to-end
(`npx vitest run tests/ledger-target-session-service.test.ts`, 4/4 passed) to
confirm the behaviour is real and present in the shipped v0.4.0-rc.1 code, not a
theoretical reading-order mistake on my part. I did not have a live Postgres
instance available to also run the integration twin
(`tests/postgres-ledger-target-session.integration.test.ts`, requires
`TEST_DATABASE_URL`), but its SQL is identical in substance to the code path I
read directly in `postgresRepository.ts`, and the in-memory repository
(`inMemoryRepository.ts`) implements the same non-check independently, so this is
not an artifact of one repository implementation.

I did not find, and am not reporting, any issue in: the OAuth-installation/tenant
tuple isolation between *different* installations (already covered by the prior
`SECURITY-REVIEW-AUTH-BOUNDARY.md` in this same `reviews/` directory), the
compiler's `expectedVersion`/optimistic-concurrency handling, or the
firm-governance/business-coordinate-authority schema validation in
`xeroBusinessCoordinateAuthority.ts` — all were read and appeared sound within the
scope of this review's time budget.
