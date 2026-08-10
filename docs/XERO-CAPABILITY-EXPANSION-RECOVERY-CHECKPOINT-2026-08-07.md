# Xero capability expansion recovery checkpoint — 2026-08-07

## Objective

Expand the Xero MCP from supplier-bill-only controlled writing into a broad,
accountant-usable surface while keeping every write tenant-bound, explicitly
confirmed, idempotent, audited, and read-back verified.

## Recovery result

- The interrupted desktop task stopped its worker processes; it did not remove
  or roll back shared workspace files.
- No interrupted candidate was deployed. The public service remains the last
  known deployed release until a new deployment is independently verified.
- The local controlled-mutation foundation, Quote/Purchase Order DRAFT slice,
  Credit Note/Manual Journal primitives, and Contact/Item primitives survived.
- Recovery regression on 2026-08-07: 79/79 focused tests passed.
- The only interrupted half-slice was Contact/Item service integration. It left
  strict optional-property type errors in `xeroContactItemCanonical.ts`; this is
  being completed before any central registration or deployment.

## Completed local evidence

- Mutation foundation: server challenge, tenant/binding isolation,
  `sourceUnitKey`, idempotency, explicit provider-rejected vs unknown outcomes,
  typed read-back closure, PostgreSQL constraints/triggers/readiness checks.
- Fresh PostgreSQL required suite before interruption: 28/28 passed; the
  temporary database container was removed.
- Quote and Purchase Order: prepare + exact-confirmed DRAFT create + exact
  read-back.
- Credit Note and Manual Journal: strict DRAFT-only canonical primitives and
  provider read-back verifiers.
- Contact and Item: safe primitives, external ContactNumber preservation,
  untracked-item boundary, stale-version checks.
- Granular OAuth correction: Invoice/Credit Note/Quote/Purchase Order accept
  `accounting.invoices(.read)` while retaining legacy transaction scopes only as
  compatibility alternatives.

## Work still required before release

1. Finish Contact/Item and Credit Note/Manual Journal controlled service slices.
2. Register the reviewed tools centrally and update policy, OAuth scopes,
   allowlist, version, and user-facing capability documentation.
3. Run typecheck, build, full unit suite, required HTTP suite, and a fresh
   PostgreSQL required suite.
4. Perform independent code/security review and resolve all P0/P1 findings.
5. Deploy with writes closed, verify version/toolset/health, renew Xero OAuth,
   then run Agent2 read UAT and tightly controlled synthetic DRAFT writes.
6. Close the write gate after UAT and record exact write/read-back receipts.

## Product boundary retained

- Never expose payment, receive/spend money, delete, void, final posting,
  authorisation, or final bank reconciliation as ordinary Agent writes.
- Reconciliation is read/analysis only; final reconciliation remains in Xero.
- Attachment upload requires a trusted Work file-staging receipt. Arbitrary URL,
  local path, or raw Base64 upload is not an acceptable production shortcut.
- Contact/Item writes commit master data and therefore require explicit
  confirmation even though they do not have a Xero DRAFT state.

