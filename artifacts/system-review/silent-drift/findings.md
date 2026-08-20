# silent-drift — findings

Scope: `src/**`, plus `migrations/*.sql` (read because two ranked findings live there) and brief
cross-reference into `harness/**` and `docs/**` (read-only, clearly marked, not enumerated).
Branch `codex/xero-org-switch-governance-20260810`. Four other agents were editing `src/`
concurrently for the entire duration of this review — see "Live-tree caveat" at the end.

No file under `src/`, `tests/`, `harness/`, `deploy/`, or `scripts/` was modified to produce this
report. The only writes are the three files in this directory.

Every finding below is keyed to `coverage.json` via its `finding_ids`. IDs are ranked by
consequence (money/authority first), not by discovery order or count of shadow sites.

**Numbering vs. ranking**: SR-01 through SR-14 are numbered in the order they were found. SR-15 was found after SR-14, late in the review, but belongs — by consequence — immediately after SR-04 in severity; it is placed there in the document below. The overall priority order used in the final summary is: **SR-01, SR-03, SR-04, SR-15, SR-02, SR-14, SR-05, SR-06, SR-13, SR-07/SR-08 (mitigated), SR-09/SR-11/SR-12 (structural, currently sound), SR-10 (low-risk cluster)** — money/authority-affecting and already-live items first, per the task's own ranking instruction.

---

## SR-01 — Ternary chain silently misroutes a new `NativeDocumentRoute` (task-confirmed instance)

| Field | Content |
|---|---|
| Union shadowed | `NativeDocumentRoute` (`src/domain/accountingCase.ts:131-135`, 4 members) |
| Evidence | `src/policy/xeroBusinessCoordinateAuthority.ts:34-40` — `const authoritativeProviderField = route === "SALES_INVOICE" ? generic ? "REFERENCE" : "INVOICE_NUMBER" : route === "SUPPLIER_BILL" ? "INVOICE_NUMBER" : route === "CUSTOMER_CREDIT" ? generic ? "REFERENCE" : "CREDIT_NOTE_NUMBER" : "CREDIT_NOTE_NUMBER";` — final `:` is an unconditional catch-all, not a check against `"SUPPLIER_CREDIT"`. |
| Evidence class | READ (given as confirmed in the task brief; independently re-read in full, current as of this review — file is not among those being concurrently edited) |
| Falsification | Traced `xeroDocumentCoordinateAuthority`'s ~10 call sites (`grep -rn "xeroDocumentCoordinateAuthority\|authoritativeProviderField\|uniquenessAuthority"`) into `ledgerControlKernel.ts`, `xeroBusinessCoordinateHistory.ts`, `xeroAccountingCaseExistingDocumentEvidence.ts`, `xeroExternalGovernanceAuthority.ts`, `xeroFirmGovernanceClaim.ts`, `xeroAccountingCaseProviderContract.ts` — every one trusts this function's output as the coordinate the duplicate-prevention hash is keyed on; none independently re-derives or double-checks the field choice. No `never`-exhaustiveness guard anywhere upstream of this ternary catches a 5th route — confirmed by reading the whole file, twice, once at the start of the review and once at the end. |
| Impact | A 5th `NativeDocumentRoute` member (plausible: the concurrently-landing `CommercialDocumentRoute` work already shows the appetite for new route-like values, see "Live-tree caveat") would be silently assigned `CREDIT_NOTE_NUMBER`/non-unique-exclusive-writer coordinates — the credit-note shape — regardless of what it actually is. That value feeds the business-coordinate uniqueness hash duplicate-prevention keys on. `tsc` stays green. |
| Codex migration legacy | Unknown/no. `git log` shows continuous same-team AI-assisted development (single-author commits, `Co-Authored-By: Claude Opus 5`), not a discrete tool-migration event. This function has existed with this shape since `d7f718a` ("feat: add ledger control kernel..."), i.e. from very early in the project's history, not left behind by a later migration. |

---

## SR-02 — `NativeDocumentRoute`/coordinate-field vocabulary re-hand-written at ≥8 independent sites, including a second, untouched zod-enum twin of the confirmed instance

| Field | Content |
|---|---|
| Union shadowed | `NativeDocumentRoute` (4 members) and `XeroAuthoritativeDocumentProviderField` (3 members) / `AccountingDocumentReferenceKind` (2 members) |
| Evidence | Task-confirmed original: `src/policy/xeroBusinessCoordinateAuthority.ts:51-56` (`routeSchema = z.enum([...])`). **New, independent second copy**: `src/policy/xeroExternalGovernanceAuthority.ts:40-46` — `const routeSchema = z.enum(["SALES_INVOICE","SUPPLIER_BILL","CUSTOMER_CREDIT","SUPPLIER_CREDIT"]); const providerFieldSchema = z.enum(["INVOICE_NUMBER","CREDIT_NOTE_NUMBER","REFERENCE"]);`. This file *imports* `xeroDocumentCoordinateAuthority` from `xeroBusinessCoordinateAuthority.ts` but does **not** import or reuse its `routeSchema`/`providerFieldSchema` — it re-hand-writes both from scratch. Plus 6 more restatements of the same 2 small enums inside `xeroBusinessCoordinateAuthority.ts` itself (lines 61-62, 105, 210-211, 229), 1 more in `xeroExternalGovernanceAuthority.ts:97` (`reference_kind`), and a 2-of-3 subset in `domain/schemas.ts:169` (`invoiceAuthoritativeProviderFieldSchema`) plus 2 more subsets in `xeroCreditNoteManualJournalDraft.ts:80,292`. |
| Evidence class | READ — every site opened and its literal member list read and compared. |
| Falsification | Checked whether `xeroExternalGovernanceAuthority.ts`'s copy is dead code — it is not: `coverageSchema` (line 95-100) embeds `route: routeSchema` and gates `authorityCoverageSchema`-shaped trust-bundle coverage entries used to verify **externally-signed (Ed25519) firm-governance authority**, a materially different and higher-trust boundary than the original. Checked whether a shared import would have been natural — yes; the file already imports 4 other symbols from the sibling module, so the duplication is not a build/circularity constraint, just an omission. |
| Impact | A 5th route added to `NativeDocumentRoute` needs this schema fixed **twice**, in two files, independently, or an externally-issued (cryptographically signed, cannot be silently re-issued by the server) governance trust bundle referencing the new route is rejected at parse time — same failure shape as the original confirmed instance, at a second boundary. |
| Codex migration legacy | No specific evidence of a migration event; `xeroExternalGovernanceAuthority.ts` and `xeroBusinessCoordinateAuthority.ts` were built as siblings in overlapping commits with no indication one was meant to import from the other and simply didn't. |

