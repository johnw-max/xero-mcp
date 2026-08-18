# XF-001 remediation evidence

Status: `FIXED_PENDING_REVIEW`

## Reproduced failure

The first integration attempt overloaded `writeReceipt` with the recovery claim. Independent regression execution produced three failures: known-ID read-only recovery attempted the wrong path, renewed-target read-only recovery was blocked, and successful no-ID replay skipped durable Provider evidence. That design was rejected.

## Current design

- Migration `040_xero_native_idempotency_recovery_claim.sql` stores `native_recovery_claim` independently from Provider `write_receipt`.
- A durable CAS permits at most one recovery claim for an exact `WRITE_UNCERTAIN`, no-object-ID mutation.
- The recovery window expires five minutes after the original durable `writeStartedAt`, not after the later unknown-result transition.
- Identity binds mutation, payload hash, action, adapter, tenant, actor, workspace, Agent, installation, binding revision, connection, target session and authority snapshot.
- Recovery re-evaluates current Provider capability, transport scope, target expiry, standing delegation, authority snapshot and write kill switch.
- The second Provider call uses the original deterministic Xero Idempotency-Key and a distinct one-shot `NATIVE_IDEMPOTENCY_RECOVERY` permit.
- Provider object ID and receipt are persisted before exact same-ID readback completion.

## Independent green run

```text
npm run typecheck
npx vitest run tests/xero-invoice-draft-one-time-confirmation.test.ts src/services/xeroMutationService.test.ts tests/ledger-provider-write-permit.test.ts tests/xero-provider-write-permit-boundary.test.ts tests/current-release-contract.test.ts tests/xero-native-idempotency-recovery-migration.test.ts tests/required-migrations-release-gate.test.ts tests/xero-release-attestation.test.ts tests/accounting-case-in-memory-repository-concurrency.test.ts tests/provider-write-recovery.test.ts
git diff --check
```

Result: typecheck PASS; 10 test files / 194 tests PASS; diff check PASS.

Covered negative conditions include exact five-minute expiry, concurrent claim contention, authority revision drift, current Provider capability denial, known-ID readback-only recovery, renewed-target readback-only recovery, and separation of recovery claim from Provider receipt.

## Remaining closure gates

- Run migration 040 and recovery CAS against an isolated PostgreSQL instance.
- Add the path to process/fault evidence and deployment-equivalent local Agent acceptance.
- Perform one controlled real Xero test-tenant DRAFT validation, including receipt and exact same-ID readback; a real transport-loss recovery may use a safe controlled fault shim rather than intentionally destabilising Xero.
- Independent reviewer must close the finding before Gate L.
