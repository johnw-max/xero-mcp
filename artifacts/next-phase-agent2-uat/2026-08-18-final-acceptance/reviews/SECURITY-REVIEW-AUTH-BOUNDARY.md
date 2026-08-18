# Security Review: Authorization, Tenant-Isolation & Secret-Handling Boundary

**Repo:** `xero-mcp-repo` (Xero Accounting MCP server, v0.4.0-rc.1)
**Target deployment:** `https://mcp.jiayuanwang.xyz` (test environment)
**Review type:** Read-only source review (no writes, no mutating git commands)
**Reviewer date:** 2026-08-18

## Scope and method

Read, in full or in relevant part, and followed the call graph outward from:

- `src/oauth/` (all files): `mcpOAuthBrokerProvider.ts`, `mcpOAuthTokenService.ts`,
  `mcpOAuthRouter.ts`, `clientAuthentication.ts`, `brokerXeroAuthorizationService.ts`,
  `brokerCookies.ts`, `brokerResource.ts`, `brokerPages.ts`, `staticOAuthClientsStore.ts`,
  `xeroAuthenticationEvent.ts`, `xeroOAuthService.ts`
- `src/http/app.ts` (full route wiring, CORS, `/healthz`, `/readyz`)
- `src/security/` (all files): `hash.ts`, `tokenCipher.ts`, `oauthSecrets.ts`,
  `requestContext.ts`, `xeroProviderWritePermit.ts`, `xeroProviderWritePermitContext.ts`,
  `ledgerTargetReference.ts`
- `src/providers/xeroClientManager.ts` (token refresh, scope revalidation, client
  construction — confirmed there is **no** cross-request client/token cache)
- `src/config.ts` (secret/key validation, write-gate fail-closed logic)
- `src/control-kernel/ledgerControlKernel.ts` and `ledgerProviderWritePermit.ts`
  (standing-delegation evaluation, one-shot write permits)
- `src/db/postgresRepository.ts` — the specific methods that back every identity/tenant
  resolution and OAuth token operation (`resolveAgentConnectionBinding`,
  `resolveLedgerTargetSession`, `getProviderAuthorization`,
  `listActiveConnectionsByAuthorization`, `updateProviderAuthorizationToken`,
  `peekOAuthAuthorizationCodeForExchange` / `exchangeOAuthAuthorizationCodeForTokenSet`,
  `peekMcpRefreshTokenContext` / `rotateMcpRefreshTokenAndIssueAccessToken`,
  `resolveMcpAccessToken`, `revokeOAuthTokenForClient`)
- `src/services/ledgerTargetSessionService.ts`, `src/services/organisationSwitchService.ts`
- `src/providers/xeroScopes.ts`, `src/policy/xeroAutonomousActions.ts`
- `src/mcp/createServer.ts`, `src/mcp/xeroFailureEnvelope.ts`, `src/mcp/toolNames.ts`
- `src/logging.ts`, `src/errors.ts`, `src/governance/governanceAudit.ts`
- Deployment artifacts actually shipped for this host: `deploy/env.vps.example`,
  `deploy/host-nginx/mcp.jiayuanwang.xyz`, `deploy/Dockerfile`

Also ran the existing unit suites for the areas most load-bearing to this review
(`tests/xero-client-manager.test.ts`, `tests/mcp-oauth-broker-provider.test.ts`,
`tests/mcp-oauth-token-service.test.ts` — 38/38 passing), and grepped the full
`src/` tree for `AppError(...)` call sites that interpolate anything token/secret/
cipher/key/password/cookie/credential-shaped, to check what a caller-visible error
`message` could ever contain.

## Result summary

| Severity | Count |
|---|---|
| P0 (cross-tenant leak, secret disclosure, auth bypass) | **0** |
| P1 (weakened control) | **0** |
| P2 (hardening) | **4** |

No P0 or P1 defect was found and confirmed against the code. This codebase is
unusually defensive for every one of the specific attack scenarios requested in
the brief; the sections below name the exact compensating control for each, and
the P2 list at the end covers the residual hardening opportunities that are real
but not currently exploitable.

Operationally relevant context: the shipped config for this host
(`deploy/env.vps.example`) sets `XERO_WRITE_ENABLED=false`, `MCP_OAUTH_BROKER_ENABLED=true`,
`PERSONAL_POC_ONLY=true`, `SHARED_TEST_USERS=true`. The write-gate / standing-delegation
code paths were reviewed as requested (they ship in the binary and will be turned on
later), but are **not live** on first cutover — read-only OAuth is the only active
provider-mutating-capable surface, and even that surface issues drafts only when writes
are later enabled.

