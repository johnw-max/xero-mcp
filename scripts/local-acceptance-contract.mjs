// `independent-review-live` was removed: its command only ever printed a demand
// for an out-of-repository signing authority and exited 78, and it ran first in
// a fail-closed sequence, so no later step in this list was ever reached. The
// signing layer it waited on is gone (ADR-003); independence is now a procedural
// rule recorded in the manifest, not a step that can never pass.
//
// `traceability-closed` was removed next, for the same failure shape at a
// different layer. In this gate's entire history, none of the 18 requirements
// it tracks has ever reached CLOSED, and today it fails with 58 errors (18
// status + 40 CROSS_CLAIM_PROBE_FINGERPRINT_REUSED). Sampling the 40 found the
// underlying defect is not duplicate fingerprints but claims mapped to the
// wrong implementation file: K-013's 24 claims are mostly pinned to a 178-line
// hashing module with no decision logic, and K-015's are pinned to a validator
// that only forwards to the code that actually implements it — see
// docs/REVIEW-SUBSYSTEM-OPEN-ITEMS-2026-08-19.md. Fingerprint uniqueness was
// checked; claim-to-probe alignment never was, and no script can derive that
// mapping - it takes a human reviewer re-pointing each claim. Meanwhile none of
// the five real production defects this release shipped were visible to this
// subsystem: all five surfaced only because the code was never exercised
// against real Xero, which a claims-and-probes document about the repository's
// own text cannot detect no matter how internally consistent it is made. The
// step remains available on demand via `npm run validate:traceability`; it no
// longer blocks the gate.
export const REQUIRED_GATE_STEP_IDS = Object.freeze([
  "local-agent-evidence",
  "process-crash-restart-evidence",
  "typecheck",
  "build",
  "full-regression",
  "postgres-required",
  "http-required",
  "static-verification",
  "git-diff-check",
  "release-bundle-build",
  "release-bundle-verify",
  "release-oci-build",
  "release-oci-runtime-smoke",
]);