---

## SR-03 — Contact duplicate-detection is blind to any future `NormalizedBusinessKey` kind (fails open)

| Field | Content |
|---|---|
| Union shadowed | `NormalizedBusinessKey["kind"]` (`src/domain/xeroContactItemPrimitives.ts:184`, 5 members: `COMPANY_NUMBER`\|`EMAIL`\|`ACCOUNT_NUMBER`\|`NAME`\|`ITEM_CODE`) |
| Evidence | `src/providers/xeroContactItemMutationProvider.ts:157-164` — `function rawBusinessValue(raw, key): string \| undefined { switch (key.kind) { case "COMPANY_NUMBER": ...; case "EMAIL": ...; case "ACCOUNT_NUMBER": ...; case "NAME": ...; case "ITEM_CODE": ...; } }` — no `default`, and the declared return type already includes `undefined`, so `noImplicitReturns` (not enabled anyway — see systemic note) is irrelevant: this compiles clean today and would continue to compile clean with a 6th kind unhandled. |
| Evidence class | READ, plus one EXECUTED probe confirming the general mechanism (probe1/probe4 series showed the *opposite* case — where TS *does* catch a missing case — so this entry's risk rests on the contrast: this function's return type already contains `undefined`, so none of those protections apply here). |
| Falsification | Traced the sole call site: `src/providers/xeroContactItemMutationProvider.ts:221` — `businessKeys.some((key) => rawBusinessValue(raw, key) === key.value)` inside `contactDuplicateExists`'s full-pagination scan. `undefined === key.value` is always `false` for a non-empty `key.value`. Grepped `tests/` for `NormalizedBusinessKey` and `rawBusinessValue` — zero references; no test-level guard exists either. |
| Impact | A 6th business-key kind (e.g. a future tax-number or phone-based dedup key) would make `rawBusinessValue` return `undefined` for every existing Xero contact, on every page, always. `contactDuplicateExists` would report "no duplicate" with full confidence — a false negative on every call — enabling silent duplicate-contact creation via that key, indefinitely, with zero error anywhere. |
| Codex migration legacy | No specific evidence; file has 2 commits total (`d7f718a`, `f1f8807`), both foundational. |

---

## SR-04 — Tax-applicability check already diverges on undefined between two live write paths (fail-open vs fail-closed)

| Field | Content |
|---|---|
| Union shadowed | The 5-member Xero account-class set (`ASSET`\|`EQUITY`\|`EXPENSE`\|`LIABILITY`\|`REVENUE`), independently declared 5+ times (see SR-05) |
| Evidence | `src/services/xeroControlledMutationService.ts:83-91` — `function taxApplies(tax, account): boolean { switch (account.class) { case "EXPENSE": return tax.canApplyToExpenses !== false; ... default: return false; } }`. Compare `src/policy/xeroTaxRateResolver.ts:63-71` — `tax.canApplyToExpenses === true` etc. — and `src/policy/xeroDeclaredLedgerBinding.ts:213-219`, whose comment states the design intent explicitly: *"an absent flag is read as 'not applicable' ... it stays fail-closed either way."* `TaxRateSummary`'s `canApplyTo*` fields are genuinely optional (`src/providers/types.ts:104-108`, `canApplyToExpenses?: boolean`), so `undefined` is a real, reachable value from Xero, not type-theoretic paranoia. |
| Evidence class | READ + EXECUTED (git archaeology) |
| Falsification | `git log --oneline -- src/services/xeroControlledMutationService.ts` → only `a2561ad`, `d7f718a`, `f1f8807` — never touched by `95fff90` ("refactor: make the MCP a ledger gateway that verifies instead of judging"), the commit whose own message says it *"fixes three defects the acceptance loop surfaced"* including tax-applicability, and which is where `xeroDeclaredLedgerBinding.ts`'s fail-closed comment was written. Traced `taxApplies` to its only caller, `exactActiveTax`, called from `#validateDocumentReferences` (line 471-490), which **blocks** (`throw safeValidation(...)`) Quote/PurchaseOrder draft creation if `exactActiveTax` returns `false` — confirming this is live, in the write-blocking gate, not dead code. |
| Impact | For a Quote or Purchase Order line, if Xero's `TaxRate` record omits (rather than sets `false` for) the `CanApplyToExpenses`-class flag relevant to the line's account, `xeroControlledMutationService.ts` accepts the tax/account pairing as valid (`!== false` is `true` for `undefined`) while `xeroTaxRateResolver.ts`/`xeroDeclaredLedgerBinding.ts` would reject the identical pairing for a Sales Invoice/Bill/Credit Note. The same real-world tax-rate-to-account combination is silently valid or invalid depending only on which object type is being drafted — a wrong, inconsistent financial-authority outcome that already exists in the shipped code, not a hypothetical future one. |
| Codex migration legacy | **Yes, functionally** — `95fff90`'s own commit message documents this exact defect class as something the acceptance loop found and fixed elsewhere; `xeroControlledMutationService.ts`'s copy was not touched by that commit and still carries the pre-fix semantics. |