---

## 1. Cross-tenant / cross-installation leakage

**Finding: none.** `src/providers/xeroClientManager.ts` holds no cache of Xero
clients, tokens, or connections across calls — `#createClient` (line 584) is
invoked fresh inside every `#withFullClient` call and always decrypts the token
ciphertext read from the DB row that was just re-resolved via
`resolveConnection()` (line 236). The only class-level state is `#refreshMutex`
(`KeyedMutex`, line 188), a `Promise`-chain gate keyed by `authorizationId`
(OAuth) or `connectionId` (legacy) — it serializes concurrent refreshes for the
same authorization, it does not store or hand back client/token objects, so it
cannot serve one installation's client to another.

Every repository method that resolves identity, a binding, a connection, a
target session, or a token requires the **full** tuple
`(workspaceId, subjectType, subjectId, agentId, installationId, bindingId,
connectionId)` in its `WHERE`/`JOIN` clause — confirmed by direct reading of
`resolveAgentConnectionBinding` (postgresRepository.ts:2449‑2492),
`resolveLedgerTargetSession` (postgresRepository.ts:2941‑2989),
`getProviderAuthorization` (2216‑2227), `listActiveConnectionsByAuthorization`
(2329‑2346), `resolveMcpAccessToken` (4090‑4156), and
`peekMcpRefreshTokenContext` / `rotateMcpRefreshTokenAndIssueAccessToken`
(4254‑4797). `XeroClientManager.resolveConnection` (xeroClientManager.ts:236‑367)
additionally re-derives `exactConnections` by filtering on
`connection.connectionId === context.connectionId && ... && connection.tenantId
=== binding.tenantId` (line 323‑328) and requires exactly one match, so even a
same-authorization multi-tenant grant cannot silently resolve to the wrong
tenant.

## 2. Token handling (refresh, rotation, reuse, race)

**Finding: none.**

- Refresh-token rotation is one-shot with reuse (replay) detection:
  `rotateMcpRefreshTokenAndIssueAccessToken` (postgresRepository.ts:4439‑4797)
  runs inside a row-locked transaction (`FOR UPDATE`, line 4492) and, on
  detecting `row.consumed_at` already set for a token being replayed
  (line 4599‑4687), revokes the **entire refresh-token family**
  (`#revokeMcpRefreshGrant`) rather than merely rejecting the one request —
  this is fail-closed against a stolen-refresh-token race.
- A short (`MCP_OAUTH_REFRESH_RETRY_GRACE_MS`) idempotent-retry window lets a
  client that dropped a response replay the *same* rotation and get back a
  byte-identical response (`retry_response_ciphertext`, verified against
  stored hashes at `mcpOAuthTokenService.ts:488‑526`), rather than minting a
  second live token pair — this specifically prevents a legitimate retry race
  from being misclassified as a theft (and vice versa).
- **A raced refresh cannot resurrect a revoked token.**
  `XeroClientManager.#recoverOAuthRefreshRace` (xeroClientManager.ts:641‑662)
  only accepts a concurrently-refreshed authorization if the freshly re-read
  row has `status === "ACTIVE"`, a strictly newer `refreshVersion`, and
  `tokenExpiresAt` still valid — a revoked/expired row fails all three and
  falls through to `#throwRefreshFailure`.
- **Scopes are re-validated against the broker after refresh, before any
  provider action.** `#withFullClient` (xeroClientManager.ts:386‑535) sets
  `refreshedOAuthToken = true` on both the normal-refresh and the race-recovery
  path, and after the `try/catch` block, before calling `action(client,
  resolved.connection)` (line 529‑530), it unconditionally calls
  `#assertRefreshedOAuthScopes` (line 525‑527) which throws `SCOPE_MISSING`
  if the refreshed grant no longer covers the scopes the *current MCP request*
  needs (line 615‑639). **If the broker returns fewer scopes than before,**
  this throws before any Xero API call — fails closed, not silently downgraded.

## 3. Authorization-code / PKCE / redirect-URI / state / cookies

**Finding: none.**

- Redirect URIs are validated at config load (`config.ts:249‑274`) to be
  absolute HTTPS, no wildcard, no userinfo, no fragment, no control characters,
  and must exactly match a pre-registered `redirect_uris` entry
  (`mcpOAuthBrokerProvider.ts:796‑799`, `mcpOAuthTokenService.ts:439‑442`).
  The authorization code is bound to the **exact** `redirect_uri` used at
  `/authorize` time and this is enforced again, inside the same DB transaction
  that consumes the code, in `exchangeOAuthAuthorizationCodeForTokenSet`
  (postgresRepository.ts:3898‑3905) — a code cannot be redeemed against a
  different (even if also pre-registered) redirect URI.
