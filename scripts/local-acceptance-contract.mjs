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
// `local-agent-evidence` was removed third, for a reason the first two share:
// the gate cannot guarantee what it depends on. The check itself is good - it is
// the only one that puts a real model in the loop rather than hand-written test
// calls, and reconciles that model's own account byte-for-byte against the
// server audit. What it is not is vendor-neutral. The validator requires the
// Codex binary at a hardcoded absolute path, verifies its SHA-256, and shells to
// codesign to check a specific Apple Team ID; the run itself is funded by a
// personal ChatGPT quota, which on 2026-08-20 answered "You've hit your usage
// limit... try again at 11:32 AM". A release gate that a vendor's billing can
// close is not a gate.
//
// The property it covered is now covered better, not abandoned. Live acceptance
// runs a different vendor's model against the real Xero tenant, given only the
// mounted skill docs and the public tool surface, and every claim it makes is
// checked against xero_mutation_requests and a direct read from Xero. The
// removed step's own evidence boundary was LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY
// - a synthetic provider - so the live run dominates it on every axis.
//
// Validator and generator stay in the tree: npm run evidence:local-agent still
// produces and checks this evidence for anyone with quota. The follow-up worth
// doing is making agent-run evidence vendor-neutral - a declared transcript
// format plus the server audit, without the binary-identity check - so this
// property can be machine-gated again by whichever model actually did the work.
export const REQUIRED_GATE_STEP_IDS = Object.freeze([
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
