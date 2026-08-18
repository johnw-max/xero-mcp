# PostgreSQL required gate

- Date: 2026-08-18 (Asia/Shanghai workspace date)
- Database boundary: disposable local PostgreSQL 16 container `xero-mcp-uat-pg-20260818`; test database `xero_mcp_test_20260818`; loopback port 55441.
- Safety behavior: the first attempt against `xero_mcp_uat_20260818` was correctly rejected as `TEST_DATABASE_URL_UNSAFE`; the guard was not bypassed. A fresh database matching `xero_mcp_test_*` was created in the same disposable container.
- Command class: `npm run test:postgres:required`, `--maxWorkers=1`.
- Initial result before the dedicated migration-040 test: **PASS** — 15 test files, 109 tests, duration 35.10 seconds.
- Added migration-040 evidence: a real PostgreSQL test proves `native_recovery_claim` remains independent of `write_receipt`, two concurrent claims yield one winner and one `CONFLICT`, and the database rejects embedding the claim in `write_receipt` with constraint code `23514`.
- Repeatability finding: the first 110-test rerun on the reused database found one historical fixed CONTACT object fixture. After replacing it with a per-suite UUID, the targeted 26 tests passed on the already-dirty database.
- Final repeatability result: **PASS twice consecutively on the same reused database** — 16 files, 110 tests; 33.56 seconds and 33.18 seconds.
- Covered suites: OAuth identity and Broker flow, organisation-switch governance, target sessions, authority snapshots, source evidence, duplicate guards, provenance, mutation foundation, Accounting Case PostgreSQL repository, economic-readback migration, business-reservation migration, continuation migration, and ledger-authority migration.
- Limitation: this gate uses local PostgreSQL and synthetic/provider-neutral fixtures. It does not prove Agent2, live OAuth or a real Xero tenant.
