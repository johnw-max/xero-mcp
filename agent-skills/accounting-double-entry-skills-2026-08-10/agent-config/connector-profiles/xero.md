# Connector profile: Xero formal ledger

## Role

- `ledger_sor`

Map only mounted tools after the platform verifies the connection, tenant binding, scopes, permission, object support, and current write gate:

| Tool | Capability ID | Supported object types | Control requirement |
|---|---|---|---|
| `xero_connection_status` | `connector.connection.status.read` | `connector_control_plane`: connection health and bound-connection display | Server-resolved connection; never target proof by itself |
| `xero_get_organisation` | `ledger.target.resolve` | Xero organisation | Bound tenant, `xero.read` |
| `xero_list_accounts` | `ledger.reference.accounts.read` | Account | Bound tenant, `xero.read` |
| `xero_list_tax_rates` | `ledger.reference.tax.read` | Tax rate | Bound tenant, `xero.read` |
| `xero_list_contacts`, `xero_get_contact`, `xero_search_contacts` | `ledger.reference.counterparty.read` | Contact | Bound tenant, `xero.read` |
| `xero_list_invoices`, `xero_list_credit_notes`, `xero_list_payments`, `xero_list_bank_transactions`, `xero_list_manual_journals`, `xero_list_quotes`, `xero_list_purchase_orders` | `ledger.transaction.search` | Invoice/Bill, CreditNote, Payment, BankTransaction, ManualJournal, Quote, PurchaseOrder | Bounded read |
| `xero_get_invoice`, `xero_get_supplier_bill`, `xero_get_bank_transaction`, `xero_get_manual_journal`, `xero_get_quote`, `xero_get_purchase_order` | `ledger.object.read_exact` | Exact returned accounting object | Exact provider object ID |
| `xero_list_items`, `xero_get_item` | `ledger.reference.item.read` | Item | Bounded list or exact provider object ID |
| `xero_prepare_accounting_case` | `ledger.accounting_case.prepare` | Ordinary business-document intake compiled to a typed Case and deterministic native-operation plan | Submit source labels, documents, source-declared amounts and only genuinely new contacts; the server derives internal identities and resolves the current target, account/tax fields and routes; mandatory document validity, supplied-set coverage, accounting equations and whole-plan persistence; no provider write |
| `xero_execute_accounting_case` | `ledger.accounting_case.execute` | Current Case version; Contact, Invoice, Bill and CreditNote DRAFT operations only | Platform-bound, currently valid standing delegation for the same target/action/scope; runtime revalidates exact target/scope/write gate, deterministic validation, durable preflight, idempotency, one-shot provider permit, provider receipt and exact read-back; no confirmation phrase or per-item approval |
| `xero_get_accounting_case_status` | `ledger.accounting_case.status.read` | Exact durable Case version and recovery state | Same bound target, or renewed same-organisation read-only recovery; never creates or retries a provider write |
| `xero_get_trial_balance` | `ledger.report.trial_balance.read` | Trial Balance | Exact tenant/date/basis; report bounds retained |

`xero_connection_status` is connection health, not a verified ledger target or accounting outcome. Contact/item/quote/purchase-order mutation tools are outside this candidate's accounting-entry execution route unless a later profile maps and validates them explicitly.

## Provider semantics

- Prefer native bill, invoice, payment, credit-note, bank-transaction, and transfer objects for routine activity, but release only routes implemented by the current Case compiler. Payment, bank fee, prepayment, employee expense, FX settlement, opening balance and reconciliation writes remain explicitly unsupported.
- Treat Xero `DRAFT` as unposted for this profile. It is always `PROVIDER_DRAFT_UNPOSTED`, never `POSTED_READBACK_VERIFIED`.
- Bind every capability to the authorized tenant; never accept a tenant replacement from user text.
- Before exposing current organisation, currency, accounts, contacts, transactions, or reports as business facts, return the normalized target/provenance envelope in the capability contract. Every later read must match the target reference and binding revision returned by `xero_get_organisation`; otherwise stop at `TARGET_UNVERIFIED`, `TARGET_CONFLICT`, or `READ_EVIDENCE_REJECTED`.
- A natural-language business execution request is not permission. The typed Accounting Case uses the platform-bound standing-delegation path; do not ask for a confirmation phrase or per-item approval. The runtime must still revalidate the exact Case version, target, scope, write gate, deterministic validation, idempotency, one-shot permit, provider receipt, and exact read-back.

## Current evidence boundary

The 0.4.0-rc.1 local release contract exposes exactly 29 public tools. The only mutation entry points are the three typed Accounting Case tools above; legacy object-specific prepare/create tools and browser approval are not public. All actual provider creates remain behind the embedded ledger-control kernel and a one-shot permit.

The current Case compiler can plan basic contacts plus native Invoice, Bill and CreditNote objects in `DRAFT`. A Case is not a write receipt. Execution is successful only when each eligible operation has a provider object ID, a durable provider receipt and an exact matching read-back. Unknown outcomes prohibit blind or new-key retry; runtime may perform at most one controlled recovery in the provider-native idempotency window for the same request and same idempotency key under a durable single claim, then enters GET-only recovery. A model statement such as "written" without those receipts is not an accounting outcome.

`TEST_OR_NOT_VALID` documents are eligible only for a server-owned TEST tenant. `VALID_FOR_LIVE_BOOKS` is required for a production target. `UNKNOWN` or a missing validity state blocks the whole Case before any provider operation. Supplier-bank verification marked `PENDING_CALLBACK` cannot be upgraded to `VERIFIED` by an `AGENT_ASSERTED` fact; the related hard control continues to block new uncleared payments or bank-detail changes while preserving already-cleared historical events for recognition and reconciliation.

Every Accounting Case response keeps source truth separate from ledger completion. For the current submitted/model-extracted intake it must report `source_claim.source_truth_claim=NOT_VERIFIED` and `original_file_verified=false`. A successful provider receipt and exact same-ID readback can verify the ledger draft only; it must never be restated as verification of the original file, uploader, or real-world completeness.

This profile describes the local release candidate, not proof of deployment. It remains not live-ready until the exact build, migrations, OAuth scopes, tenant binding, Agent2 execution and Work-surface read-back pass isolated online UAT. The mapped write path reaches only `PROVIDER_DRAFT_UNPOSTED`; it does not prove effective posting, payment, reconciliation, period lock or close.
