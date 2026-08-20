# Connector profile: Xero formal ledger

## Role and composition

- Role: `ledger_sor`.
- Xero is the only formal ledger.
- Google Drive is the source-material storage/sync layer.
- Accounting Skills/Agent interpret the material and call bounded MCP capabilities.

Do not merge Drive receipts, Agent answers, and Xero ledger outcomes into a generic `completed` result.

## Public capability contract

The public tool surface is derived from `config/xero-capability-manifest.json` and `src/mcp/toolNames.ts`; never pin a numeric count in this profile.

The only public mutation entry points are:

- `xero_prepare_accounting_case`;
- `xero_execute_accounting_case`;
- `xero_get_accounting_case_status`.

Legacy object-specific mutation tools, raw JSON/endpoint tools, and generic CRUD are not public.

Current code-reachable Case actions are Contact/Item basic maintenance; DRAFT create/update for Customer Invoice, Supplier Bill, Credit Note, Quote, Purchase Order, and Manual Journal; Invoice/Bill/Credit Note authorise; Manual Journal post; Payment create/reverse; Bank Transaction create/update/reverse; Credit Note allocate/refund/unallocate/void; Invoice/Bill/Manual Journal void; and safe Tracking Category/Option create/update. These actions remain `NOT_READY` for release until their complete manifest rows have frozen real PostgreSQL and live Xero evidence.

## Organisation binding

- Every ledger call uses the server-resolved OAuth installation/binding and current target session.
- User or Agent text cannot provide or replace a Tenant ID.
- The only user confirmation flow is the existing URL returned by `xero_start_organisation_switch`; the user selects one already-authorized Xero organisation there, then the Agent pins and re-reads Organisation.
- Do not add confirmation phrases, signatures, approval tokens, or another confirmation state machine to accounting actions.

## Write success

A Case or Agent statement is not a write receipt. A successful write requires:

1. the intended typed action was accepted for the current OAuth binding and target session, effective scope, released policy, server write gate and object state;
2. Xero returned the provider object ID/receipt;
3. the same object was read back exactly and required fields/status matched;
4. an uncertain timeout did not trigger a blind new create.

Xero Payment or Bank Transaction records are ledger facts, not instructions to a bank. Real external fund initiation/release remains outside this connector.

## Online acceptance

Validate the frozen candidate using natural user language and real-shaped Drive materials through the online Google Drive MCP + current Accounting Skills/Agent + candidate Xero MCP. Exercise the real organisation-selection URL when switching organisations, then prove reads and writes with Xero read-back and Journals where applicable.

This profile is configuration, not proof of deployment. Local tests, a Drive file, or provider code alone cannot mark a manifest row `READY`.
