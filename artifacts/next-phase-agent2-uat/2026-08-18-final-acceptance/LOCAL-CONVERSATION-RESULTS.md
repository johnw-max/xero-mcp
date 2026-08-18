# Local acceptance conversation results — Claude-driven agent runs

Date: 2026-08-18. Candidate fingerprint
`dbf0ce4da0818e217a6dc76a432b11d3e35e5be6a0ae4360781f86498395fd74` (plus the
XF-019 harness extension applied after the freeze — see §6).

## 0. Evidence boundary — read this first

The Codex account that drove main chains 01-06 is out of quota. For these runs the
**Agent role was executed by Claude** (this session), loading the same
deployment-equivalent operating contract: `agent-config/accounting-agent-instructions.md`,
the `prepare-balanced-accounting-entry` and `execute-approved-accounting-entry`
Skills with their references, and the same 5-tool model-visible Accounting Case
profile over the unchanged 28-tool MCP backend. Tool calls went over MCP stdio to
the same `harness/local-agents/serve-accounting-case-mcp.ts` server, via a
purpose-built interactive driver (`conversations/local/mcp-stdio-driver.mjs`) that
keeps one server alive across turns so state is shared.

This is **not** identical to a Codex run and must not be recorded as one. What it
does prove is server-side: every refusal, guard, receipt and readback below is the
product's own deterministic behaviour, independent of which model sat in front of
it. The user-side dialogue was frozen in
`conversations/local/USER-SCRIPT-SUPPLIER-BILL.md` before any tool call.

Provider boundary is the local synthetic provider. **No real Xero object exists.**

## 1. Headline result

The round's Definition of Done fixes the test object as **one Supplier Bill DRAFT
under Standing Delegation**. That object cannot be produced — not by this harness,
and not by the deployed Agent2 environment either. The product refuses it by
design. See §4; this is the round's most consequential finding.

## 2. Session A — supplier bill boundary and unknown-counterparty fail-closed

Raw: `conversations/local/session-a-supplier-bill-boundary/`.

| Step | Action | Result |
|---|---|---|
| 1 | `xero_pin_current_organisation` | PASS — `Synthetic Case Company`, binding revision 1 |
| 2 | `xero_get_organisation` | PASS — SG, SGD, ACTIVE, `fact_origin: MCP_READ` with full provenance envelope |
| 3 | `xero_prepare_accounting_case` — SUPPLIER_BILL, counterparty `Nimbus Cloud Services` (not in the ledger) | `PLANNED_WITH_EXCEPTIONS`, disposition `REVIEW_REQUIRED`, reason `EXACT_XERO_CONTACT_REQUIRED`, **0 operations**, `ledger_write_claim: NOT_WRITTEN` |
| 4 | `xero_execute_accounting_case` on that version | `TERMINAL`, `eligible_write_status: NONE`, `ledger_write_claim: NOT_WRITTEN` — no provider call |
| 5 | Re-prepare with the corrected counterparty `Exact Customer` | `PLANNED_NEEDS_PREFLIGHT`, one `supplier_bill.create_draft` operation, residual 0 |
| 6 | Execute | **Refused**: `STANDING_DELEGATION_REQUIRED` / `STANDING_DELEGATION_ACTION_MISMATCH`, `provider_mutation_possible: false` |

Two controls proven: an unknown counterparty is refused at the ledger boundary and
**no contact is silently created**; and a standing delegation that does not cover
the requested action fails closed rather than falling back.

Step 6 exposed XF-019: the harness's standing-delegation fixture granted only
`customer_invoice.create_draft`, and its synthetic provider did not implement
`createDraftSupplierBill`/`getSupplierBill` at all. The harness was extended
(§6) and session B re-ran the supplier bill on that extended harness.

## 3. Session B — route authority, positive control, duplicate protection

Raw: `conversations/local/session-b-route-and-duplicate/`. Ten tool calls, all
transport-level PASS.

| Step | Action | Result |
|---|---|---|
| 1-2 | pin + read organisation | PASS |
| 3 | prepare SUPPLIER_BILL (`NCS-2026-0731`, `Exact Customer`, SGD 1,200 + 108 GST) | `PLANNED_NEEDS_PREFLIGHT`, one `supplier_bill.create_draft` operation, residual 0 |
| 4 | execute the supplier bill | **Refused**: `PROVIDER_BUSINESS_COORDINATE_ATOMICITY_UNPROVEN`, `provider_mutation_possible: false`. See §4 |
| 5 | prepare CUSTOMER_INVOICE, identical economics (positive control) | `PLANNED_NEEDS_PREFLIGHT`, one `customer_invoice.create_draft` operation |
| 6 | execute | **PASS** — `TERMINAL`, operation `READBACK_VERIFIED`, object `44444444-4444-4444-8444-444444444444`, receipt recorded, exact readback recorded, `ledger_write_claim: ALL_ELIGIBLE_WRITES_READBACK_VERIFIED` |
| 7 | execute again, **same** `request_id` | Idempotent replay — same object ID, no new write |
| 8 | execute again, **different** `request_id` | Same object ID, no new write |
| 9 | prepare a **brand-new case** with identical document facts (user restating the same bill) | **Refused at prepare**: `CONFLICT` / `ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED`, `provider_mutation_possible: false` |
| 10 | `xero_get_accounting_case_status` | `TERMINAL`, one operation `READBACK_VERIFIED`; `source_truth_claim: NOT_VERIFIED`, `original_file_verified: false` |

