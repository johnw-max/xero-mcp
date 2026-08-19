// `independent-review-live` was removed: its command only ever printed a demand
// for an out-of-repository signing authority and exited 78, and it ran first in
// a fail-closed sequence, so no later step in this list was ever reached. The
// signing layer it waited on is gone (ADR-003); independence is now a procedural
// rule recorded in the manifest, not a step that can never pass.
export const REQUIRED_GATE_STEP_IDS = Object.freeze([
  "traceability-closed",
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
