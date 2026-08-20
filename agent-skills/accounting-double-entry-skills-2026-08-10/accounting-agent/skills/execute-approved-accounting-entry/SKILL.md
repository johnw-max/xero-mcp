---
name: execute-approved-accounting-entry
description: Execute an already reviewed and balanced accounting-entry proposal through an authorized formal-accounting capability, then verify the exact result. Use when the user explicitly asks to record, submit, post, or save a supplier bill, customer invoice, payment, receipt, expense, transfer, credit note, manual journal, or accounting adjustment. For the R1 Xero typed Accounting Case, preserve the current OAuth target, immutable Case version, released action, write gate, idempotency, receipt, and exact read-back; do not add a per-transaction approval or confirmation flow.
---

# Execute Approved Accounting Entry

Turn one approved balanced proposal into the highest state supported by the mounted authorized capabilities. Keep business authorization semantics and accounting meaning in this Skill; leave provider API mapping, tenant enforcement, deterministic validation, and data transfer to the runtime/MCP adapter.

Treat any entity/company name from user text, remembered conversation, or an example as `USER_ASSERTED`: it is a request label, not proof of the authorized ledger target. Ledger-scoped facts or actions require current matching `HOST_BOUND` or `MCP_READ` evidence; otherwise mark the ledger target unverified, do not fill it from memory, and do not merge conflicting targets.

Enforce the evidence contract for the destination role. Treat a bare `ledger_sor` payload such as `{result: ...}` as `READ_EVIDENCE_REJECTED`: it cannot prove the current organisation, base currency, accounts, tax, balances, transactions, reports, posting, reconciliation, or close. A source- or work-store read may support only the material or review object identified by its own authorized receipt; it never proves a ledger fact. Continue from user-visible facts only at the highest non-ledger state they support.

## Required business package

Require all of the following before any formal-accounting write:

- one authorized entity or accounting file, period, transaction date, and currency basis;
- one immutable proposal reference and source references;
- the intended business transaction kind and native-versus-manual-journal route;
- two or more lines with valid mapped accounts/tax treatment and exact base-currency debit/credit equality;
- a duplicate/idempotency key bound to entity, destination, source, action, and proposal digest;
- for an R1 Xero typed Accounting Case, the current OAuth binding and pinned target session, effective scope, released policy and server write gate for the same action;
- an explicit natural-language business request to perform the write. This request expresses business intent; it is not permission by itself.

If the user supplied only raw facts or an unreviewed treatment, route first to `prepare-balanced-accounting-entry`. Do not turn chat text, an uploaded note, a file ID, or a connector name into a tenant, action, or execution payload. The natural-language request expresses business intent; the current OAuth target and immutable typed Case remain authoritative.

## Route by semantic capability

1. Identify the business intent before selecting a tool. Do not change the accounting treatment because the connector brand changed.
2. Inspect only the mounted actions exposed by the host and their authorized schemas/receipts. Match the required semantic capability, not a hard-coded MCP server or tool name.
3. Classify each destination independently as `source store`, `work/review store`, or `formal accounting ledger`. One workflow may read evidence from one connector and write the approved accounting record through another.
4. Choose the highest safe route:
   - no external capability: keep the approved package in chat as `READY_FOR_MANUAL_POSTING`;
   - source/work-store persistence action: save the proposal or handoff only when requested and report `PROPOSAL_SAVED_OUTSIDE_LEDGER`, even when a ledger connector is also mounted but was not used for this action;
   - formal-ledger read only: validate available master data and report `PREPARED_UNPOSTED`;
   - formal-ledger draft write plus read-back: report the exact provider draft state as `PROVIDER_DRAFT_UNPOSTED` when it is not ledger-effective;
   - formal-ledger effective write plus exact read-back: report `POSTED_READBACK_VERIFIED` only after every control below passes.
5. If the required capability is missing, stop at the highest supported state. Never substitute a generic file, spreadsheet, review record, or another destination for a formal-ledger action.

## Controlled execution

