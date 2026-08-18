# Local runtime regression results

Date: 2026-08-18

## Product/runtime result

- `npm run typecheck`: PASS.
- The final focused authorization/idempotency/evidence-boundary set: 5 files / 110 tests PASS.
- Whole product/runtime suite with the experimental review framework and environment-gated PostgreSQL/loopback files excluded: 125 files / 1,354 tests PASS.
- Trial Balance transport plus read-only scenario runner, rerun outside the restricted loopback sandbox: 2 files / 12 tests PASS.
- OAuth HTTP edge loopback, rerun outside the restricted loopback sandbox: 1 file / 3 tests PASS.
- Required PostgreSQL gate on a fresh disposable PostgreSQL 16 database after the final authorization/idempotency/evidence changes: 16 files / 110 tests PASS. The container was stopped and automatically removed. See `POSTGRES-REQUIRED-GATE.md`.
- Real SIGKILL/restart evidence: four governed crash boundaries PASS and independently replayed. See `PROCESS-CRASH-RESULT.md`.
- `npm run build`, `git diff --check`, and `bash deploy/scripts/verify-static.sh`: PASS; the static verifier reports production deployment immutability PASS.

These results establish the deterministic local runtime and synthetic-provider business controls. They do not establish a current real-Xero write and do not establish Agent2 deployment.

## Whole-suite diagnostic

`npm test -- --maxWorkers=4` collected 146 files / 1,548 tests: 126 files passed, 16 PostgreSQL/HTTP files were conditionally skipped by that generic command, and 4 files failed.

The failures were classified rather than hidden:

- 12 loopback failures were sandbox EPERM; the same exact tests passed 12/12 with local-loopback permission.
- 14 independent-review failures were the default 5-second fixture timeout and passed with one worker and a 60-second timeout.
- 8 failures remain in the experimental independent-review framework: one oversized PNG semantic unit, three outside-repository fixture references, one missing fixture TypeScript runtime identity, and three validation-order/error-taxonomy mismatches.
- The current 18-requirement/90-claim traceability artifact has 57 cross-claim probe-fingerprint reuse errors across 11 duplicate groups.

The last two bullets are recorded as XF-011 and are explicitly NOT PASS. They are non-runtime governance-tool debt and are not used to claim Xero business acceptance. Per the external feedback that governance has advanced faster than the real product loop, XF-011 is deferred from the Agent2 test-environment release Gate; runtime tenant/scope/authority/idempotency/receipt/readback/source-image audits remain blocking.

## Remaining blocking evidence

1. Current candidate against a dedicated real Xero test Organisation: one DRAFT, Provider object ID, receipt, same-ID readback and duplicate zero-new.
2. Deployment-equivalent local Luna/xhigh natural-language chain with mandatory Skill loading, zero schema repair and the final source/tool contract identity.
3. Current candidate source/image freeze and bounded independent review of runtime P0/P1 changes.
4. Exact same image on Agent2 and one minimal natural-language vertical UAT.
