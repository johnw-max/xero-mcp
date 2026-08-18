# Release Bundle / OCI Artifact Feasibility Investigation

Date: 2026-08-18
Scope: Can steps 12–15 of `scripts/release/run-local-acceptance-gate.mjs`
(`release-bundle-build`, `release-bundle-verify`, `release-oci-build`,
`release-oci-runtime-smoke`) actually produce a release bundle and OCI
artifact from this worktree, given that step 1 (`independent-review-live`)
always fails locally by design and the full gate therefore never reaches
them?

This is a **feasibility investigation only**. No source, test, script,
config, or migration file was modified. All commands below were run with
output redirected to the scratchpad directory
(`/private/tmp/claude-501/-Users-jiayuanwang-Documents-Workflow---accounting/b60f4649-69dc-429a-88fa-a41a55fb82f3/scratchpad/release-bundle/`),
never into the repo's own `artifacts/release/` directory, and no git state
was changed.

## Why step 1 always fails locally (context, not re-litigated here)

`scripts/review/require-host-independent-review-attestation.mjs` unconditionally
writes:

```
"status": "LOCAL_EVIDENCE_UNTRUSTED"
"reason": "A candidate-repository driver and verifier cannot authenticate
their own reviewer process provenance."
"required_authority": "An out-of-repository pinned parent driver must
capture the immutable inputs, spawn the signed reviewer, verify the raw
lifecycle, and sign a receipt with a host-held key. No such authority is
available to this repo-local Gate."
```

and exits `78`. This is a structural, intentional refusal (self-attestation
is disallowed), not a bug to fix from inside the repo — confirmed, not
re-investigated further here.

## The `--approved-control-catalog-sha256` value

This digest is threaded through every one of the four downstream steps.
`scripts/review/traceability-validator-lib.mjs` (`validateControlCatalog`,
~line 165) shows it is checked against the **actual bytes of the file named
in `requirements-traceability.json`'s `control_catalog.path`**, which is:

```
artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json
  → control_catalog.path   = "schemas/ledger-control-clauses.v1.json"
  → control_catalog.sha256 = e488e6ed4cdbe665f214a65ce9d55d42ce1ac3adf54e77317078bb0ec7209fbe
```

Verified: `shasum -a 256 schemas/ledger-control-clauses.v1.json` reproduces
that exact digest — the traceability document's recorded hash and the file's
current bytes agree.

**Verdict on this value: repo-derivable, not a host-operator secret.**
`build-xero-release-bundle.mjs`, `verify-xero-release-bundle.mjs`,
`build-accepted-oci-image.mjs`, and `smoke-accepted-oci-runtime.mjs` only
check that the value is syntactically a 64-hex-char string and that it is
*self-consistent* across the build identity / manifest / receipt they
produce — none of them independently re-validate it against
`schemas/ledger-control-clauses.v1.json`. Conceptually the value is meant to
represent a host reviewer's sign-off (see
`deploy/HETZNER-HOST-NGINX-RUNBOOK.md:104`, "host reviewer 单独批准的
XERO_APPROVED_CONTROL_CATALOG_SHA256 写入", and
`scripts/approved-local-builder-contract.mjs`'s production-admission path),
but for the four steps under test here it is mechanically just "the sha256
of the control-catalog file, which the repo already contains and already
records." Using the real, computed digest (not a fabricated one) is what
was passed below.

## The "approved local builder contract" (OCI steps)

`scripts/approved-local-builder-contract.mjs` hardcodes an exact, frozen
snapshot of a specific machine's Docker/OrbStack install — executable
paths, binary sha256, code-signing identity, Docker daemon ID
(`09a6202e-c548-4147-a1a9-3a33590a5b1b`), buildx version, BuildKit worker
UUID, kernel version, etc. `scripts/release/system-docker.mjs`
(`resolveTrustedLocalDocker`) re-observes the live Docker environment on
every OCI step and does an exact-match assertion against that frozen
contract; there is no receipt file that must pre-exist on disk — the
"receipt" is computed at build time from live `docker version` / `docker
info` / `docker buildx inspect` output and only succeeds if it matches the
contract byte-for-byte.