---

## SR-15 — Readback-economics ternary chain has the identical shape to SR-01, and is *already*
## reachable by the concurrent work today (found late in this review; ranked here by severity,
## numbered 15 because it was found after SR-14 — see the ranking note at the top of this file)

Discovered via a broadened C1 grep run after noticing the original C1 command missed SR-01 itself.
This is arguably the single most urgent finding in this review: unlike SR-01 (whose union has not
yet been extended), this site's caller is *already* invoking it, unconditionally, for the
concurrently-landing Quote/PurchaseOrder work.

| Field | Content |
|---|---|
| Union shadowed | `NativeDocumentRoute \| "CONTACT_CREATE"`, mapped to `AccountingCaseReadbackExpectation` (a closed 3-member union: `NOT_A_NATIVE_DOCUMENT`\|`INVOICE_OR_BILL`\|`CREDIT_NOTE`, with **no commercial-document variant at all**) |
| Evidence | `src/policy/xeroAccountingCaseReadbackProjection.ts:147-161`, `validateXeroAccountingCaseReadbackEconomics()`: `const expectation: AccountingCaseReadbackExpectation = operation.nativeRoute === "CONTACT_CREATE" ? {...} : operation.nativeRoute === "SALES_INVOICE" ? {...} : operation.nativeRoute === "SUPPLIER_BILL" ? {...} : { applicability: "CREDIT_NOTE", providerStatus: "DRAFT", providerEvidenceObjectType: "CREDIT_NOTE" };` — the final `:` catches `CUSTOMER_CREDIT` and `SUPPLIER_CREDIT` correctly today, and would catch `"QUOTE"`/`"PURCHASE_ORDER"` identically, wrongly. The function's own doc comment: *"Pure fail-closed validator for the last Case success projection ... proves that the provider's observed economic values equal the immutable Accounting Case and its amount bridge exactly."* |
| Evidence class | READ |
| Falsification | Traced both call sites — `src/db/inMemoryRepository.ts:4949` and `src/db/postgresRepository.ts:8582` — both call this function **unconditionally** whenever `projectedState === "READBACK_VERIFIED"`, for any operation, with no route-based gate beforehand. Read the consumer, `validateAccountingCaseReadbackEconomics` (`src/control-kernel/accountingCaseReadbackValidator.ts:465-476`): its own 3-way dispatch on `expectation.applicability` *is* exhaustive relative to `AccountingCaseReadbackExpectation`'s type (TS can prove the final branch is exactly `"CREDIT_NOTE"` — that half is sound), which confirms a QUOTE/PURCHASE_ORDER operation's readback would definitely be routed into `validateCreditNote(...)`. Did **not** read `validateCreditNote`'s full body in the time available, so this report cannot certify the exact failure shape (very likely a loud `READBACK_MISMATCH`, given a Quote's readback JSON almost certainly lacks credit-note-specific fields — but not independently confirmed). |
| Impact | Once a Quote/PurchaseOrder write reaches provider-readback verification, its economics get checked against **credit-note** shape expectations instead of a shape that does not exist yet. Most likely outcome: every Quote/PurchaseOrder write fails readback verification with a misleading `READBACK_MISMATCH`, which is loud and would very likely be caught by basic manual/integration testing before this feature ships — tempering the "silent" severity relative to SR-01, but this is still a real, currently-inevitable defect blocking the concurrent feature, in the one function this codebase's own comments describe as proving financial-economics-equality "exactly." |
| Codex migration legacy | No — concurrent work in progress; this function itself predates the Quote/PurchaseOrder effort and has simply not been extended for it yet. |


---

## SR-05 — Xero `ContactStatus`/account-class vocabularies independently declared in 5+ places; the highest-stakes copy gates a contact-duplicate-prevention "complete scan" precondition

| Field | Content |
|---|---|
| Union shadowed | Xero `ContactStatus` (`ACTIVE`\|`ARCHIVED`\|`GDPRREQUEST`) and, separately, the account-class 5-set |
| Evidence | `src/services/xeroAccountingCaseService.ts` (private `type XeroContactLifecycleStatus = "ACTIVE" \| "ARCHIVED" \| "GDPRREQUEST"`, ~line 154) vs. the **inline** `for (const status of ["ACTIVE", "ARCHIVED", "GDPRREQUEST"] as const)` inside `#listAllContactsForIdentity` (~line 3078, shifted from 2904 by concurrent edits — see live-tree caveat) vs. `src/domain/schemas.ts:28`'s `z.enum(["ACTIVE","ARCHIVED","GDPRREQUEST"])` read-filter. Account-class 5-set: `KnownAccountClass` (private TS union, `xeroTaxRateResolver.ts:10`) vs. `accountClassSchema` zod enums independently declared in `xeroDeclaredLedgerBinding.ts:27` **and** `xeroTenantCoaProfile.ts:11` vs. `domain/schemas.ts:18`'s read-filter vs. the raw, untyped `switch (account.class)` case labels in `xeroControlledMutationService.ts:84` (SR-04). |
| Evidence class | READ |
| Falsification | Read `#listAllContactsForIdentity`'s full body: the loop drives a paginated, claimed-*complete* scan of Xero contacts across all 3 statuses, whose completeness is exactly what backs the `XERO_CONTACT_STRONG_IDENTITY_SCAN_INCOMPLETE` guard — i.e. this array is not cosmetic, it is the evidentiary basis for "we looked everywhere before deciding this isn't a duplicate." Checked whether Xero's `ContactStatus` is itself closed — it is not this codebase's to control; a 4th value added server-side by Xero would silently narrow the scan with zero code change anywhere in this repo. |
| Impact | If Xero ever returns a contact status outside `{ACTIVE, ARCHIVED, GDPRREQUEST}` (an external API-surface risk this codebase has no control over), or a future internal status is added without updating this one inline array, the "complete scan" precondition is satisfied having never examined that partition, and a genuine existing contact in that partition would not be found — exactly the class of bug that would let a duplicate contact through the strong-identity check silently. |
| Codex migration legacy | Unknown; both `d7f718a`-era. |

