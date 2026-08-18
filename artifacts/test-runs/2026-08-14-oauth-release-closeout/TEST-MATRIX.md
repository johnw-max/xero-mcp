# OAuth release closeout test matrix

## Acceptance contract

- Outcome: deploy the current Xero MCP candidate to an isolated Hetzner green slot and prove Agent2 and Work can complete OAuth, bind the intended Xero organisation, and execute a read-only organisation read-back.
- In scope: current repository candidate, MCP OAuth broker, immutable build/admission checks, green-slot health/readiness, Agent2, Work, and Xero read-only organisation evidence.
- Non-goals: production write enablement, autonomous accounting writes, provider mutations, Nginx production cutover before green acceptance, or changes to the Work/LibreChat codebase.
- Hard failures: any release gate failure; any skipped required test; write mode not exactly false; wrong tenant/organisation; OAuth callback failure; missing MCP tool receipt; readiness failure; secret leakage; or unexplained deployment identity mismatch.
- Pass: local release gates pass, green slot is admitted with writes disabled, both Hosts reconnect, and each returns the expected organisation through the candidate MCP.
- Safe stop: retain blue production traffic and do not commit/push when any hard failure remains.

## Cases

| Case | Risk | Required evidence | Result |
|---|---|---|---|
| LOCAL-OAUTH-01 | Work resource compatibility incorrectly enables manual return | Direct-302 Work regression and independent Agent2 manual-return regression | PASS — OAuth focused groups 164/164 |
| LOCAL-RELEASE-01 | Current large candidate contains an unrelated release regression | Required tests, PostgreSQL integration, HTTP loopback, typecheck, build, static/security checks | PRODUCT PASS / RELEASE AUTHORITY FAIL — post-pause exact snapshot: 1,329 ordinary tests plus 15 loopback/transport tests PASS (1,344 total); fresh required PostgreSQL 107/107; exact local-filesystem snapshot typecheck/build/static pass; traceability remains 18/18 OPEN and the validator rejects repeated probe mappings |
| GREEN-ADMISSION-01 | Unaccepted bytes or mutable image reaches Hetzner | Immutable image and admission receipt; green health/readiness; writes false | LOCAL OCI PASS / HOST ADMISSION BLOCKED — current-byte source bundle is byte-identical to the runtime-smoked OCI; repo-local Gate still deliberately exits 78 without an out-of-repository signed reviewer attestation, and no production admission bypass was used |
| LIVE-BASELINE-01 | The chosen validation origin is unavailable or has broken discovery/CORS | healthz, readyz, both OAuth metadata documents, unauthenticated MCP challenge, Agent2/Work CORS | PASS FOR DEPLOYED 0.3.1 BASELINE — all endpoints returned the expected 200/204/401 classes; this does not validate the local 0.4.0-rc.1 fix |
| OAUTH-AGENT2-01 | Agent2 OAuth regresses after return-policy split | Connected state plus Xero organisation read-back | BLOCKED — candidate 0.4.0-rc.1 is not deployed to the validation origin |
| OAUTH-WORK-01 | Work loses login/session or rejects MCP callback | Connected state plus Xero organisation read-back; final callback URL captured without secrets | BLOCKED — candidate 0.4.0-rc.1 is not deployed; Work codebase remains out of scope |
| ISOLATION-01 | One Host or installation overwrites the other | Both read-backs remain valid after the second connection | NOT RUN — candidate not admitted/deployed |