Checked live on this machine: docker executable path, resolved OrbStack
binary sha256, code-signing identifier/team, Docker context name
(`orbstack`), daemon ID, server version, kernel version, buildx version,
and BuildKit worker UUID all matched the frozen contract exactly. **This
machine is the one the contract was captured on**, so the OCI steps are not
blocked by that check here (though on any other host, or after any Docker/
OrbStack upgrade, they would be — see checklist below).

## Step-by-step results

### 1. `release-bundle-build`

**Command** (from `local-acceptance-gate-lib.mjs` ~line 930, run standalone):
```
node scripts/release/build-xero-release-bundle.mjs \
  --output-dir <scratchpad>/output \
  --source-date-epoch 0 \
  --approved-control-catalog-sha256 e488e6ed4cdbe665f214a65ce9d55d42ce1ac3adf54e77317078bb0ec7209fbe \
  --artifact-stream-fd 3
```
`--artifact-stream-fd 3` was supplied via a small wrapper script
(`<scratchpad>/release-bundle/run-build.mjs`) that spawns the child with
`stdio: ['ignore','inherit','inherit','pipe']` and pipes fd 3 to a file —
this reproduces exactly how `local-acceptance-gate-lib.mjs`'s
`artifactStreamKind: "SOURCE_BUNDLE"` plumbing works, without touching the
gate itself.

**Required inputs:**
- `dist/xeroRelease.js` (compiled runtime contract) — present already
  (built `Aug 18 13:05`); repo-derivable via `npm run build`.
- `package.json` version must equal `RELEASE_VERSION = "0.4.0-rc.1"` in
  `release-bundle-lib.mjs` — matched.
- The full allow-listed file set from `enumerateReleaseFiles()` — all
  present on disk, read directly (not from git, so uncommitted local
  changes in this worktree do not block it).
- `--approved-control-catalog-sha256` — repo-derivable (see above).

**Attempt 1 of 2 (only attempt needed) — result: PASS.**
```
{
  "status": "PASS",
  "version": "0.4.0-rc.1",
  "fileCount": 193,
  "archiveSha256": "0c3cb5687174ceaad6ada4d56120ce1b4ada12366dfba769a78ad37eecfba2a7",
  "manifestSha256": "833ee123d2d9b5c3317fe00480c98596bd3b5977ae259f7e3d0d31970ba88fac",
  "buildIdentitySha256": "86980acc29025dbf71f4629ca5e8ca6acf5a86badaf0c98c7700d82657b6c98c",
  "semanticBuildIdentityHash": "ff1a257eb5d662c51d34bc7453e6ccffc1065d8a31d322f90cd9f6713a0568c7",
  "secretFindings": 0,
  "legacyDomainFindings": 0
}
```
Produced: `xero-accounting-mcp-0.4.0-rc.1-source.tar.gz` (667,985 bytes),
`.manifest.json`, `.build-identity.json`, `.sha256`, plus an
`accepted-build-context/` directory (used by the OCI step below), and the
fd-3 artifact stream (713,216-byte tar, written to a scratchpad file by the
wrapper).

**Verdict: RUNNABLE.**

### 2. `release-bundle-verify`

**Command:**
```
node scripts/release/verify-xero-release-bundle.mjs \
  --archive   <out>/xero-accounting-mcp-0.4.0-rc.1-source.tar.gz \
  --manifest  <out>/xero-accounting-mcp-0.4.0-rc.1-source.manifest.json \
  --build-identity <out>/xero-accounting-mcp-0.4.0-rc.1-source.build-identity.json \
  --checksum <out>/xero-accounting-mcp-0.4.0-rc.1-source.sha256 \
  --approved-control-catalog-sha256 e488e6ed4cdbe665f214a65ce9d55d42ce1ac3adf54e77317078bb0ec7209fbe
```

