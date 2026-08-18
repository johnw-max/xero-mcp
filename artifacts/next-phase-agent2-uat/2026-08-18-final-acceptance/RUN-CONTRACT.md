# Xero MCP final acceptance run contract

- Run ID: `2026-08-18-final-acceptance`
- Started: `2026-08-18T02:03:33Z`
- Status: `PARTIAL` — local synthetic acceptance closed; G3/G5/G6 blocked on external dependencies. See `FINAL-VERDICT.md`.
- Branch: `codex/xero-org-switch-governance-20260810`
- Baseline HEAD: `f7675cbc132b1dac7cc9983ed342f7e9af864614`
- User-authorized end state: a fully accepted Xero MCP through local deployment-equivalent validation and Agent2 test-environment online UAT, stopping before any GitHub push.

## Business outcome

Using the exact candidate Agent instructions, Skills, MCP schemas, runtime, and a dedicated Xero test organisation, a user can complete one Supplier Bill DRAFT through natural multi-turn accounting language. Completion requires Provider object ID, write receipt, same-ID exact readback, duplicate protection, and an honest Agent reply.

## In scope

- Current `xero-mcp-repo` worktree and its acceptance-critical uncommitted changes.
- Public 28-tool MCP surface and Accounting Case execution path.
- Deployed accounting Agent instructions and Skills used by the candidate.
- Local deterministic, PostgreSQL, HTTP/OAuth, process-failure, schema, local-Agent, and real-Xero-test-tenant validation.
- Deployment of the same accepted artifact to `https://agent2.zcloak.ai`.
- One high-signal Agent2 natural-language DRAFT journey plus an exact duplicate check.
- Evidence, token ledger, independent review, and final GO/NO-GO.

## Explicit non-goals

- No GitHub commit or push; the user keeps that final decision.
- No production Xero tenant or non-allowlisted installation.
- No AUTHORISE, POST, payment, bank write, reconciliation, tax filing, payroll, or month-end close.
- No Work production release and no claim of enterprise multi-user IAM completion.

## Hard failures

- Wrong or unverified tenant, missing exact allowlist, or write gate wider than the single test installation/tenant.
- Provider mutation without durable intent and stable idempotency identity.
- Unknown write outcome that can blind-create a second object.
- Missing Provider object ID, receipt, or same-ID exact readback for any success claim.
- Agent2 uses a source/image/toolset/Skill/policy identity different from the accepted local candidate.
- Agent claims completion from PREPARED, chat text, timeout, or unverified tool output.
- Any production data mutation or unsupported accounting action.

## Safe stop and rollback

- Keep write disabled until local Gate G4 is accepted and the exact test tenant is read and independently recorded.
- For live testing, DRAFT only and unique run sentinel only.
- On any environment or evidence mismatch: disable the write gate first, preserve receipts/logs, and return to the owning local Gate.
- Do not delete or clean a created DRAFT automatically; record the object ID and cleanup decision separately.

## Token policy

- Starting visible balance: `UNAVAILABLE`.
- Numeric ceiling: not provided; use the smallest high-signal set.
- Main supervisor: strong model, short summaries only.
- Default workers: Luna, one writer at a time; at most one additional read-only reviewer.
- All visible usage observations go to `TOKEN-LEDGER.csv`; do not invent unavailable numbers.

## Required handoff

- Local and Agent2 case matrix with PASS/PARTIAL/BLOCKED/FAIL.
- Exact source, Skill, toolset, policy/compiler/kernel, migration, and image identities.
- Local and Agent2 conversation exports/tool traces.
- Xero object IDs, Provider receipts, same-ID readbacks, and duplicate-count evidence.
- Finding ledger with independent reviewer closure or explicit blockers.
- Final verdict and claims safe/not safe to make.

