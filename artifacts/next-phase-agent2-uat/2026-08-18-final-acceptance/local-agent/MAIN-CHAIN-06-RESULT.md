# Local natural-language main chain 06 (final synthetic candidate)

- Raw evidence: `../local-agent-final-after-skill-loader.raw/`
- Wall clock: started `2026-08-18T04:52:07Z`, final answer `2026-08-18T04:54:00Z`.
- Model: `gpt-5.6-luna`, effort `xhigh`.
- Backend MCP contract: 28 tools. Model-visible profile: the 5-tool Accounting Case
  slice (`xero_pin_current_organisation`, `xero_get_organisation`,
  `xero_prepare_accounting_case`, `xero_execute_accounting_case`,
  `xero_get_accounting_case_status`).
- Provider boundary: `LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY`. This is **not** a real
  Xero claim.

## Mandatory Skill loading (XF-015 closure condition)

The Agent performed exactly four audited read-only reads inside the ephemeral
mounted bundle root `…/xero-local-agent-workspace-B2Z7OR/.agents/skills/`, all
before any MCP business call, and issued no other shell command:

1. `prepare-balanced-accounting-entry/SKILL.md`
2. `prepare-balanced-accounting-entry/references/double-entry-control-model.md`
3. `execute-approved-accounting-entry/SKILL.md`
4. `execute-approved-accounting-entry/references/capability-routing.md`

Run 04 failed because only the Skill entry files were mounted and the referenced
`references/capability-routing.md` was absent. Both references are now mounted and
hashed as part of the deployment-equivalent bundle, and both were actually read.

## Xero tool sequence

| # | Tool | Status | Repair retries |
|---:|---|---|---:|
| 2 | `xero_pin_current_organisation` | PASS | 0 |
| 3 | `xero_get_organisation` | PASS | 0 |
| 4 | `xero_prepare_accounting_case` | PASS | 0 |
| 5 | `xero_execute_accounting_case` | PASS | 0 |

**Zero schema-repair retries.** Runs 01, 02, 03 and 05 each needed at least one
corrected `prepare`; this run needed none. This is the first run to satisfy the
retry-free efficiency oracle.

## Write evidence

- `provider_write_count`: `1`
- Provider object ID: `44444444-4444-4444-8444-444444444444`, status `DRAFT`
- Provider receipt: operation `CREATE_ACCREC_DRAFT`, `providerRequestId`
  `provider-request-case-001`, idempotency key `xmr_fcd03ac91856068fcc3fdb8adcce4d1f`
- Idempotency key identity: the receipt key equals the durable
  `mutation_request_id` (`xmr_fcd03ac91856068fcc3fdb8adcce4d1f`) — the XF-013
  requirement that the durable mutation request ID *is* the Provider idempotency key.
- Exact same-ID readback: verified; `exact_readback_receipt_id`
  `xrb_07780b45e9e9a9322334542fe5ad3cfb`
- Case state `TERMINAL`, operation state `READBACK_VERIFIED`
- Evidence chain hash: `05f255cd1430da8c77b9acd4bd88ecdb241674ce99723105…`

## Agent final answer

`completion_claim = COMPLETED_WITH_PROVIDER_ID_RECEIPT_EXACT_READBACK`, with
`provider_receipt_recorded = true` and `exact_same_id_readback_verified = true`.
The Agent correctly kept `source_truth_claim = NOT_VERIFIED` and
`original_file_verified = false`, and told the user in natural language that it
had confirmed the submitted set only — not the original file, the uploader, the
legal authenticity of the document, or any Trial Balance / reconciliation / close
position. It did not upgrade a ledger readback into source-file verification.

## Token result

- Input 338,306 (294,400 cached); output 4,864; reasoning output 2,660.
- Versus run 01: input -3.6%, output +7.3%. Versus run 04 (201,501 input): +67.9%.
- The increase over run 04 is the price of the now-mandatory Skill and reference
  reads. The retry-free tool sequence, not the raw token count, is what this run
  buys. XF-007 therefore closes only on its correctness half; see the finding
  ledger for the residual context-cost item.

## Release-gate outcome

**PASS at the local deployment-equivalent synthetic boundary.**

Satisfied: mandatory Skill bundle actually loaded and read; deployment-equivalent
instructions, Skill bundle, model-visible tool profile and 28-tool backend
contract; natural multi-turn business language with no internal identifiers in the
prompt; zero schema repair; exactly one Provider write; Provider object ID,
receipt, and exact same-ID readback; honest final answer with correct residual
uncertainty.

## Evidence boundary

This run does **not** prove: Agent2, live OAuth, a real Xero tenant, a real Xero
object ID, PostgreSQL durability under this specific chain, or external
deployment. Those remain owned by G3 (real test tenant) and G5/G6 (Agent2).

## Known gap carried forward

The harness raw evidence exists, replays, and is internally consistent, but the
validated, source-bound `local-agent-final-after-skill-loader.json` evidence
document was never emitted: the generator stopped at a Codex account usage limit
before its final summary step. Gate L consumes the validated document, not the raw
directory, so Gate L cannot be run to completion until the generator is re-run
against the frozen candidate. This is an operational/quota blocker rather than a
defect in the candidate. Tracked as XF-016.
