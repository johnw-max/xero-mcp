# Push-Readiness Audit — xero-mcp-repo

- **Repo**: `/Users/jiayuanwang/Documents/Workflow - accounting/xero-mcp-repo`
- **Remote**: `https://github.com/johnw-max/xero-mcp.git` — confirmed **public**, `pushed_at 2026-08-11T03:37:41Z`
- **Branch**: `codex/xero-org-switch-governance-20260810` — already exists on `origin` at the same commit as local (`f7675cb`); `main` is also already on `origin` at `d33d763`. **This audit's "changed paths" (~431 files, not the ~310 estimate in scope) are new/uncommitted local work; the repo's prior history is already public on GitHub.**
- **Auditor**: read-only inspection, no files modified, staged, committed, or pushed.
- **Date**: 2026-08-18

---

## Top-line verdict: **READY-WITH-FIXES**

The 431 changed/untracked paths in the working tree contain **no new secrets, private keys, or credentials**. Total added weight is small (~9.0 MB) and mostly source/tests/docs. Two things keep this out of a clean "READY":

1. A **pre-existing, already-public** exposure (from commits made before this session, already pushed to `origin`) of a real Xero Developer App Client ID and internal OAuth client identifiers/hostnames in `docs/WORK-XERO-MCP-CONFIGURATION-ZH.md`, `handoff/2026-08-10/02-Xero-MCP-开发接手指南.md`, and `artifacts/test-runs/2026-08-11-shared-host-oauth-uat/TEST-MATRIX.md`. This is not introduced by the current diff, but it is live on a public repo right now and warrants an explicit decision (rotate vs. accept) before doing anything else with this remote.
2. `scripts/agent2_uat_write_gate_vps.sh` (new, untracked) hardcodes a similar-looking client identifier and production paths — confirmed to be a non-secret public client_id, but worth a human eyeball before commit given the file's operational nature.

No client secrets, tokens, private keys, `.env` values, or database passwords were found anywhere in the working tree or in full git history (`git log --all -p`) searches for those patterns.

---

## Severity-ranked findings

| # | Sev | Area | Finding | Recommendation |
|---|-----|------|---------|-----------------|
| 1 | **P1** | Secrets / already-public | Real Xero Developer App **Client ID** `F5A3D...A40C` (32-hex, redacted) and production hostname `mcp.jiayuanwang.xyz`, plus internal OAuth client ids `work-xero-...`/`agent2-xero-...`, appear in `docs/WORK-XERO-MCP-CONFIGURATION-ZH.md`, `handoff/2026-08-10/02-Xero-MCP-开发接手指南.md`, `artifacts/test-runs/2026-08-11-shared-host-oauth-uat/TEST-MATRIX.md`. These are already committed in prior commits (`fe49ee8`, `2cba1ba`, `76ff480`, `f7675cb`) that are **already pushed to the public `origin`**. No `client_secret` value was found alongside them (docs explicitly say the secret is withheld). | Decide now: either treat the Xero OAuth app as burned and rotate its client_secret/registration (cheap, since client_id alone isn't sufficient to abuse without the secret), or explicitly accept the exposure as intentional/low-risk. Going forward, redact client_id/hostnames from any new docs before pushing. This does not block committing the *current* diff (it doesn't add new exposure), but it should not be deferred. |
| 2 | **P2** | Secrets / new file | `scripts/agent2_uat_write_gate_vps.sh` (untracked) hardcodes `EXPECTED_CLIENT_ID="agent2-xero-bd0796db041ee01e"`, `EXPECTED_PUBLIC_BASE_URL="https://mcp.jiayuanwang.xyz"`, `TEST_TENANT_ID="7c3cc738-...-e61"` (a real/test Xero tenant GUID) and other host-specific expectations. Confirmed non-secret (OAuth client_id + tenant id, not a secret), but it is a production/host-specific operational script. | Fine to commit as ops tooling; consider whether the tenant ID and hostname should live in a config file instead of being baked into the script, for portability and to reduce what a public reader can infer about your infra. |
| 3 | **P2** | Repo hygiene | 28 files under `artifacts/**/*.raw/` and 2 loose `process-crash-restart.json` files carry mode **0600** (owner-only). Content was inspected and is clean (LLM token-usage counters, command transcripts, no secrets) — the restrictive mode looks like an artifact of how the evidence-generation scripts wrote them, not a deliberate secrecy signal. Git does not preserve POSIX permission bits beyond the executable bit, so this mode is **lost on commit** regardless. | No action required for secrecy; if the 0600 mode is meant to signal "sensitive, do not commit," flag that intent explicitly instead of relying on file mode, since git will silently normalize it away. |
| 4 | **P2** | Docs | None of the mismatches requested were found — see Docs Currency section below; version/tool-count claims in `README.md` and `docs/` are internally consistent with `package.json` (`0.4.0-rc.1`) and the 28-tool surface in `config/tool-allowlist.json` / `src/mcp/toolNames.ts`. | No action. Downgraded from a potential finding to a clean bill — listed here only so the check is visibly done. |
| 5 | **P3** | Repo weight | One file over 1 MB: `docs/assets/xero-mcp-mvp-zero-architecture-2026-08-17.png` (1.36 MB, architecture diagram). One small zip: `agent-skills/.../execute-approved-accounting-entry.zip` (7.2 KB). Total added weight ≈ 9.0 MB across 431 files — not a repo-bloat concern. | No action needed; the PNG is a legitimate docs asset. |
| 6 | **P3** | `.gitignore` | `.gitignore` is adequate for its current scope (`node_modules/`, `dist/`, `coverage/`, `output/`, `test-results/`, `*.log`, `.env*`, `*.pem/.key/.crt`, `deploy/.env.vps`). `output/`, `outputs/`, `coverage/`, `test-results/` don't currently exist on disk, so they aren't a live risk. `*.log` correctly suppresses `codex-stderr.log` files under `artifacts/**/*.raw/` (verified via `git check-ignore`) — those never entered the untracked set. No stray `.DS_Store` (the one under `src/` is correctly ignored). No hardcoded `/Users/jiayuanwang/...` paths found in any changed file. | Optionally add `artifacts/**/*.raw/*.log` explicitly for clarity (already covered by `*.log`, so cosmetic only). |