**Server audit: `provider_write_count: 1`** across three execute calls and a
restated case. Idempotency key `xmr_9c6decabc64b3cf013502d46c4379148`, receipt
operation `CREATE_ACCREC_DRAFT`.

This closes Definition-of-Done item 8 — "同一业务单据重复表达、重试或会话恢复不会创建第二张 Xero 单据" —
which no previous run had demonstrated. Duplicate protection holds at three
independent layers: same-key replay, different-key re-execution, and a fresh case
reserving the same business coordinate.

The status tool also refuses to over-claim: coverage is reported as complete for
the *submitted set only*, while source truth and original-file verification stay
explicitly unverified.

## 4. XF-021 — the Definition of Done names an object the product refuses

`xeroDocumentCoordinateAuthority` (`src/policy/xeroBusinessCoordinateAuthority.ts:26-49`)
classifies each route's uniqueness authority:

| Route | Reference kind | Uniqueness authority |
|---|---|---|
| `SALES_INVOICE` | `FORMAL_DOCUMENT_NUMBER` | `PROVIDER_ENFORCED_UNIQUE` |
| `CUSTOMER_CREDIT` | `FORMAL_DOCUMENT_NUMBER` | `PROVIDER_ENFORCED_UNIQUE` |
| **`SUPPLIER_BILL`** | any | **`NON_UNIQUE_EXCLUSIVE_WRITER`** |
| `SUPPLIER_CREDIT` | any | `NON_UNIQUE_EXCLUSIVE_WRITER` |
| any | `GENERIC_RECURRING_REFERENCE` | `NON_UNIQUE_EXCLUSIVE_WRITER` |

This is faithful to Xero: an ACCREC invoice number is unique per tenant, an ACCPAY
bill number is not. Where the provider cannot guarantee uniqueness atomically, the
service (`src/services/xeroAccountingCaseService.ts:846-874`) requires the writer to
prove exclusivity instead:

```text
writerAuthority.mode === "VERIFIED_FIRM_GOVERNANCE"
writerAuthority.providerAtomicUniqueness === false
writerAuthority.governanceAuthorityActive === true
```

Absent that, autonomous create is refused with
`PROVIDER_BUSINESS_COORDINATE_ATOMICITY_UNPROVEN` and
`recoveryAction: CONFIGURE_VERIFIED_EXCLUSIVE_WRITER_OR_USE_MANUAL_REVIEW`.

**The product is right and the plan is wrong.** Refusing to autonomously create a
document whose uniqueness it cannot guarantee is exactly the behaviour an
accounting system should have. But the round's Definition of Done selected the
Supplier Bill as its fixed object *and* declared firm governance out of scope, so
as written the round cannot pass. Neither environment has the required authority:
the local harness configures none, and the deployed instance reports
`firmGovernance.status: NOT_REQUIRED`, `authorityCount: 0`.

Three ways forward, in the user's hands:

1. Configure verified firm-governance exclusive-writer authority in both
   environments and keep the Supplier Bill as the test object.
2. Change the round's fixed object to a Customer Invoice with a formal document
   number — the route that is provider-enforced unique, and the route every
   passing run to date has actually exercised.
3. Accept Supplier Bill at `REVIEW_REQUIRED` — prepared, not autonomously created —
   and move the write to an explicit human-approval path.

Option 2 matches what has actually been tested; option 1 is the only one that
delivers what the plan currently promises.

## 5. Definition of Done coverage after these runs

| # | Requirement | Status |
|---:|---|---|
| 1 | Fixed object is one Supplier Bill DRAFT, existing Contact/Account/Tax | **NOT MET** — refused by design (XF-021) |
| 5 | Local acceptance is not read-only; real write + receipt + readback | MET at the synthetic boundary, on the customer-invoice route |
| 7 | Success requires object ID + receipt + same-ID readback | MET — all three present, no claim without them |
| 8 | Repetition/retry/session recovery creates no second document | **MET** — `provider_write_count: 1`, three independent guards |
| 9 | Wrong tenant, stale target, missing scope, closed write gate, unsupported action fail closed | PARTIALLY MET — unknown counterparty, delegation mismatch and coordinate-atomicity refusals all proven; wrong-tenant and stale-target not exercised in these sessions |

## 6. Harness change made to enable this testing (XF-019)

`harness/runners/run-p0-accounting-case.ts` only. No `src/` change, no test change.

- Implemented `createDraftSupplierBill`, mirroring `createDraftSalesInvoice`
  exactly: same write-gate check, same
  `consumeXeroProviderWritePermitAtMutationBoundary` call with
  `adapterOperation: "XeroAccountingProvider.createDraftSupplierBill"` and
  `actionId: "supplier_bill.create_draft"`, same write counter, same tax/total
  computation and the same `economicMutation` fault-injection hook, producing an
  `ACCPAY` DRAFT under a distinct object ID `55555555-5555-4555-8555-555555555555`.
- Implemented `getSupplierBill` for exact readback of that stored document.
- Added `supplier_bill.create_draft` to both standing-delegation fixtures.

No control was weakened, bypassed or special-cased.

Verification: `npm run typecheck` PASS; targeted set
(`local-agent-accounting-case-mcp`, `xero-accounting-case-ap-kernel-e2e`,
`xero-accounting-case-kernel-e2e`, `local-agent-deployment-equivalent`, serial)
4 files / 12 tests PASS; full suite 146 files / 1,562 tests with 24 failures —
down from the 26-failure baseline, all remaining failures in the experimental
governance tooling tracked as XF-011, none in product runtime.

Note the candidate fingerprint above was computed before this harness change. The
frozen candidate must be recomputed before any deployment.