**Required inputs:** the four artifacts from step 1, plus the same
`--approved-control-catalog-sha256`, plus a live re-fingerprint of the
worktree (`fingerprintAcceptanceSource`) that must match what's baked into
the manifest — trivially true since verify ran immediately after build with
no intervening changes.

**Result: PASS**, first attempt, no errors.
```
{
  "status": "PASS",
  "fileCount": 193,
  "archiveSha256": "0c3cb5687174ceaad6ada4d56120ce1b4ada12366dfba769a78ad37eecfba2a7",
  "secretFindings": 0,
  "legacyDomainFindings": 0,
  "forbiddenPathFindings": 0
}
```

**Verdict: RUNNABLE.**

### 3. `release-oci-build`

**Command:**
```
node scripts/release/build-accepted-oci-image.mjs \
  --context  <out>/accepted-build-context \
  --output   <out>/xero-accounting-mcp-0.4.0-rc.1.oci.tar \
  --metadata <out>/xero-accounting-mcp-0.4.0-rc.1.oci-metadata.json \
  --receipt  <out>/xero-accounting-mcp-0.4.0-rc.1.oci-receipt.json \
  --approved-control-catalog-sha256 e488e6ed4cdbe665f214a65ce9d55d42ce1ac3adf54e77317078bb0ec7209fbe
```
(`--artifact-stream-fd` was not passed for this step; it's not required.)

**Required inputs:**
- The `accepted-build-context/` directory sealed by step 1
  (`sealAcceptedBuildContext`, cross-checks manifest/identity/checksums).
- Docker via `resolveTrustedLocalDocker({ requireBuilder: true })`, which
  requires an exact match to `APPROVED_LOCAL_BUILDER_CONTRACT` (see above) —
  host-specific, but this machine already matches it.
- `deploy/Dockerfile` must not declare a `# syntax=` frontend directive
  (mutable-frontend guard) — repo's Dockerfile already complies.
- Docker running in `orbstack` context, `buildx` with a bootstrapped
  `orbstack` builder instance — both true on this machine.

**Result: PASS.** `docker buildx build --platform linux/amd64
--provenance=false --output type=oci,...` ran to completion (build stages,
`npm run build` inside the container, layer export, manifest export). No
errors, no retries needed.
```
{
  "status": "PASS",
  "releaseVersion": "0.4.0-rc.1",
  "semanticBuildIdentityHash": "ff1a257eb5d662c51d34bc7453e6ccffc1065d8a31d322f90cd9f6713a0568c7",
  "ociArtifact": { "filename": "xero-accounting-mcp-0.4.0-rc.1.oci.tar", "sizeBytes": 62404096 },
  "ociManifestDigest": "sha256:533ba4c9c305998765925f8ffa4ffa25e5c6ad03306354e29389378df64a5662",
  "ociConfigDigest": "sha256:2f09d6cd7568c048d2207c19fda40b5c4aad97c498df9bf5bfedb80d02f35f3f"
}
```

**Verdict: RUNNABLE (on this host; see checklist — it is machine-pinned).**

### 4. `release-oci-runtime-smoke`

**Command:**
```
node scripts/release/smoke-accepted-oci-runtime.mjs \
  --artifact <out>/xero-accounting-mcp-0.4.0-rc.1.oci.tar \
  --receipt  <out>/xero-accounting-mcp-0.4.0-rc.1.oci-receipt.json \
  --approved-control-catalog-sha256 e488e6ed4cdbe665f214a65ce9d55d42ce1ac3adf54e77317078bb0ec7209fbe
```

**Required inputs:** the OCI artifact + receipt from step 3; Docker (no
`requireBuilder` this time, just a trusted daemon); network egress to pull
`postgres:16-alpine@sha256:57c72f...` (already cached locally, so no
network round-trip was actually needed); ability to bind an ephemeral local
port.

**Result: PASS.** The script loaded the image, started an isolated Docker
network + Postgres container, ran `npm run migrate` inside the image, ran a
build-identity/source challenge inside the container, started the MCP
runtime container, polled `/readyz` and `/healthz`, and checked that
anonymous MCP calls are rejected (401) and malformed calls are rejected
(400).
```
{
  "status": "PASS",
  "required_migration": "040_xero_native_idempotency_recovery_claim.sql",
  "tool_count": 28,
  "anonymous_mcp_status": 401,
  "malformed_mcp_status": 400
}
```
All temporary containers/networks were removed by the script's own cleanup
(`finally` block); verified afterward with `docker ps -a` / `docker network
ls` — nothing left behind.

**Verdict: RUNNABLE (on this host; see checklist).**

## Summary table

| Step | Command entry point | Verdict |
|---|---|---|
| release-bundle-build | `scripts/release/build-xero-release-bundle.mjs` | **RUNNABLE** |
| release-bundle-verify | `scripts/release/verify-xero-release-bundle.mjs` | **RUNNABLE** |
| release-oci-build | `scripts/release/build-accepted-oci-image.mjs` | **RUNNABLE** (host-pinned Docker contract matched) |
| release-oci-runtime-smoke | `scripts/release/smoke-accepted-oci-runtime.mjs` | **RUNNABLE** (host-pinned Docker contract matched) |

None of the four steps were BLOCKED-ON-HOST-INPUT or BLOCKED-ON-DEFECT when
run standalone with a real, repo-derived `--approved-control-catalog-sha256`
and the Docker/OrbStack install already present on this machine. All four
succeeded on the first attempt with no weakened checks and no fabricated
values.

**This does not mean the full 15-step gate can pass locally.** It only
means steps 12–15's *own* preconditions are all satisfiable from this
worktree today. The gate as a whole is still hard-blocked at step 1
(`independent-review-live`) by design, and `runStepsFailClosed` never lets
execution reach step 12 without step 1 passing — that requires the
out-of-repo, host-key-signed authority described above, which is outside
this repo's control by construction.

## What a host operator must provide (checklist)

1. **The out-of-repository independent-review authority** for step 1
   (`independent-review-live`) — a pinned parent driver, outside this repo,
   that captures the immutable inputs, spawns a signed reviewer process,
   verifies its raw lifecycle, and signs a receipt with a host-held key.
   This is the actual, structural blocker for the full gate; nothing found
   in this investigation gets around it, nor should it.
2. **Formal sign-off on the control catalog's digest** as an *approval*,
   not just a hash. Mechanically the four downstream steps only need the
   sha256 of `schemas/ledger-control-clauses.v1.json` (computable locally
   and shown above), but that digest carries no evidentiary weight as an
   "approval" unless a host reviewer with authority over the catalog
   actually attests to it out-of-band (see
   `deploy/HETZNER-HOST-NGINX-RUNBOOK.md`'s "host reviewer 单独批准"
   language and the production-deployment path in
   `scripts/release/production-deployment-admission.mjs`).
3. **A host machine whose live Docker/OrbStack installation matches (or a
   refreshed) `APPROVED_LOCAL_BUILDER_CONTRACT`** in
   `scripts/approved-local-builder-contract.mjs` — exact executable paths,
   binary sha256, code-signing identity, Docker daemon ID, buildx/BuildKit
   versions, worker UUID. On this machine it already matches; on any other
   machine, or after any Docker/OrbStack upgrade on this one, someone with
   commit access must re-capture the observation and update the pinned
   contract (which itself becomes a reviewed source change, per the
   comment in that file).
4. **Docker Desktop/Engine running** with the `orbstack` context and a
   bootstrapped `orbstack` buildx builder — already true here, but a host
   operator setting this up fresh needs to know it's required (verify with
   `docker context show`, `docker buildx inspect orbstack --bootstrap`).
5. **Local availability of `postgres:16-alpine@sha256:57c72fd2...`** (or
   network egress to pull it) for the runtime smoke step — was already
   cached locally in this run.
6. **A completed `npm run build`** so `dist/xeroRelease.js` exists before
   `release-bundle-build` runs — already done here; a host operator running
   from a clean checkout needs this as an explicit prerequisite step (it is
   not one of the four steps under test, but it silently gates step 12).
