# Connector profile: QuickBooks formal ledger

## Role

- `ledger_sor`

Map only mounted tools after the platform verifies the connection, Realm binding, scope, permission, object support, and current write gate:

| Tool | Capability ID | Supported object types | Control requirement |
|---|---|---|---|
| `quickbooks_connection_status` | `connector.connection.status.read` | `connector_control_plane`: connection health and bound-connection display | Server-resolved connection; never target proof by itself |
| `quickbooks_get_company` | `ledger.target.resolve` | QuickBooks Company | Bound Realm, `quickbooks.read` |
| `quickbooks_list_accounts` | `ledger.reference.accounts.read` | Account | Bound Realm, read scope |
| `quickbooks_list_tax_codes` | `ledger.reference.tax.read` | TaxCode | Bound Realm, read scope |
| `quickbooks_search_vendors`, `quickbooks_search_customers` | `ledger.reference.counterparty.read` | Vendor, Customer | Bounded read |
| `quickbooks_list_items` | `ledger.reference.item.read` | Item | Bounded read; reference support only |
| `quickbooks_list_bills`, `quickbooks_list_transactions` | `ledger.transaction.search` | Bill and supported transactions | Bounded read |
| `quickbooks_get_bill`, `quickbooks_get_transaction` | `ledger.object.read_exact` | Exact Bill/transaction | Exact provider object ID |
| `quickbooks_run_report` | `ledger.report.read` | Supported report | Bounded report request |
| `quickbooks_prepare_supplier_bill` | `ledger.transaction.native.prepare` | Bill proposal outside QuickBooks | `quickbooks.bill.prepare`; no ledger write |
| `quickbooks_get_trial_balance` | `ledger.report.trial_balance.read` | Trial Balance | Exact Realm/date/basis |

`quickbooks_connection_status` is connection health, not a verified ledger target. `quickbooks_hash_source_document` is a control helper. Item-list reads are reference support but are not an accounting execution capability. No currently exposed Agent tool maps to `ledger.transaction.native.execute` or `control.approval.verify`.

## Provider semantics

- Prefer native Bill, Invoice, Payment, Expense, Transfer, Credit Memo, and related objects for routine activity.
- Do not invent a Xero-like provider `DRAFT` state. A platform `PREPARED` review object remains outside QuickBooks until the approved execution succeeds.
- Bind every capability to the authorized Realm; never accept a Realm replacement from user text.
- Do not activate a read mapping as authoritative business evidence until its normalized receipt carries the current safe target reference, Realm binding revision, observation time, query bounds/completeness, audit reference, output hash, and field bindings required by the capability contract.

## Current evidence boundary

The local QuickBooks codebase contains a controlled service with company/account/tax/vendor/Bill/Trial-Balance reads, proposal preparation, human-review gates, idempotency, and exact-read-back logic. Its real Sandbox/online write route was not established by the latest evidence reviewed for this candidate.

The currently mapped Agent tools can reach only `PREPARED_UNPOSTED`. A future approved execution path must be mounted and mapped separately before this profile can claim `POSTED_READBACK_VERIFIED`.