- PKCE is S256-only (`EXACT_PKCE_CHALLENGE` regex,
  `mcpOAuthBrokerProvider.ts:54,348`) and the verifier→challenge comparison at
  exchange time is done server-side via `pkceS256Challenge` compared against
  the value stored at issuance (`mcpOAuthTokenService.ts:162‑168`); the SDK's
  own (non-constant-time) PKCE check is explicitly disabled
  (`skipLocalPkceValidation = true`, line 294) in favor of this storage-bound
  comparison.
- Authorization-code replay is impossible: consumption is
  `UPDATE ... WHERE consumed_at IS NULL ... RETURNING *` inside a
  `FOR UPDATE` transaction (postgresRepository.ts:4003‑4011), and a second
  concurrent redemption attempt hits `CONFLICT`.
- Host `state` is bound via a domain-separated HMAC hash
  (`outerStateHash`, `oauthSecrets.ts:22‑34`) plus an encrypted copy
  (AES-256-GCM, AAD = `flowHash`) that is decrypted and re-verified with
  `safeEqual` before every redirect back to the Host
  (`mcpOAuthBrokerProvider.ts:743‑749`, `801‑807`) — this also covers the
  Xero-side `xero_state` (separately hashed and checked at
  `handleXeroCallback`, lines 464‑487).
- Open redirect: the only redirect target ever used
  (`hostRedirect`, line 218‑227) is `result.flow.redirectUri`, which was
  validated against the pre-registered exact allowlist at `/authorize` time
  (`#isExactRegisteredRedirect`, line 796‑799) and never re-derived from
  request input afterward. The manual-return page additionally re-validates
  the URL is HTTPS, credential-free, fragment-free, and carries exactly one
  `code`+`state` pair (`brokerPages.ts:96‑122`).
- Cookies: the browser-flow cookie is `__Host-`-prefixed
  (`brokerCookies.ts:1`), which by browser enforcement requires `Secure`,
  `Path=/`, and forbids a `Domain` attribute; it is also set `httpOnly`,
  `sameSite: "lax"` (line 3‑11). `readExactCookie` (line 22‑37) explicitly
  rejects duplicate/malformed cookie values rather than taking an
  attacker-chosen first/last match. CSRF on the organisation-selection POST
  is checked via a `selectionCsrfHash` bound into an encrypted, one-time
  ticket, plus an Origin/`Sec-Fetch-*` metadata check
  (`classifyBrokerBrowserOrigin` / `classifyBrokerFetchMetadata`,
  lines 148‑190) that only relaxes for a `null` Origin when
  `personalPocOnly` is true **and** Fetch metadata is not a mismatch.

## 4. Secret exposure (logs, errors, `/healthz`, audit)

**Finding: none exploitable; see P2‑4 for one residual, currently-inert gap.**

- `src/logging.ts` uses an **allowlist**, not a blocklist, for structured
  log context keys (`safeContextKeys`, lines 12‑37) — any key not on the list
  is replaced with `"[REDACTED]"` (line 47‑61), and free-text log messages are
  additionally regex-scrubbed for `SECRET|TOKEN|PASSWORD|CREDENTIAL`,
  `Bearer <token>`, and `code=`/`token=`/`secret=` query fragments
  (`scrubMessage`, lines 39‑45).
- `src/mcp/xeroFailureEnvelope.ts` projects every MCP tool failure through
  allowlists for `failure_layer` (`SAFE_FAILURE_LAYERS`), `recovery_action`
  (`SAFE_RECOVERY_ACTIONS`), and `reason_codes` (`SAFE_REASON_CODES` /
  `SAFE_REASON_PREFIXES`) — provider bodies, tokens, and raw target
  references are never in these sets, so they cannot reach an Agent-visible
  error.
- All persisted governance-audit evidence is validated by
  `assertGovernanceAuditEventInput` (`governanceAudit.ts:28‑47`), which
  recursively rejects any evidence object containing a key matching
  `/(^|_)(access_token|refresh_token|oauth_token|token|secret|password|
  prompt|chain_of_thought)(_|$)/i` (line 6) — a secret value can never be
  written into the audit trail through this path.
- Token ciphertext uses AES‑256‑GCM with the AAD bound to the owning
  `authorizationId`/`connectionId` (`tokenCipher.ts:21‑28`,
  `xeroClientManager.ts:593‑598`), which prevents ciphertext-substitution
  across records even if two rows were somehow swapped.