---

## SR-06 — `validationReasons`'s `default: return []` silently exempts fact kinds from all content validation

| Field | Content |
|---|---|
| Union shadowed | `AccountingFactKind` (13→14+ members as of this review — `COMMERCIAL_DOCUMENT` was added by the concurrent work during the review window) |
| Evidence | `src/control-kernel/accountingCaseCompiler.ts`, `validationReasons()` (~line 974-1081 at last read): explicit cases for `CONTACT_CANDIDATE`, `NATIVE_DOCUMENT`, `COMMERCIAL_DOCUMENT`, `PREPAYMENT`, `EMPLOYEE_EXPENSE`, `FX_SETTLEMENT`, `BANK_STATEMENT_SUMMARY`, `GOODS_RECEIPT_CONTROL`, `ORIGINAL_TRANSACTION_EVIDENCE`, then `default: return [];`. `PAYMENT`, `BANK_FEE`, `OPENING_BALANCE_REVIEW`, `EVIDENCE`, `CONTROL_FINDING` fall into the default. |
| Evidence class | READ, re-confirmed after concurrent edits landed (the default arm survived the `COMMERCIAL_DOCUMENT` addition — it was added as an explicit case, not folded into default, which is the correct move, but it demonstrates the default arm is still there for whatever comes next). |
| Falsification | Searched `accountingPolicyEnforcementContract.ts` and this file for `validatePayment`/`validateBankFee`/`validateOpeningBalance` — none exist, so no specific currently-required rule is silently bypassed today (this is not yet a live wrong-answer bug). Checked the disposition switch immediately below (`factDisposition`, same file): `PAYMENT`/`BANK_FEE` always resolve to `BLOCKED_UNSUPPORTED` and `OPENING_BALANCE_REVIEW` always resolves to `REVIEW_REQUIRED`, **regardless** of what `validationReasons` returned for them — so today's silent default has no live wrong-value consequence for these three specific kinds; they are blocked/reviewed by an independent, unrelated mechanism either way. |
| Impact | Forward-looking, not currently exploitable: this `default` is exactly where a *future* `AUTO_EXECUTE`-eligible fact kind's content validation would be silently swallowed. Unlike the disposition switch two functions below it (which is exhaustive, no default, and *is* `TS2366`-protected — see "Checked and sound"), this switch's explicit default arm defeats that protection entirely: adding a new fact kind here produces zero compiler signal that a validation rule was never written for it. |
| Codex migration legacy | No. |

---

## SR-07 — Cast-based `Record<>` bridges overclaim compiler protection their own comments assert exists