1. Resolve the platform-authorized destination binding and require current target evidence with a safe target reference and binding revision. Never accept a tenant, realm, organisation, company-file, folder, or workbook locator supplied only in user text as authorization. Treat missing, stale, failed, or conflicting target evidence as `EXECUTION_BLOCKED`.
2. Re-read live entity context, accounts, tax treatment, currency, and period status when those formal-ledger reads are required for the action.
3. For an R1 Xero typed Accounting Case, revalidate the current OAuth binding and pinned target session, effective scope, released policy and server write gate for the same action. A natural-language business execution request is not a tenant, action or execution payload. The organisation-selection URL is the only user confirmation flow; do not ask for a confirmation phrase, signature, approval token or per-item approval. The runtime must still revalidate target, scope, policy, write gate, deterministic validation, idempotency, one-shot permit, receipt, and exact read-back before and after the provider action.
4. Recalculate the proposal digest and debit/credit totals. Refuse changed, stale, unbalanced, invalid-period, unmapped, or authorization-mismatched proposals.
5. Prefer the provider adapter's native supplier-bill, customer-invoice, payment, receipt, expense, transfer, or credit-note capability. Use manual journal only when the approved business treatment requires it.
6. Start with one provider write attempt using the stable idempotency key. If the result is timeout, ambiguous, or `outcome unknown`, prohibit blind retry and prohibit a new-key retry. The runtime may perform at most one controlled recovery only while the provider-native idempotency window is open, for the same request and same idempotency key, under a durable single claim. Then query the original attempt or exact business record when supported; when recovery/query is unavailable, retain `OUTCOME_UNKNOWN` and route to manual investigation without resubmission.
7. Capture the execution receipt, safe destination reference, provider record type/ID, returned state, revision/time, and audit reference.
8. Read back that exact record and compare target reference/binding revision, entity, record type, period/date, currency, counterparty when relevant, line totals, mapped accounts/tax, source/proposal reference, and provider state. Reject a read result that lacks its target/provenance envelope.
9. Determine whether the read-back confirms a ledger-effective state that actually affects the formal ledger or reports. A saved proposal, preparation receipt, file upload, work record, or provider `DRAFT` is not posted.
10. Report posting, Trial Balance, reconciliation, and close as separate states. Do not infer the latter three from a successful transaction write.

## Hard controls

- Require the MCP/runtime to enforce the current OAuth target, typed Case/action scope, write gate, valid accounts/tax/period, exact debit/credit equality, idempotency, legal state transition, one-shot permit, receipt, and exact read-back deterministically. Skill reasoning does not replace these controls.
- Do not expose or invent raw provider IDs, connector secrets, OAuth credentials, folder IDs, workbook ranges, or provider-specific fields that are not returned through the authorized binding.
- Do not silently change a native transaction into a manual journal, change the destination, weaken tax/account mapping, or create a suspense plug merely because one capability is unavailable.
- Treat a definitive successful write receipt without successful exact read-back as `WRITE_RESULT_UNVERIFIED`, not posted. This remains true when exact read-back is supported but the attempt fails, is partial, or times out. Treat a timeout or ambiguous execution result as `OUTCOME_UNKNOWN`; prohibit blind or new-key retry, while allowing at most one runtime-controlled recovery in the provider-native idempotency window for the same request and same key under a durable single claim. Query the original attempt/idempotency outcome when supported; otherwise investigate manually. Treat conflicting read-back as `WRITE_RESULT_MISMATCH` and do not retry blindly.
- Use reversal, credit-note, void, or correcting-entry capabilities for an already posted record according to the formal system's supported lifecycle. Never overwrite the evidence chain.
- A source/work-store receipt proves only that material, proposal, or workflow state was stored there. It never proves the formal ledger changed.

## Output shape

Lead with exactly one state: `READY_FOR_MANUAL_POSTING`, `PROPOSAL_SAVED_OUTSIDE_LEDGER`, `PREPARED_UNPOSTED`, `PROVIDER_DRAFT_UNPOSTED`, `WRITE_RESULT_UNVERIFIED`, `OUTCOME_UNKNOWN`, `WRITE_RESULT_MISMATCH`, `POSTED_READBACK_VERIFIED`, or `EXECUTION_BLOCKED`.

Then show:

1. entity, period, transaction kind, proposal/source references, totals, and Case/proposal version;
2. destination role and semantic capability used or missing;
3. action receipt and exact read-back comparison when an external action occurred;
4. what changed and what did not change;
5. independent Trial Balance, reconciliation, or close evidence still required.

Use [references/capability-routing.md](references/capability-routing.md) for the portable intent envelope, capability matrix, and connector examples.
