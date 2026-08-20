# Xero MCP development contract

This repository is shipping a focused Xero Ledger Gateway. Before changing code, read:

- `docs/XERO-MCP-TARGET-ARCHITECTURE-2026-08-20.md`

That file is the R1 product and acceptance authority. Older architecture, remediation, completeness, and review documents are historical evidence only when they conflict with it.

ADR-002's gateway boundary remains effective: MCP validates the binding and typed ledger controls but does not make accounting judgments; the Agent supplies explicit `account_code` and `tax_type`.

## Non-negotiable shape

- Xero is the only formal ledger. Do not build a second ledger, reporting engine, file platform, workflow platform, evidence graph, generic policy DSL, or multi-provider accounting architecture.
- Keep the runtime to target binding, typed MCP capability surface, deterministic ledger controls, a thin Xero provider adapter, and the operation/audit store.
- Never add raw endpoint, arbitrary URL/JSON/filter, generic CRUD, or production legacy mutation tools.
- Provider/schema/policy code alone is not a supported capability.

## Write boundary

- Ordinary writes: Contact and basic untracked Item maintenance; DRAFT create/update for Invoice, Bill, Credit Note, Quote, Purchase Order, and Manual Journal; Tracking Category/Option safe create/update.
- Normal R1 ledger-state writes are part of the target: Invoice/Bill/Credit Note authorise, Manual Journal post, `payment.create`/`payment.reverse`, Bank Transaction create/update, `credit_note.allocate`/`credit_note.refund`, and supported void/reverse actions. Generic `payment.allocate`/`payment.refund` have no stable exact primitive and must not be faked; keep them `LATER_NONCORE`/`NOT_APPLICABLE` unless a future scope explicitly defines them.
- A Xero Payment or Bank Transaction ledger record is not the same as instructing a bank to move money. Do not exclude it merely because it is money-related.
- All writes use the existing typed Accounting Case, current OAuth installation/binding, idempotency, provider receipt, exact read-back, and unknown-write recovery. Do not add a second approval, signature, confirmation-token, or generic workflow system.
- Host-provided generic tool-permission UX, if present, is not an MCP-dependent human confirmation or security gate. The only MCP user confirmation is the existing organisation-selection URL returned by `xero_start_organisation_switch`; chat text alone cannot switch the ledger. R1 write safety is enforced by an immutable typed Case/plan hash, current OAuth target, write switch, one-shot permit, provider receipt, exact read-back, and recovery; no other accounting action gets a new confirmation ceremony or state machine.
- Exclude real external payment initiation/release, bank-feed manipulation, hard delete/history rewrite, payroll payment, tax filing, period close/lock, and final reconciliation confirmation when Xero exposes no stable API action.

## Capability truth

- Build one machine-readable capability manifest. Every official core command and zCloak extension must be one row with `SHIP`, `EXCLUDED_RISK`, or `LATER_NONCORE`.
- Generate or automatically verify action lists, policy mappings, tool allowlist, read-evidence profiles, Agent/profile docs, UAT cases, deploy metadata, and `/readyz` capability hash from that manifest.
- Never hand-pin tool counts such as 28/29/30.
- A `SHIP` row is an R1 commitment. `readiness=READY` requires: public route → typed schema → handler → policy → service/action dispatch → provider call → receipt/read evidence → exact read-back for writes → automated and live evidence.

## Delivery discipline

- Fix real reachability and correctness gaps; do not expand architecture for hypothetical reuse.
- Preserve user/Cloud worktree changes. Do not reset, stash over, or bulk-stage unrelated files.
- Parallel agents must own disjoint file sets. Shared compiler, action contract, and deployment files are integrated by the root agent.
- Run targeted tests during implementation. Run the complete release lane once after the candidate is frozen.
- A hard Gate must prevent a named production failure, execute on the real release path, fail on a known negative, distinguish Go from No-Go, and cost proportionally to the risk.
- Real Xero acceptance maps each capability-manifest row to risk-based business-scenario evidence; multiple rows may share one scenario. Organisation switching must be exercised through its real URL. The frozen candidate must exercise rollback once.

## Release acceptance order

Do not revive historical review stacks merely because they exist. Validate one frozen candidate in this order:

1. derive and validate the capability manifest/tool identity;
2. run typecheck, build, affected tests, and one final full release suite;
3. deploy the immutable candidate to an isolated production-equivalent endpoint;
4. verify OAuth and use the real organisation-selection URL in a browser, then re-read the selected Organisation;
5. run natural-language user journeys through the online Google Drive MCP, current Accounting Skills/Agent, and the candidate Xero MCP: Drive material → Xero reads → typed Case write → exact read-back/Journals;
6. pass production admission, switch blue/green, run public readiness/read-only smoke, and exercise rollback once.

Google Drive is the source-material storage/sync layer; Xero is the only ledger. A Drive file, Agent answer, provider stub, or local test is never evidence that Xero was written. Keep only checks that prevent a concrete failure in this path.

## Current baseline

Treat the current worktree as NO-GO until evidence changes. The current implementation baseline is:

- the public read surface has 38 tools, including Journals, reports, exact Payment, Tracking Categories/Options, and Contact Groups;
- the typed Accounting Case can express the existing ordinary create actions, basic Contact/Item maintenance, Invoice/Bill authorise, and Manual Journal post;
- DRAFT updates, Tracking, and the R1 Payment/Credit/Bank/void routes are code-connected through the typed Case, provider, receipt, and exact read-back, but the frozen candidate remains `NO-GO` until real PostgreSQL and live Xero UAT evidence exists. Generic `payment.allocate`/`payment.refund` are not exposed and remain `LATER_NONCORE`/`NOT_APPLICABLE`.
- `config/xero-capability-manifest.json` is the release inventory, and its validator must remain structurally green even while its live-evidence release decision is `NO_GO`;
- passing local typecheck or provider tests is not live Xero acceptance.

Architecture changes require real Xero/API evidence, a minimal alternative, launch impact, and updated acceptance. “Future reuse” or “cleaner abstraction” is not sufficient.