| Field | Content |
|---|---|
| Union shadowed | `XeroProviderWriteAdapterOperation` (10 members) vs. `XERO_WRITE_ACTIONS[...].providerAdapterOperation` (typed as plain `string` in `XeroWriteActionDefinition`, `domain/xeroWriteActions.ts`) |
| Evidence | `src/security/xeroProviderWritePermit.ts:28-39` — comment: *"Derived from the write-action registry rather than restated. A permit that named an adapter the registry does not know, or omitted one it does, used to be a silent gap; now the record type below cannot be satisfied without both."* Code: `Object.fromEntries(...) as Readonly<Record<XeroProviderWriteAdapterOperation, XeroAutonomousWriteAction>>`. Mirror in `src/services/xeroMutationService.ts:96-105` with an equivalent comment ("not a second list that has to agree with it"). |
| Evidence class | READ + EXECUTED |
| Falsification | Built `tsprobe/probe5.ts`: `Object.fromEntries(...) as Readonly<Record<Op, Action>>` where the runtime array covers only 3 of a 4-member `Op` type, then accessed the result via a typed lookup — **zero compile error**, even with `noUncheckedIndexedAccess: true` (this repo's actual setting). This proves the comment's claim is false for a cast — a cast bypasses TypeScript's element-wise completeness check entirely; only a plain annotation or `satisfies` (verified separately, `probe4.ts`) provides it. Directly compared the two 10-member lists (`XERO_PROVIDER_WRITE_ADAPTER_OPERATIONS` vs. every `.providerAdapterOperation` value in `XERO_WRITE_ACTIONS`) — they agree today. Traced the only two consumers of `actionByAdapterOperation` (`ledgerProviderWritePermit.ts:307-338`, `issueLedgerProviderWritePermit`) and found both an `Object.hasOwn` existence check and a truthy check on the looked-up value, **both throwing `permitIssuanceFailed` on failure** — genuine, independent runtime protection that does not rely on the type system's (false) promise. Traced both call sites of the forward-direction map (`#claimNativeIdempotencyRecovery` and one more) — both funnel into the same guarded function. |
| Impact | Today: none — the two lists agree, and the runtime guard would deny permit issuance (fail closed) rather than mis-issue one if they ever didn't. The real defect is that the comments describing this code are **wrong about what protects it** — a future engineer reading "the record type below cannot be satisfied without both" and using this exact pattern (`Object.fromEntries(...) as Record<Union,V>`) as a template elsewhere, without also copying the defensive `Object.hasOwn` check, would ship something genuinely unprotected. |
| Codex migration legacy | No; this is new code (the comment explicitly narrates fixing an *earlier* version of this exact defect class, i.e. it is itself a remediation, just one whose remaining cast is weaker than its comment claims). |

---

## SR-08 — `#recoverOperation`'s switch is not compiler-protected (void return defeats `TS2366`); mitigated by a downstream re-verification

| Field | Content |
|---|---|
| Union shadowed | `AccountingCaseOperation["actionId"]` (4 members as originally written; 6 as of the concurrent edits during this review) |
| Evidence | `src/services/xeroAccountingCaseService.ts`, `async #recoverOperation(...): Promise<void>` (~line 4568 at last read): `switch (operationRecord.operation.actionId) { case "contact.create_basic": ...; return; case "supplier_bill.create_draft": ...; return; case "customer_invoice.create_draft": ...; return; case "credit_note.create_draft": ...; return; }` — no `default`, and **no** case yet for `quote.create_draft`/`purchase_order.create_draft`, even though those two actionId members already exist elsewhere in this same file (`#executeOperation`, which *does* handle them with a `never`-check). |
| Evidence class | READ |
| Falsification | Built `tsprobe/probe1.ts`, reproducing this exact shape (switch missing a case, no default) but with an **explicit non-`undefined` return type** — `tsc` raised `TS2366`. Then confirmed `#recoverOperation`'s actual declared return type is `Promise<void>`, for which falling off the end of a switch is a legal, silent void-return — no error, because `void`-returning functions are explicitly exempted from this check regardless of `noImplicitReturns`. Traced the sole caller, `#recoverCase` (~line 4091+): it `await`s `#recoverOperation` inside a `try`, and — independent of whether that call threw — re-fetches the mutation request by ID and requires `state === "READBACK_VERIFIED"` before proceeding, throwing `PERSISTENCE_FAILURE` otherwise. A silent no-op leaves the request in its prior (unverified) state, so this check catches the gap. |
| Impact | Today: a crash-recovery attempt for a `quote.create_draft`/`purchase_order.create_draft` operation silently does nothing inside `#recoverOperation`, then the caller's independent state check fails the recovery loudly (`PERSISTENCE_FAILURE`) rather than marking a skipped write as done. Real, currently-live gap (recovery for these two action types is unhandled as of this read) but fails safe, not silently wrong. |
| Codex migration legacy | No — this is the concurrent work in progress right now; likely to be fixed before that work is considered done, but it was in this state at time of read. |

---

## SR-09 — Repeated 2×2 ternary/if matrices computing a route-like label, exhaustive only by architectural convention

| Field | Content |
|---|---|
| Union shadowed | `documentKind` (`INVOICE`\|`CREDIT_NOTE`) × `counterpartyRole` (`CUSTOMER`\|`SUPPLIER`) |
| Evidence | Three near-identical sites: `src/control-kernel/accountingCaseCompiler.ts` `nativeRoute()`, `src/domain/accountingCaseContinuation.ts:39-41` `publicDocument()`'s `documentType`, and `src/policy/xeroNativeRouteContract.ts:28-32` `routeFor()`. All compute `documentKind === "INVOICE" ? (counterpartyRole === "CUSTOMER" ? A : B) : (counterpartyRole === "CUSTOMER" ? C : D)`. |
| Evidence class | READ |
| Falsification | Checked whether `documentKind` is under growth pressure the way `NativeDocumentRoute` is — it is not: the concurrently-landing Quote/PurchaseOrder work deliberately routes through a **disjoint** `CommercialDocumentFact`/`CommercialDocumentRoute` type rather than adding a third `documentKind` value, and `xeroNativeRouteContract.ts`'s own doc comment says so explicitly (*"CommercialDocumentRoute is a disjoint type from NativeDocumentRoute... adding a third documentKind here without a new case fails to compile"* — referring to its *own*, correctly-`never`-guarded sibling function for commercial documents, not to `routeFor` itself). So today's architecture keeps this pair closed at 2×2 by convention, not by anything the compiler enforces on these three functions specifically. |
| Impact | Lower than SR-01: exhaustive today, and the codebase's own design intentionally avoids growing `documentKind` further. Included because it is the same structural pattern (unguarded ternary fallback over a union) at three sites, and because "the compiler enforces it" is true of the *sibling* function in one of these files but not of the function itself. |
| Codex migration legacy | No. |

---

## SR-10 — Widespread low-risk duplication of small, Xero-fixed vocabularies

Real duplication, same defect class, but every member set here is either a fundamental Xero
API dichotomy (`ACCPAY`/`ACCREC`, `ACCRECCREDIT`/`ACCPAYCREDIT`, `LineAmountTypes`,
`Phone`/`AddressType`) that has not changed in years, or the `CUSTOMER`/`SUPPLIER` AR/AP
distinction that is foundational to double-entry accounting itself. All fail loud (zod
`ZodError` or a Postgres `CHECK` violation) rather than silently. Listed together rather than
ranked individually:

- `LineAmountTypes` wire form (`"Exclusive"`/`"Inclusive"`/`"NoTax"`): `domain/schemas.ts` x3,
  `xeroCreditNoteManualJournalDraft.ts` x1, `xeroQuotePurchaseOrderDraft.ts` x1 — 5 sites.
- `phone_type`/`address_type`: `xeroContactItemMutationSchemas.ts` x2,
  `xeroContactItemPrimitives.ts` x4 (snake_case + camelCase) — 6 sites.
- `ACCPAY`/`ACCREC`: TS union (`domain/models.ts:600`) + `domain/schemas.ts:43` + SQL `CHECK`
  (`migrations/016:14`) — 3 independent declarations.
- `ACCRECCREDIT`/`ACCPAYCREDIT`: `domain/schemas.ts:89` +
  `xeroCreditNoteManualJournalDraft.ts` x2 — 3 sites.
- `CUSTOMER`/`SUPPLIER` (contact usage role / counterparty role):
  `accountingCaseSchemas.ts` x2, `xeroAccountingCaseBusinessIntake.ts` x1 — 3+ sites, plus every
  inline `=== "CUSTOMER"` comparison in the SR-09 cluster.
- `AccountingDocumentValidity` (`VALID_FOR_LIVE_BOOKS`/`TEST_OR_NOT_VALID`/`UNKNOWN`): TS union
  (`accountingCase.ts`) + `accountingCaseSchemas.ts:164` + `xeroAccountingCaseBusinessIntake.ts:198`
  — 3 sites; deliberately-closed tri-state per its own doc comment, gates whether a document may
  post to live books, so named explicitly despite low churn risk.

Evidence class: READ for all. Falsification: for each, checked whether the set is Xero's own
fixed API vocabulary (yes, in every case here) versus an internally-evolving concept (the
distinguishing factor separating this bucket from SR-01 through SR-08).

---

## SR-11 — Contact strong-identity "collision field" list independently declared at 4 sites

| Field | Content |
|---|---|
| Union/list shadowed | The field triple `{email, companyNumber, accountNumber}` used to decide contact-identity collisions |
| Evidence | `src/policy/xeroContactIdentity.ts:158-162` (`for (const [field, missing, conflict] of [["email",...],["companyNumber",...],["accountNumber",...]] as const)`), `src/services/xeroAccountingCaseService.ts:1616` (`for (const field of ["email","companyNumber","accountNumber"] as const)`), `src/services/xeroAccountingCaseService.ts:3325` (`const collisionFields = (["email","companyNumber","accountNumber"] as const)`), `src/mcp/xeroAccountingCaseBusinessIntake.ts:326` (snake_case twin, `["email","company_number","account_number"]`). |
| Evidence class | READ |
| Falsification | Checked whether any one of the four is positioned as the canonical source the others import — none is; all four are local literals with no shared import. |
| Impact | A new strong-identity field (e.g. a tax registration number) added to contact matching would need this exact triple edited at 4 independent sites across 3 files; missing one silently narrows collision detection at that specific site while the other three correctly widen. |
| Codex migration legacy | No specific evidence found either way. |

---

## SR-12 — `subject_type`/status-family SQL `CHECK` constraints restate TS unions at multiple migration sites (currently consistent, fails loud if not)

| Field | Content |
|---|---|
| Union shadowed | `BindingSubjectType` (`USER`\|`TEAM`, `domain/models.ts:62`); also `ConnectionStatus`/`ProviderAuthorizationStatus`, `GovernanceDisposition` |
| Evidence | `subject_type text NOT NULL CHECK (subject_type IN ('USER', 'TEAM'))` appears identically at 6 migration sites across 5 files (`005_oauth_identity_foundation.sql` x3, `022_xero_organisation_switch.sql`, `027_accounting_case_foundation.sql`, `039_...residual_continuation.sql`). `connection_status`/`disposition` CHECKs match their TS unions exactly at their respective single sites. |
| Evidence class | READ |
| Falsification | Compared each list against its TS union member-for-member — all currently exact matches. No column here has a second, differently-worded ALTER the way the two operation/version `state` columns do (see SR-13), so there was no drift-across-time to check for this one; only the drift-across-*files* pattern applies. |
| Impact | Currently sound; named because a 3rd subject type (a service-account/agent-delegated subject is plausible given this codebase's direction toward multi-agent delegation) would need 6 independent SQL edits with nothing connecting any of them to the TS union or to each other. Fails loud (Postgres constraint violation) if forgotten, not silently. |
| Codex migration legacy | No. |

---

## SR-13 — `action_id`/`native_route` `CHECK` constraints have not yet caught up with the concurrently-landing action-set expansion

| Field | Content |
|---|---|
| Union shadowed | `AccountingCaseOperation["actionId"]` (4→6 members during this review) and `NativeDocumentRoute \| "CONTACT_CREATE"` |
| Evidence | `migrations/027_accounting_case_foundation.sql:192-199` — `action_id text NOT NULL CHECK (action_id IN ('contact.create_basic','customer_invoice.create_draft','supplier_bill.create_draft','credit_note.create_draft'))` and `native_route text NOT NULL CHECK (native_route IN ('CONTACT_CREATE','SALES_INVOICE','SUPPLIER_BILL','CUSTOMER_CREDIT','SUPPLIER_CREDIT'))`. |
| Evidence class | READ + EXECUTED (`grep -rln "action_id\|native_route" migrations/*.sql`, then read every hit) |
| Falsification | Searched every migration file for an `ALTER` touching either constraint — none exists (contrast with the `state` columns on the same two tables, which each have 1-2 later `ALTER`s tracked as their own entries). Meanwhile `src/services/xeroAccountingCaseService.ts`'s `#executeOperation` and `accountingCasePersistence.ts`'s `accountingCaseMutationRoute` have *already* been updated (by the concurrent agents, during this review) to accept `quote.create_draft`/`purchase_order.create_draft`. |
| Impact | Currently zero — inserting a row with the new `action_id` values is rejected by Postgres outright, so this is presently a hard *block*, not a silent gap. It is the visible, blocking half of SR-14: whoever widens this `CHECK` to unblock the feature inherits SR-14's trigger-function gap immediately and invisibly. |
| Codex migration legacy | No — concurrent work in progress at time of read. |

---

## SR-14 — PL/pgSQL trigger functions hand-enumerate `action_id` with two *opposite* silent-failure shapes, entirely outside anything `tsc` can see

This is the SQL-native counterpart to SR-01, and the strongest evidence in this review that the
defect class is not confined to TypeScript.

| Field | Content |
|---|---|
| Union shadowed | `AccountingCaseOperation["actionId"]` |
| Evidence | `migrations/039_accounting_case_expired_target_residual_continuation.sql`, function `accounting_case_operation_guard()` (the live definition — `CREATE OR REPLACE FUNCTION accounting_case_operation_guard` appears 4 times across `027`→`029`→`038`→`039`; each replaces the prior in full, so only `039`'s body is active). **Pattern A** (lines 538-546, inside a bigger `OR`-chain that raises an exception): `OR (NEW.action_id = 'contact.create_basic' AND (object_type/operation mismatch)) OR (NEW.action_id = 'customer_invoice.create_draft' AND ...) OR (... 'supplier_bill.create_draft' ...) OR (... 'credit_note.create_draft' ...)`. `quote.create_draft`/`purchase_order.create_draft` are absent from all 4 clauses. **Pattern B** (lines 590-605, `IF NOT COALESCE((...), false) THEN RAISE EXCEPTION`): the same 4-action enumeration, but wrapped in a negation — the *opposite* default. A **second, distinct** trigger function, `accounting_case_preflight_reseal_operation_guard()` (`migrations/030_accounting_case_preflight_reseal.sql:401-409`), carries an independent copy of Pattern A's shape. |
| Evidence class | READ. Traced the full lineage via `grep -rn "NEW\.action_id = '\|operation_row\.action_id = '\|existing\.action_id = '" migrations/*.sql` (34 hits) and `grep -n "CREATE OR REPLACE FUNCTION accounting_case_operation_guard" migrations/*.sql` (4 hits, confirming supersession order) and `grep -n "CREATE OR REPLACE FUNCTION accounting_case_preflight_reseal_operation_guard"` (1 hit, confirming it is not itself superseded). |
| Falsification | **Mechanism, Pattern A**: for `NEW.action_id = 'quote.create_draft'`, every one of the 4 `NEW.action_id = 'X'` clauses is false, so the whole 4-clause block contributes `false` to the surrounding `OR` — the "does the linked preparation's object_type/operation actually match this action" invariant is silently not checked for the new action, rather than raising an error. **Mechanism, Pattern B**: same 4 clauses, but under `NOT COALESCE((...), false)` — none matching means the inner expression is `false`, `NOT false = true`, so the exception **always** fires for the new action, i.e. this half fails closed (blocks everything) rather than open. Confirmed these are currently unreachable: the `action_id` `CHECK` constraint (SR-13) still only permits the original 4 values, so Postgres rejects any row with the new `action_id`s before this trigger body ever runs — the gap is real (the TS side has already grown; this SQL has not) but not yet exploitable. It becomes exploitable the instant someone widens the `CHECK` constraint, which is a necessary step for the concurrently-landing Quote/PurchaseOrder feature to persist anything at all. |
| Impact | Once the `CHECK` constraint is widened (necessary for the feature to ship): Pattern A silently drops a database-level integrity check that exists specifically to catch a mismatched `preparation.object_type`/`operation` for the declared action — for the two new actions only, invisibly. Pattern B unconditionally blocks a legitimate crash-recovery `NO_WRITE_REQUIRED` transition for the two new actions until fixed. Neither is caught by `tsc`, ESLint (none installed), or any migration-linting tool — this file is plain `.sql`, entirely outside the TypeScript project's `include` globs. A second, independently-vulnerable function (`accounting_case_preflight_reseal_operation_guard`) must also be remembered. |
| Codex migration legacy | No — this is pre-existing SQL from the accounting-case foundation work, not yet touched by the concurrent session; it is a landmine the concurrent TypeScript-side expansion is walking toward, not something a migration left behind. |

---

## Systemic finding: `noImplicitReturns` is off and no ESLint exhaustiveness rule exists

`tsconfig.json`'s `compilerOptions` list is: `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`noUnusedLocals`, `noUnusedParameters`, plus module/target settings. **`noImplicitReturns` is not
present**, and `package.json` has no `eslint`/`@typescript-eslint` dependency of any kind (no
`.eslintrc*` or `eslint.config.*` file exists either).

This determines, precisely, which of the "sound" switch statements below are protected and by
what:

1. **Explicit non-`undefined` return-type annotation** (e.g. `factDisposition`,
   `accountingCaseMutationRoute`, `nativeAction`, `oauthRequirements`,
   `executionRequirementsFor`): a missing case makes the function fail to have an ending return
   statement, and — confirmed EXECUTED via `tsprobe/probe1.ts` — this raises `TS2366` *regardless*
   of `noImplicitReturns`, because the check is tied to the explicit annotation, not to that flag.
   Genuinely safe.
2. **`default: const _: never = x`** (e.g. `executePrepared`, `#executeOperation`,
   `evaluateXeroCommercialDocumentRouteContract`): genuinely safe, independent of any flag —
   confirmed by TypeScript's well-established narrow-to-`never` semantics for discriminated unions
   and by observing it live-catching the concurrent `CommercialDocumentRoute` work (below).
3. **strictNullChecks on a directly-accessed, non-optional-chained value** (e.g. the
   `expectedRoute` IIFE): safe *only* as long as every access is a plain `.property` read, not
   `?.` or `!`. Confirmed EXECUTED via `tsprobe/probe3.ts`, and confirmed live via the current
   `tsc -p tsconfig.json --noEmit` output (below).
4. **None of the above** (a `void`/`Promise<void>`-returning function, e.g. `#recoverOperation` —
   SR-08; or a return type that already includes `undefined`, e.g. `rawBusinessValue` — SR-03; or
   an `as Record<...>` cast, e.g. SR-07): genuinely unprotected. `noImplicitReturns: true` would
   close case (4)'s void-function gap specifically; it would not close SR-03 or SR-07 (those need
   `satisfies`/plain-annotation discipline and cast avoidance, not a tsconfig flag), and it cannot
   reach `migrations/*.sql` at all (SR-14).

This is offered as a scoping observation, not a finding with its own `finding_ids` — it is the
mechanism note underlying SR-03, SR-06 (partially — the default arm is explicit, not a
`noImplicitReturns` gap), and SR-08.

---

## Live-tree caveat (read, not a finding, but load-bearing for how to read the above)

`git status --short`, checked repeatedly through this review, showed active concurrent
modification of `src/control-kernel/accountingCaseCompiler.ts`, `src/domain/accountingCase.ts`,
`src/domain/accountingCasePersistence.ts`, `src/policy/xeroNativeRouteContract.ts`, and
`src/services/xeroAccountingCaseService.ts` (plus several `harness/`/`scripts/`/`tests/` files
outside this review's scope) throughout — line numbers in several files shifted between an early
read and a later one of the same function. Where that was noticed, the site was re-read and the
freshest content is what is reported above.

Running `./node_modules/.bin/tsc -p tsconfig.json --noEmit` partway through this review
(read-only; no file was written) showed **22 live compile errors**, all traceable to an in-flight
introduction of `CommercialDocumentRoute` (`"QUOTE" \| "PURCHASE_ORDER"`,
`src/domain/accountingCase.ts:150`) by the concurrent agents. This is not itself a silent-drift
finding — it is loud, and self-evidently work in progress — but it is useful, real-time,
EXECUTED corroboration for several verdicts above:

- The errors are concentrated exactly where this review's own analysis predicted protection would
  hold: `expectedRoute.actionId`/`.objectType`/`.operation` accesses (`xeroAccountingCaseService.ts`,
  ~lines 2639-2860) fail with `TS18048 'expectedRoute' is possibly 'undefined'`, live-confirming
  the strictNullChecks mechanism described for that site, not just the standalone probe.
- `xeroAccountingCaseExistingDocumentEvidence.ts` and `xeroBusinessCoordinateHistory.ts` both show
  `TS2345` errors where a widened `NativeDocumentRoute | CommercialDocumentRoute` value is passed
  into a function still typed to accept only `NativeDocumentRoute` — i.e. the strict parameter
  typing at exactly the boundary SR-01/SR-02 are about is, right now, actively rejecting an
  attempted expansion.
- **`xeroBusinessCoordinateAuthority.ts` itself shows zero errors** under this live stress test —
  because the in-flight change is adding a *disjoint* `CommercialDocumentRoute` union rather than
  extending `NativeDocumentRoute`, it has not yet reached SR-01's ternary chain or SR-02's zod
  enums. Those remain fully live, unexercised risks for whenever Quote/PurchaseOrder documents
  need business-coordinate-authority (duplicate-prevention) treatment — plausible, since Quotes
  and Purchase Orders are real Xero documents with their own numbering.
- New code written as part of this concurrent work (`xeroNativeRouteContract.ts`'s
  `evaluateXeroCommercialDocumentRouteContract`, `#executeOperation`) uses the `never`-guarded
  switch pattern correctly and, in one case, its own doc comment explicitly names the defect class
  this review was commissioned to find. The remediation pattern is established house style; it has
  not yet been back-applied to SR-01/SR-02's older sites.

## Cross-referenced but out of this review's `src/**` mandate (not enumerated, not claimed as findings)

- **`docs/TOOL-COUNT-PIN-POINTS.md`** (added today, commit `50d8323`, by what its own message
  describes as a `docs:`-only, non-`src/`-touching pass run "while the capability agents run"):
  documents 6 hardcoded `tool_count === 30` sites in `tests/`, `scripts/`, and `deploy/` that will
  need editing when `TOOL_ALLOWLIST` grows to 32. Verified only the `src/`-side half myself: every
  `src/` consumer (`toolNames.ts`, `createServer.ts`, `xeroToolCapabilityContract.ts`,
  `http/app.ts:673`) correctly derives from `TOOL_ALLOWLIST` rather than hardcoding a count — sound.
  Did not re-verify the 6 named non-`src/` sites myself; out of this round's scope per the task
  brief.
- **Harness/`tsconfig.harness.json` typecheck gap**: `docs/TOOL-COUNT-PIN-POINTS.md`'s sibling
  commit measured the harness's synthetic `AccountingProvider` as "eleven methods behind" the real
  one, because `tsconfig.json`'s `include` is `src/**` only and Vitest transpiles without
  typechecking, so nothing has ever typechecked `harness/**`. I independently ran
  `tsc -p tsconfig.harness.json --noEmit` (read-only) and confirmed it currently fails, but the 22
  errors observed are all attributable to the live `CommercialDocumentRoute` work (above), not to
  a harness/interface gap I could isolate myself; a name-matching regex check I ran independently
  found 0 missing method *names* (a much weaker check than a real structural diff, and not
  conclusive either way). **Marked `NOT_EXAMINED`** for the specific "eleven methods" claim rather
  than repeated on the strength of the sibling commit alone — I did not verify it precisely myself.
