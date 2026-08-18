# G4 — Gate L results and candidate freeze

Date: 2026-08-18. Run ID `2026-08-18-final-acceptance`.

## 1. Frozen candidate identity

Machine record: `CANDIDATE-FREEZE.json`. Independently reproduced by the Gate L
driver's own snapshot step (`gate-l/gate-result.json`), which computed the same
fingerprint from an independent code path.

| Field | Value |
|---|---|
| Release version | `0.4.0-rc.1` |
| Branch | `codex/xero-org-switch-governance-20260810` |
| Git HEAD | `f7675cbc132b1dac7cc9983ed342f7e9af864614` |
| Acceptance source fingerprint | `dbf0ce4da0818e217a6dc76a432b11d3e35e5be6a0ae4360781f86498395fd74` |
| Fingerprint algorithm | `sha256-path-size-executable-content-v2` |
| Files in acceptance source | 566 |
| Tool allowlist SHA-256 | `cce4620bb6a48622758a92de7cf4e256d98851426ba16f4ae8797553a808bbbf` |
| Public tool count | 28 |
| Migrations | 36 files, `001_init.sql` … `040_xero_native_idempotency_recovery_claim.sql` |
| Worktree | dirty: 144 modified tracked, 290 untracked |

The candidate is **not** HEAD. It is the worktree at the fingerprint above. Any
Agent2 deployment must be built from this exact fingerprint, and the worktree must
not be edited between this freeze and that build.

## 2. Gate L driver outcome

Command (executed from the repository, digest-named read-only snapshot boundary):

```text
node scripts/release/run-local-acceptance-gate.mjs \
  --traceability   artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json \
  --local-agent-evidence          <run 06 evidence document> \
  --process-crash-restart-evidence artifacts/.../process-crash-restart.json \
  --approved-control-catalog-sha256 <host> \
  --approved-review-codex-sha256    <host> \
  --approved-review-runtime-sha256  <host>
```

Result: **FAIL at step 1 of 15**, `independent-review-live`.

```json
{"status":"FAIL","failed_step_id":"independent-review-live",
 "gate_l_claim":"NOT_IMPLIED",
 "independent_review_authority":"LOCAL_EVIDENCE_UNTRUSTED",
 "source_stable":true,
 "execution_boundary":"DIGEST_NAMED_READ_ONLY_SOURCE_SNAPSHOT"}
```

This is **not** a defect and not a candidate failure. It is the gate refusing, by
design, to vouch for itself. Its own stated reason:

> A candidate-repository driver and verifier cannot authenticate their own
> reviewer process provenance. An out-of-repository pinned parent driver must
> capture the immutable inputs, spawn the signed reviewer, verify the raw
> lifecycle, and sign a receipt with a host-held key. No such authority is
> available to this repo-local Gate.

**Consequence: a Gate L `PASS` is unreachable from inside this repository.** It
requires a host-held signing authority that does not exist in this environment.
The plan's G4 as written therefore cannot be closed locally; it needs either that
host authority to be provisioned, or an explicit, recorded product decision to
accept the deterministic evidence below in its place.

Two things did work and are worth recording: `source_stable: true` and the
digest-named read-only snapshot executed correctly. That path was previously
non-repeatable — see XF-017 below.

## 3. What the 15 required steps actually stand at

Gate L never reached steps 2-15, so it produced no verdict on them. Eleven of
them were nonetheless executed directly and independently today against this same
worktree. That is weaker than a Gate L PASS — it is not snapshot-bound and not
independently attested — but it is real machine evidence, recorded in
`GATE-RERUN-2026-08-18.md`.

| # | Step | Gate L | Direct execution today |
|---:|---|---|---|
| 1 | `independent-review-live` | FAIL (by design) | Not possible locally |
| 2 | `traceability-closed` | not reached | FAIL — XF-011, deferred |
| 3 | `local-agent-evidence` | not reached | BLOCKED — XF-016, document not emitted |
| 4 | `process-crash-restart-evidence` | not reached | PASS — 4/4 SIGKILL scenarios, independently replayed |
| 5 | `typecheck` | not reached | PASS |
| 6 | `build` | not reached | PASS |
| 7 | `full-regression` | not reached | PASS for product runtime; 26 failures, all in experimental governance tooling |
| 8 | `postgres-required` | not reached | PASS — 16 files / 110 tests on a fresh disposable database |
| 9 | `http-required` | not reached | PASS — 1 file / 3 tests |
| 10 | `static-verification` | not reached | PASS — `PRODUCTION_DEPLOYMENT_IMMUTABILITY` |
| 11 | `git-diff-check` | not reached | PASS |
| 12-15 | release bundle / OCI build / OCI smoke | not reached | NOT RUN |

Full-regression detail: 1,562 tests, 1,425 passed, 26 failed, 111 skipped across
146 files. All 26 failures are inside `tests/independent-review-evidence.test.ts`,
`tests/traceability-validator.test.ts` and (before the XF-017 fix)
`tests/local-acceptance-mechanism.test.ts` — the repository's own experimental
governance tooling, not the product runtime. Zero genuine product runtime
failures.

## 4. XF-017 — acceptance mechanism repeatability defect, fixed today

`startTreeMutationMonitor` reported mutations on trees that nothing had touched.
On macOS the FSEvents stream behind `fs.watch(root, {recursive:true})` delivers a
backlog of changes that predate the watcher, so the `IMMUTABLE_SNAPSHOT` monitor
observed the `makeTreeReadOnly` chmods issued moments before it was created.

Measured on a completely idle snapshot, before the fix: three spurious `change`
events within 50-200 ms, in **12 of 12** trials.
`tests/local-acceptance-mechanism.test.ts` failed 1-3 of 24 tests run to run, and
`assertAcceptanceSnapshotIntegrity` failed closed at random — which made Gate L
itself non-repeatable.

Fix: the monitor now arms deterministically. After the watcher is created it
writes and removes a uniquely named sentinel at the watched root and waits for the
watcher to report it. Delivery is ordered, so the sentinel is a watermark:
everything before it is discarded as pre-arm backlog, everything after it counts.
The sentinel sits outside every monitored source root, so it is never itself a
source mutation. If the sentinel is never observed, the monitor is marked
unarmed rather than reporting noise, and the mandatory inode/ctime/mtime mutation
guard carries the control alone — the documented design. Both monitors' armed
state is now recorded in the snapshot manifest so a run can never be read as
watcher-backed when it was not.

Verification:

- Idle snapshot false positives: **0 of 8** after the fix (was 12 of 12).
- Genuine original-tree A→B→A mutation still detected: **8 of 8**.
- `tests/local-acceptance-mechanism.test.ts`: **24/24 passing, 10 consecutive runs**.
- Adjacent regression: 5 files / 45 tests PASS; `npm run typecheck` PASS.
- Arming cost: 14-70 ms per monitor.

## 5. G4 verdict

**PARTIAL.** The candidate is frozen and its identity is reproducible from two
independent code paths. The deterministic runtime evidence is broad and green.
Gate L itself is `NOT_IMPLIED` and cannot be closed here.

Blocking G4 closure:

1. **Host authority for `independent-review-live`** — an out-of-repository pinned
   parent driver with a host-held signing key. Not provisionable from inside this
   repo.
2. **XF-016** — the run 06 local-agent evidence document, blocked on Codex account
   quota.
3. **XF-011** — the 18-requirement / 90-claim traceability artifact, explicitly
   deferred but still a hard `traceability-closed` step in the gate.

Steps 12-15 (release bundle and OCI build/smoke) were never run and are prerequisites
for any Agent2 deployment, since G5 requires deploying the same image digest.