- `/healthz` and `/readyz` (`http/app.ts:629‑738`) are intentionally
  unauthenticated but expose only hashes, booleans, and revision numbers
  (`toolsetHash`, `attestationHash`, `authoritySnapshotHash`, etc.) — no
  client secret, token, or tenant credential is present in either payload.
- I grepped every `new AppError(...)` call site in `src/` (excluding tests)
  for template-literal interpolation of anything token/secret/cipher/key/
  password/cookie/credential-shaped; there were zero matches. Every
  `AppError` message I sampled that does interpolate a variable does so with
  workflow-state names, line indices, or account codes — not secret material.
  Non-`AppError` exceptions never reach a client: `toSafeError`
  (`errors.ts:56‑66`) replaces any non-`AppError` with a generic
  `"The upstream accounting request failed."` message, so an unexpected
  internal exception (stack trace, driver error text, etc.) cannot leak
  through the HTTP or MCP error envelope. See P2‑4 for the one design gap
  this still leaves open.

## 5. Public MCP surface (auth, audience, per-call enforcement)

**Finding: none.** `/mcp` is wired (`http/app.ts:743‑775`) behind
`requireBearerAuth({ verifier: mcpOAuthProvider, ... })` followed by
`requireAnyVerifiedMcpScope(...)`, both **Express middleware that run on every
HTTP request** to `/mcp` — the server intentionally builds a brand-new
`McpServer` + stateless `StreamableHTTPServerTransport()` per POST
(`http/app.ts:776‑800`), so there is no persistent MCP session that could
bypass re-authentication or re-authorization on a later call. Audience is
enforced twice: once inside the DB-backed `resolveMcpAccessToken` query
(`resource = $2 AND audience = $3`, postgresRepository.ts:4114‑4116) and again
in `createOAuthRequestContextFromAuthInfo`
(`requestContext.ts:253‑257`, `authInfo.resource?.href !== expectedAudience`
→ 401). Every registered tool additionally re-checks its own required scope
inside `runAudited` (`createServer.ts:212‑228`) against the resolved
per-request context, not a cached value. `TOOL_ALLOWLIST`
(`mcp/toolNames.ts`) contains only the 28 documented accounting tools — no
debug/admin tool is registered on the production path (the one unsafe legacy
test toggle, `unsafeExposeLegacyObjectMutationToolsForTests`, is never passed
by `http/app.ts`'s call to `createAccountingMcpServer`, and additionally
throws outside `NODE_ENV=test` if it were — `createServer.ts:288‑293`).

## 6. Write gate / standing delegation

**Finding: none.** `evaluateAutonomousLedgerWrite`
(`ledgerControlKernel.ts:360‑452`) is fail-closed by construction: an empty
`standingDelegations` array (or one where nothing matches the
provider/workspace/agent/tenant/action tuple) adds `STANDING_DELEGATION_MISSING`
to `denyReasons` (line 393‑395) and the function only returns `allowed: true`
when `denyReasons.length === 0` **and** exactly one exact delegation matched
(line 430‑451) — an ambiguous match (more than one delegation covering the
same exact tenant+action) is explicitly denied as
`STANDING_DELEGATION_AMBIGUOUS` (line 404‑408) rather than picked
permissively. `config.ts` additionally requires, at process startup, that
`XERO_WRITE_ENABLED=true` implies at least one `ACTIVE` standing delegation
(line 698‑705), an explicit `XERO_AUTHORITY_REVISION` plus three
matching config-integrity hashes (line 688‑714), and that every tenant named
by an active delegation has a configured COA profile (line 715‑728) — a
misconfigured or partially-empty delegation set fails **process startup**,
not just the individual write. The one-shot `LedgerProviderWritePermit`
(`ledgerProviderWritePermit.ts`) is consumed at
`consumeXeroProviderWritePermitAtMutationBoundary`
(`xeroProviderWritePermitContext.ts:25‑97`), which is called from inside
`XeroClientManager.#withFullClient` (`xeroClientManager.ts:396‑409`) — i.e.
**before** client construction, token decrypt, refresh, or any Provider I/O —
and every mutation provider (`xeroContactItemMutationProvider.ts`,
`xeroControlledMutationProvider.ts`, `xeroCreditNoteManualJournalProvider.ts`,
`xeroProvider.ts`) reaches Xero exclusively through this single choke point
(`withWriteClient`), so there is no per-provider code path that could skip
permit consumption. The permit's claims are matched field-by-field
(`mismatchReason`, `ledgerProviderWritePermit.ts:362‑381`) against the
*exact* tenant, actor, workspace, agent, installation, binding, connection,
and target-session IDs of the request that is about to execute — a permit
issued for one installation/tenant cannot be replayed against another.

---