No P0 blockers were found in the working-tree diff itself.

---

## 1. Secret scan

**Method**: pattern search (private keys, `.env` values, JWT shapes, AWS keys, bearer tokens, DB connection strings with embedded creds, Xero client_id/secret patterns, SSH keys) across the full worktree excluding `node_modules/`, `.git/`, `dist/`; plus a `git log --all -p` sweep for the same patterns across full history (not just the working tree), since the branch is already public.

**Results — all clean**:
- No `BEGIN ... PRIVATE KEY` blocks anywhere (worktree or history).
- No `.env` files with real values exist on disk; only `config/.env.example` (all placeholder values: `replace-from-xero-developer-console`, `change-me`, `replace-with-...-random-characters`, etc.) and `deploy/env.vps.example` (placeholder DB password).
- No AWS-shaped keys (`AKIA...`).
- No JWT-shaped strings.
- No SSH private key files (`id_rsa*`, `*.pem`, `*.key`) anywhere in the worktree.
- No real `client_secret` values in the worktree or in any commit added-line across full history — every `client_secret` hit is either test fixture text (`tests/*.test.ts`, values like `"wrong"`, `"a".repeat(43)`, `"invalid-client-secret"`) or explicit placeholder text in example/env files.
- `postgres://...` / `postgresql://...` connection strings with embedded credentials found only in: `config/.env.example` (`accounting_mcp:change-me@127.0.0.1`), `deploy/env.vps.example` (`REPLACE_WITH_THE_SAME_URL_ENCODED_PASSWORD`), and test files using `test:test@127.0.0.1` — all placeholders/test fixtures, none real.
- `artifacts/**` (the folder called out for special attention): grepped for secret/token/password/apikey/authorization keywords — 87 keyword hits across the whole tree, all reviewed; every hit is design-document prose (e.g. "the public failure envelope ... never provider bodies, secrets") or LLM token-usage counters (`"tokens":338306`) in `codex-events.jsonl`/`server-audit.json`, not actual credential material.
- `deploy/**`: only example/placeholder credential material (`deploy/env.vps.example`); no real `deploy/.env.vps` file exists on disk (it's git-ignored and absent).
- `config/**`: `config/.env.example` (placeholders only) and `config/tool-allowlist.json` (tool names, no secrets).
- `handoff/**`: **already committed and clean** (not part of the current diff — `git status` shows zero changes here, so it's out of scope for "what would this commit add," but was scanned anyway per instructions since it ships with the repo). See Finding #1 above for what it contains.
- **Mode-0600 files**: 34 total under the worktree — 31 under `artifacts/**` (listed below) and 3 under `dist/` (build output, excluded from scope by the task's own instructions, and not part of the tracked source anyway). All 31 `artifacts/` ones were opened and read; content is command transcripts, JSON evidence receipts, and LLM run logs — no secret material found in any of them.

```
artifacts/ledger-kernel-review/round-2026-08-13-local/local-agent-run.raw/{codex-events.jsonl,codex-stderr.log,server-audit.json}
artifacts/ledger-kernel-review/round-2026-08-13-local/process-crash-restart.json
artifacts/ledger-kernel-review/round-2026-08-13-local/process-crash-restart.raw/*.jsonl (4 files)
artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/local-agent-final-after-skill-loader.raw/{codex-events.jsonl,codex-stderr.log,server-audit.json}
artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/local-agent-final-after-write-boundary.raw/{codex-events.jsonl,codex-stderr.log,server-audit.json}
artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/local-agent/local-agent-run.raw/{codex-events.jsonl,codex-stderr.log,server-audit.json}
artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/local-agent/main-chain-03.raw/{codex-events.jsonl,codex-stderr.log,server-audit.json}
artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/local-agent/main-chain-04-narrow-profile.raw/{codex-events.jsonl,codex-stderr.log,server-audit.json}
artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/local-agent/main-chain-05-final-synthetic.raw/{codex-events.jsonl,codex-stderr.log,server-audit.json}
artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/process-crash-restart.json
artifacts/next-phase-agent2-uat/2026-08-18-final-acceptance/process-crash-restart.raw/*.jsonl (4 files)
```

**Real Xero credentials outside the repo**: confirmed. `PRIVATE-XERO-OAUTH-HOST-CREDENTIALS-2026-08-11.json` (mode 0600, 557 bytes) lives one level up, at `/Users/jiayuanwang/Documents/Workflow - accounting/PRIVATE-XERO-OAUTH-HOST-CREDENTIALS-2026-08-11.json`, **outside** `xero-mcp-repo`. It is not tracked, not referenced by path in any file, and no copy of it or its contents was found anywhere inside the repo.

**The one real finding**: Client ID (not secret) exposure described in Finding #1 of the severity table — real Xero Developer App Client ID, production hostname `mcp.jiayuanwang.xyz`, and internal OAuth client identifiers (`work-xero-...`, `agent2-xero-...`) appear in three files, all already committed in prior commits on this branch and already present on the public `origin` remote (verified via `curl https://api.github.com/repos/johnw-max/xero-mcp` → `"private": false"`, `"pushed_at": "2026-08-11T03:37:41Z"`, and `git ls-remote origin` showing the branch already at the same commit as local `HEAD~0`... actually at `f7675cb`, one commit behind local `HEAD` `d33d763`/current work). Docs explicitly state the corresponding client_secret is deliberately withheld from these files ("不能写入本文档" / "must not be written into this document") and no secret value was found alongside the IDs.

---

## 2. `.gitignore` adequacy

Current `.gitignore`:
```
.DS_Store

node_modules/
dist/
coverage/
output/
test-results/
*.log

.env
.env.*
!.env.example
deploy/.env.vps

*.pem
*.key
*.crt
```

Assessment of the directories called out in scope:

- **`artifacts/`** — **not ignored, and that's correct.** It is not scratch/run detritus; it's a structured, timestamped evidence trail (`harness-runs/`, `ledger-kernel-review/`, `next-phase-agent2-uat/`, `test-runs/`) that this repo's own release-gate tooling and docs (`docs/XERO-MCP-NEXT-PHASE-EXECUTION-AND-ACCEPTANCE-LOOP-2026-08-18.md`, `scripts/release/*`) treat as required release evidence. Total size is only ~1.7 MB. Recommend keeping it tracked. One thing worth a human decision: `artifacts/harness-runs/` contains several superseded intermediate timestamped runs (e.g. four separate `p0-accounting-case-2026-08-13T*` directories plus a `-final-20260813` one) — low cost to keep (28–40 KB each) but could be pruned to just the "final" ones if the team wants a tighter evidence trail. Not a blocker.
- **`outputs/`, `output/`, `coverage/`, `test-results/`** — `output/` and `test-results/` are already in `.gitignore`; `coverage/` is already in `.gitignore`. None of `output/`, `outputs/`, `coverage/`, or `test-results/` currently exist on disk in this repo, so there is nothing live to leak. (These may have been conflated with unrelated sibling folders in the parent `Workflow - accounting` directory, which is a separate, non-git-related workspace.)
- **Log files** — `*.log` is already ignored and verified working: `git check-ignore -v` confirms the `codex-stderr.log` files under `artifacts/**/*.raw/` are excluded and do not appear in `git status`.
- **`*.raw/` directories** — not directory-pattern-ignored, and correctly so: their `.jsonl`/`.json` contents (evidence) are meant to be committed; only the `.log` files inside them are (correctly) suppressed by the existing `*.log` rule.
- **Machine-local absolute paths** — grepped all 431 changed files for `/Users/jiayuanwang`: **zero matches**. The only local-machine-shaped paths found were ephemeral macOS temp-dir paths (`/private/var/folders/.../T/xero-local-agent-workspace-*`) inside `artifacts/**/*.raw/codex-events.jsonl` command-execution transcripts — these are expected, non-sensitive artifacts of how the local UAT harness ran, not developer-machine-specific config that would break for another developer.
- **Stray files** — `src/.DS_Store` exists on disk but is correctly excluded by the `.DS_Store` rule (confirmed via `git check-ignore`); it does not appear in `git status`.
- **No real `.env` file exists anywhere** in the tree (only `config/.env.example`), so the `.env`/`.env.*` rules are currently moot but correctly present as a guardrail.

No changes to `.gitignore` are required for correctness. Optional: add a comment noting `artifacts/**/*.log` is intentionally excluded so future contributors don't wonder why it's missing from evidence bundles.

---

## 3. Repo weight

**Total added by committing the current worktree** (431 changed/untracked files, sizes summed): **9,420,905 bytes ≈ 8.98 MB.**

**Files over 1 MB**: one.
- `docs/assets/xero-mcp-mvp-zero-architecture-2026-08-17.png` — 1,359,041 bytes (1.30 MB), a PNG architecture diagram.

**Binary files** (zip/media/archive extensions) among changed files: two, both small.
- `docs/assets/xero-mcp-mvp-zero-architecture-2026-08-17.png` — 1.30 MB (counted above)
- `agent-skills/accounting-double-entry-skills-2026-08-10/deploy/execute-approved-accounting-entry.zip` — 7,265 bytes

No `.mp4`, `.tar`, `.oci`, or other large-binary artifacts were found in the changed set.

**Top 25 largest changed files** (all plain text except the PNG noted above):

| # | Size | Path |
|---|------|------|
| 1 | 1,359,041 B (1.30 MB) | `docs/assets/xero-mcp-mvp-zero-architecture-2026-08-17.png` |
| 2 | 446,481 B | `src/db/postgresRepository.ts` |
| 3 | 253,142 B | `src/db/inMemoryRepository.ts` |
| 4 | 202,241 B | `artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json` |
| 5 | 198,825 B | `tests/xero-accounting-case-service.test.ts` |
| 6 | 183,968 B | `src/services/xeroAccountingCaseService.ts` |
| 7 | 178,487 B | `scripts/review/independent-review-evidence-lib.mjs` |
| 8 | 164,428 B | `tests/independent-review-evidence.test.ts` |
| 9 | 144,038 B | `tests/accounting-case-postgres-repository.integration.test.ts` |
| 10 | 129,540 B | `package-lock.json` |
| 11 | 128,862 B | `artifacts/harness-runs/p0-readonly-final-authority/evidence.jsonl` |
| 12 | 128,198 B | `artifacts/harness-runs/p0-readonly-final-diagnostic/p0-readonly/evidence.jsonl` |
| 13 | 126,744 B | `src/services/accountingService.ts` |
| 14 | 106,444 B | `tests/accounting-case-in-memory-repository-concurrency.test.ts` |
| 15 | 83,452 B | `harness/runners/run-p0-accounting-case.ts` |
| 16 | 76,291 B | `harness/runners/run-p0-controlled-write.ts` |
| 17 | 69,186 B | `src/providers/xeroProvider.ts` |
| 18 | 68,408 B | `scripts/review/independent-review-plan-lib.mjs` |
| 19 | 65,104 B | `scripts/release/local-acceptance-gate-lib.mjs` |
| 20 | 64,923 B | `src/services/xeroMutationService.ts` |
| 21 | 64,144 B | `harness/remote-agents/lib/runner-core.mjs` |
| 22 | 63,906 B | `tests/postgres-oauth-broker-flow.integration.test.ts` |
| 23 | 57,035 B | `harness/runners/run-p0-readonly.ts` |
| 24 | 56,865 B | `src/control-kernel/accountingCaseCompiler.ts` |
| 25 | 56,718 B | `migrations/039_accounting_case_expired_target_residual_continuation.sql` |

Nothing here is a repo-weight concern — the largest items are legitimate source/test/evidence files, not accidental binary blobs.

---

## 4. Docs currency

Checked `README.md`, `PRD-XERO-ACCOUNTING-AGENT-MCP.md`, and the `docs/` tree against `package.json` (`"version": "0.4.0-rc.1"`), `config/tool-allowlist.json` (28 tools), and `src/mcp/toolNames.ts` (28 tools, identical list).

**Result: no mismatches found.** `README.md` and the newer `docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md` / `docs/XERO-MCP-CURRENT-STATE-ZH-2026-08-17.md` are internally consistent and explicit about the distinction between:
- **Deployed/online**: `0.3.1`, 44 tools, toolset fingerprint `d2ac8c01…0224` — this is what's actually live.
- **Local candidate (not yet deployed)**: `0.4.0-rc.1`, 28 tools — matches `package.json` and both tool-surface files exactly. README explicitly warns not to reuse the old 44/45-tool counts for the new candidate.

`config/tool-allowlist.json` and `src/mcp/toolNames.ts` both list exactly the same 28 tool names in the same order — no drift between the runtime allowlist and the type-level tool name source of truth.

`PRD-XERO-ACCOUNTING-AGENT-MCP.md` is an already-committed, unmodified V1 Draft dated 2026-08-05 describing product vision at an earlier stage; it makes no specific version/tool-count claim that contradicts current state, so there's nothing concrete to flag there beyond it being an early-stage doc (expected for a PRD).

One cross-reference was spot-checked and holds up: `docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md` points to `harness/manifests/contract-v1.json` as the source of truth for the current release contract — that file exists.

---

## 5. Commit plan

Proposed grouping of the ~431 changed paths into 7 logical commits. Ordered so earlier commits don't depend on later ones where avoidable (schema/migrations before the code that needs them, source before tests that exercise it, docs/evidence last).

1. **`feat: add ledger control-kernel, Accounting Case domain, and governed write path`**
   Scope: `src/control-kernel/`, `src/domain/accountingCase*.ts`, `src/domain/ledgerAuthority.ts`, `src/policy/xeroAccountingCase*.ts`, `src/policy/xeroAutonomous*.ts`, `src/policy/xeroBusinessCoordinateAuthority.ts`, `src/policy/xeroCapabilityError.ts`, `src/policy/xeroContactIdentity.ts`, `src/policy/xeroExternalGovernanceAuthority.ts`, `src/policy/xeroFirmGovernanceClaim.ts`, `src/policy/xeroNativeRouteContract.ts`, `src/policy/xeroOriginalTransactionEvidence.ts`, `src/policy/xeroRuntimeCapabilityService.ts`, `src/policy/xeroSingaporeAccountingPolicy.ts`, `src/policy/xeroTaxRateResolver.ts`, `src/policy/xeroTenantCoaProfile.ts`, `src/providers/xeroProviderFailure.ts`, `src/security/ledgerTargetReference.ts`, `src/security/xeroProviderWritePermit*.ts`, `src/services/ledgerTargetSessionService.ts`, `src/services/xeroAccountingCaseService.ts`, `src/services/xeroBusinessCoordinateHistory.ts`, `src/mcp/xeroAccountingCaseBusinessIntake.ts`, `src/mcp/xeroFailureEnvelope.ts`, `src/mcp/toolNames.ts`, `src/db/accountingCaseRecoveryProjectionReadiness.ts`, `src/db/requiredMigrations.ts`, `src/db/required-migrations.json`, plus the pre-existing `src/*` edits to `postgresRepository.ts`, `inMemoryRepository.ts`, `repository.ts`, `config.ts`, `errors.ts`, `server.ts`, `createServer.ts`, etc.

2. **`feat: add database migrations for target sessions, authority snapshots, and case lifecycle`**
   Scope: `migrations/025_*.sql` through `migrations/040_*.sql` (16 files).

3. **`test: cover accounting case compiler, kernel, migrations, and write-permit boundary`**
   Scope: everything under `tests/accounting-case-*.test.ts`, `tests/ledger-*.test.ts`, `tests/xero-accounting-case-*.test.ts`, `tests/xero-provider-write-permit-boundary.test.ts`, `tests/xero-native-route-contract.test.ts`, `tests/xero-external-governance-authority.test.ts`, `tests/postgres-*.integration.test.ts`, `tests/governance-cutover-contract.test.ts`, `tests/production-deployment-admission.test.ts`, `tests/reviewer-host-trust.test.ts`, `tests/traceability-validator.test.ts`, `tests/required-migrations-release-gate.test.ts`, plus the pre-existing modified test files (`src/http/app.test.ts`, `src/mcp/createServer.test.ts`, `src/services/*.test.ts`).

4. **`build: add release/harness tooling for local acceptance gate and evidence generation`**
   Scope: `harness/` (runners, fixtures, scenarios, remote-agents, local-agents, lifecycle), `scripts/release/*.mjs`, `scripts/review/*`, `scripts/approved-local-builder-contract.mjs`, `scripts/local-acceptance-contract.mjs`, `scripts/verify-accepted-*.mjs`, `schemas/*.schema.json`, `schemas/ledger-control-clauses.v1.json`.

5. **`chore: update deploy configs, agent2 UAT write-gate script, and Docker context`**
   Scope: `deploy/Dockerfile`, `deploy/Dockerfile.dockerignore`, `deploy/HETZNER*.md`, `deploy/docker-compose/*.yaml`, `deploy/env.vps.example`, `deploy/scripts/*`, `scripts/agent2_uat_write_gate_vps.sh`, `.dockerignore`, `config/.env.example`, `config/tool-allowlist.json`, `package.json`, `package-lock.json`.

6. **`docs: document ledger control-kernel spec, 0.4.0-rc.1 state, and OAuth troubleshooting`**
   Scope: `README.md`, `docs/*.md` (all modified + new), `docs/adr/`, `docs/assets/`, `agent-skills/accounting-double-entry-skills-2026-08-10/` (docs + the small zip). **Before this commit, redact or rotate the Xero client_id/hostname material in `docs/WORK-XERO-MCP-CONFIGURATION-ZH.md`** per Finding #1 if the decision is to treat it as sensitive — otherwise commit as-is since it introduces no new exposure beyond what's already public.

7. **`test: record release evidence for ledger kernel review, P0 harness runs, and Agent2 UAT`**
   Scope: all of `artifacts/**` (harness-runs, ledger-kernel-review, next-phase-agent2-uat, test-runs).

**Recommended exclusions** — nothing needs to be excluded on secrecy grounds; the working tree is clean. Two soft/optional exclusions to consider, not required:

- `artifacts/harness-runs/p0-accounting-case-2026-08-13T{05-57-19.150Z,06-04-49.328Z,06-41-13.833Z,06-49-19.083Z}/` — four superseded intermediate timestamped runs (28–36 KB each) that appear to precede `artifacts/harness-runs/p0-accounting-case-final-20260813/`. Low cost to keep; exclude only if the team wants a leaner evidence trail and the "final" directory is confirmed to supersede them.
- None of the `.raw/` evidence subfolders need exclusion — content was individually verified clean.

No path needs to be excluded for being a stray machine-local artifact, a real credential, or an oversized binary — none were found in the changed set.
