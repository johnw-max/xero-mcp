# Baseline results

Run ID: `2026-08-18-final-acceptance`

This file records the pre-fix baseline only. It is not a Gate L acceptance result.

## Source identity

- Branch: `codex/xero-org-switch-governance-20260810`
- HEAD: `f7675cbc132b1dac7cc9983ed342f7e9af864614`
- Release version declared by source: `0.4.0-rc.1`
- Worktree: materially dirty; baseline count was 139 modified tracked files, 247 untracked files, and no staged files. The tracked diff was approximately 16,281 insertions and 2,529 deletions. Acceptance-critical source, tests, migrations, Skills, deployment files, and evidence are not represented by HEAD alone.
- GitHub push: prohibited by the run contract.

## Pre-fix checks

| Check | Result | Scope |
| --- | --- | --- |
| `npm run typecheck` | PASS | TypeScript compile contract |
| `git diff --check` | PASS | Whitespace/error check over current diff |
| Targeted Vitest baseline | PASS: 6 files, 144 tests | Provider unknown-write behavior, Accounting Case service/tool/MCP schema/policy contracts |

Targeted command:

```text
npx vitest run tests/provider-write-recovery.test.ts tests/xero-accounting-case-service.test.ts tests/xero-accounting-case-tool-contract.test.ts tests/local-agent-accounting-case-mcp.test.ts tests/schema-contract.test.ts tests/xero-tool-policy-contract.test.ts
```

These passing tests do not prove the no-ID unknown-write recovery path. Existing tests currently encode the safe-stuck behavior and need a new deterministic red test for bounded same-key recovery.

## Current live reference, not acceptance

The retained 2026-08-15 online UAT evidence identifies the live deployment as `0.4.0-rc.1`, 28 tools, `READ_ONLY`, and process write disabled. It also records an Agent2 client-ID/routing mismatch and no completed write validation. Those facts are historical reference evidence only; they must be refreshed after the exact accepted candidate is deployed.

## Baseline classification

- XF-001: `CURRENT_GAP` P0. Safe-stuck behavior prevents a blind duplicate but cannot converge when the first create committed and returned no Provider ID.
- XF-002: `CURRENT_GAP` P0. Agent2 client/config/routing is not closed by current evidence.
- XF-003: `CURRENT_GAP` P1. The raw-writer exposure allegation is outdated, but the remaining `xero.draft.write` to Provider-scope mapping still grants Manual Journal and settings/item capabilities that the public Accounting Case action set does not use.
- XF-004: `CURRENT_GAP` P1. The written layer contract exists, but the generic execution Skill still requires per-item human approval while the Xero profile uses standing delegation. There is also no machine evidence that the deployment-equivalent Agent loaded the exact final instructions, Skills, schemas and allowlist.
- XF-005: `DEFERRED` P2 hardening for this acceptance slice. Current pagination is bounded and fail-closed, but its very high per-path limits lack a single-Case provider-call budget and remain unproven at production scale.
- XF-006: `CURRENT_GAP` P0. Old attestation evidence is stale (migration 032, no commit/image identity) while source requires migration 039.

## Gate status

- P0/P1 remediation: NOT RUN / not yet accepted.
- Full local natural-language acceptance: NOT RUN.
- Real Xero test-tenant DRAFT write/read-back: NOT RUN.
- Gate L: NOT RUN.
- Agent2 online UAT: NOT RUN.
- GitHub push decision: intentionally deferred to the user.