## P2 — hardening observations (not currently exploitable)

1. **Dead-code wildcard-installation match path in standing-delegation
   matching.**
   `src/control-kernel/ledgerControlKernel.ts:249` —
   `matchingSubject` treats `delegation.installationId === undefined` as "matches
   any installation" for the workspace/agent. The `LedgerStandingDelegation`
   TypeScript interface (`ledgerControlKernel.ts:131`) marks `installationId`
   optional, but the only production source of delegations,
   `xeroStandingDelegationRecordSchema` in `src/config.ts:144‑155`, requires
   `installation_id` (`z.string().trim().min(1).max(255)`, not `.optional()`),
   so this branch is unreachable today. Recommend either dropping the
   `undefined` branch or making the type non-optional to prevent a future
   second authority source (e.g. a firm-governance import path) from
   accidentally granting a delegation that matches every installation under a
   workspace/agent.

2. **Legacy/rollback cookies gate `Secure` on `NODE_ENV` instead of being
   unconditional.**
   `src/http/app.ts:120‑128` (`reviewCookieOptions`) and `src/http/app.ts:833‑839`
   (`OAUTH_COOKIE`) set `secure: config.nodeEnv === "production"`. These are
   only used on the legacy shared-bearer / non-broker OAuth path
   (`MCP_OAUTH_BROKER_ENABLED=false`), which is not the path enabled for
   `mcp.jiayuanwang.xyz` today, and the primary Broker flow cookie is
   `__Host-`-prefixed and therefore unconditionally `Secure` regardless of
   `NODE_ENV` (`src/oauth/brokerCookies.ts:1‑11`). Still, if this rollback
   path is ever exercised with `NODE_ENV` misconfigured (e.g. left at
   `development` on a real host), the cookie would be sent without `Secure`.
   Recommend hard-coding `secure: true` for both, matching the Broker cookie.

3. **Infra-layer rewrite of the `/authorize` query string for one
   hardcoded client.**
   `deploy/host-nginx/mcp.jiayuanwang.xyz:13‑16` maps
   `"agent2-xero-bd0796db041ee01e:"` (client_id with empty
   `code_challenge_method`) to append `&code_challenge_method=S256` before
   proxying to the app. This is inert with respect to the actual security
   guarantee — the broker never reads `params.codeChallengeMethod` and always
   stores `"S256"` server-side regardless (`mcpOAuthBrokerProvider.ts:379`),
   and `EXACT_PKCE_CHALLENGE` still requires a real 43-char S256 challenge
   value from the client (line 348) — but having infrastructure mutate an
   OAuth authorization request based on a string-matched client_id is fragile
   or fragile-adjacent: a typo'd/broadened match string, or reuse of this
   pattern for a future client, would silently paper over a client bug rather
   than surfacing it. Recommend making the server accept a missing/absent
   `code_challenge_method` explicitly (since it never trusts the field
   anyway) and removing the nginx rewrite.

4. **`xeroMcpFailureEnvelope`'s `error.message` field is not allowlisted,
   unlike every other field in the same envelope.**
   `src/mcp/xeroFailureEnvelope.ts:198‑215` returns `message: safe.message`
   straight from the `AppError` with no filtering, while `failure_layer`,
   `recovery_action`, and `reason_codes` in the same object are all
   allowlist-checked (lines 58‑123). A full-repo grep found no current
   `AppError(...)` call site that interpolates token/secret/cipher/key/
   password/cookie/credential-shaped data into its message (see §4 above),
   and non-`AppError` exceptions are already normalized to a generic message
   by `toSafeError` (`errors.ts:56‑66`), so there is no live leak today. But
   because `message` is the one field in this envelope that isn't
   allowlisted, a future `AppError` call site that interpolates something
   more dynamic (a raw DB error string, a provider response fragment) would
   flow straight to the untrusted MCP caller with no filter. Recommend either
   allowlisting `message` against a fixed catalog per `AppErrorCode`
   (mirroring `DEFAULT_FAILURE_PROJECTION`) or adding a lint/test rule that
   fails if any `AppError(...)` message contains a template expression.

---

## Notes on verification approach

Every finding above was checked against the actual implementation, not the
comments/docstrings describing intent (the codebase's docstrings are accurate
in every case sampled, which is itself somewhat unusual). Where the brief's
hunted-for failure mode had an obvious point where it *could* have gone wrong
(e.g., "does the client-manager cache serve one installation's client to
another," "can a raced refresh resurrect a revoked token," "is the resource
check enforced on every `/mcp` call or only at session start"), I traced the
exact code path and confirmed the compensating control by line reference
rather than inferring it from naming or comments alone.
