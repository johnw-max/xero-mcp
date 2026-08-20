import { z } from "zod/v4";
import {
  ACCOUNTING_CASE_SOURCE_SYSTEMS,
  ACCOUNTING_DOCUMENT_REFERENCE_KINDS,
  ACCOUNTING_FACT_KINDS,
  originalTransactionEvidenceHash,
  type OriginalTransactionEvidenceFact,
} from "./accountingCase.js";
import {
  allocateCreditNotePayloadSchema,
  authoriseCreditNotePayloadSchema,
  refundCreditNotePayloadSchema,
  unallocateCreditNotePayloadSchema,
  voidCreditNotePayloadSchema,
  voidInvoicePayloadSchema,
  voidManualJournalPayloadSchema,
} from "./xeroLedgerAdjustment.js";
import {
  bankTransactionCreateInputSchema,
  bankTransactionReverseInputSchema,
  bankTransactionUpdateInputSchema,
  paymentCreateInputSchema,
  paymentReverseInputSchema,
} from "./xeroPaymentBankTransaction.js";

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/u);

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function scaledDecimal(value: string, scale = 4): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const result = BigInt(whole) * (10n ** BigInt(scale)) + BigInt((fraction + "0".repeat(scale)).slice(0, scale));
  return negative ? -result : result;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(isRealDate, "must be a real calendar date");
const isoOffsetDateTime = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u)
  .refine((value) => Number.isFinite(new Date(value).getTime()), "must be a valid ISO datetime with an explicit offset");
const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
const currency = z.string().regex(/^[A-Z]{3}$/u);
const decimal4 = z.string().regex(/^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/u);
const nonNegativeDecimal4 = decimal4.refine((value) => scaledDecimal(value) >= 0n, "must not be negative");
const positiveDecimal4 = decimal4.refine((value) => scaledDecimal(value) > 0n, "must be greater than zero");
// Public amounts remain bounded fixed-decimal source strings. Currency scale
// is an accounting-policy decision (for example JPY 0, SGD 2, KWD 3), so the
// transport schema must not silently hard-code a universal two-decimal money.
const money = nonNegativeDecimal4;
const positiveMoney = positiveDecimal4;

const sourceUnitSchema = z.object({
  unitId: id,
  expectedFactKinds: z.array(z.enum(ACCOUNTING_FACT_KINDS)).min(1).max(ACCOUNTING_FACT_KINDS.length)
    .refine((values) => new Set(values).size === values.length, "expected fact kinds must be unique"),
}).strict();

const sourceArtifactSchema = z.object({
  artifactId: id,
  label: z.string().trim().min(1).max(256),
  units: z.array(sourceUnitSchema).min(1).max(256),
}).strict();

const factBase = {
  factId: id,
  lineageKey: id,
  eventKey: id,
  sourceUnitIds: z.array(id).min(1).max(64)
    .refine((values) => new Set(values).size === values.length, "source units must be unique"),
  origin: z.enum(["MODEL_EXTRACTED", "AGENT_ASSERTED", "SERVER_RESOLVED_PROVIDER_EVIDENCE"]),
  revision: z.number().int().min(1).max(1_000_000),
  supersedesFactId: id.optional(),
};

const contactDurableIdentity = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("LEGAL_REGISTRY"),
    jurisdiction: id,
    registryScheme: id,
    number: z.string().trim().min(1).max(128),
  }).strict(),
  z.object({
    kind: z.literal("PROVIDER_TENANT_ACCOUNT"),
    providerId: id,
    namespace: id,
    number: z.string().trim().min(1).max(128),
  }).strict(),
]);

const contact = z.object({
  ...factBase,
  kind: z.literal("CONTACT_CANDIDATE"),
  usageRoles: z.array(z.enum(["CUSTOMER", "SUPPLIER"])).min(1).max(2)
    .refine((values) => new Set(values).size === values.length, "usage roles must be unique")
    .refine(
      (values) => values.join(",") === [...values].sort((left, right) => left.localeCompare(right)).join(","),
      "usage roles must be sorted",
    ),
  name: z.string().trim().min(1).max(255),
  email: z.string().email().optional(),
  durableIdentity: contactDurableIdentity.optional(),
  companyNumber: z.string().trim().min(1).max(64).optional(),
  accountNumber: z.string().trim().min(1).max(64).optional(),
  bankVerification: z.enum(["NOT_APPLICABLE", "PENDING_CALLBACK", "VERIFIED"]).optional(),
}).strict().superRefine((value, context) => {
  const canonical = (input: string) => input.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
  if (
    value.durableIdentity?.kind === "LEGAL_REGISTRY" &&
    value.companyNumber !== undefined &&
    canonical(value.durableIdentity.number) !== canonical(value.companyNumber)
  ) {
    context.addIssue({
      code: "custom",
      path: ["companyNumber"],
      message: "must equal durableIdentity.number when a legal-registry identity is supplied",
    });
  }
  if (
    value.durableIdentity?.kind === "PROVIDER_TENANT_ACCOUNT" &&
    value.accountNumber !== undefined &&
    canonical(value.durableIdentity.number) !== canonical(value.accountNumber)
  ) {
    context.addIssue({
      code: "custom",
      path: ["accountNumber"],
      message: "must equal durableIdentity.number when a provider-tenant account identity is supplied",
    });
  }
});

// These field sets intentionally mirror only the safe Contact/Item
// primitives. They are typed Case facts, not an escape hatch for arbitrary
// provider JSON or generic updates.
const compactReferenceText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .transform((value) => value.replace(/\s+/gu, " "));
const contactPhonePatch = z.object({
  phone_type: z.enum(["DEFAULT", "DDI", "MOBILE", "FAX", "OFFICE"]),
  phone_number: compactReferenceText(50),
  area_code: compactReferenceText(10).optional(),
  country_code: compactReferenceText(20).optional(),
}).strict();
const contactAddressPatch = z.object({
  address_type: z.enum(["POBOX", "STREET"]),
  line_1: compactReferenceText(500).optional(),
  line_2: compactReferenceText(500).optional(),
  line_3: compactReferenceText(500).optional(),
  line_4: compactReferenceText(500).optional(),
  city: compactReferenceText(255).optional(),
  region: compactReferenceText(255).optional(),
  postal_code: compactReferenceText(50).optional(),
  country: compactReferenceText(50).optional(),
  attention_to: compactReferenceText(255).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "address_type"), {
  message: "an address must contain at least one address field",
});
const contactBasicPatch = z.object({
  name: compactReferenceText(255).optional(),
  first_name: compactReferenceText(255).optional(),
  last_name: compactReferenceText(255).optional(),
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()).optional(),
  company_number: compactReferenceText(50).optional(),
  account_number: compactReferenceText(50).optional(),
  phones: z.array(contactPhonePatch).min(1).max(5)
    .refine((values) => new Set(values.map((value) => value.phone_type)).size === values.length,
      "phones must not repeat a phone_type").optional(),
  addresses: z.array(contactAddressPatch).min(1).max(2)
    .refine((values) => new Set(values.map((value) => value.address_type)).size === values.length,
      "addresses must not repeat an address_type").optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "contact patch must include at least one basic field",
});
const contactBasicUpdate = z.object({
  ...factBase,
  kind: z.literal("CONTACT_BASIC_UPDATE"),
  contactId: z.string().uuid(),
  patch: contactBasicPatch,
}).strict();

const itemBasicCreate = z.object({
  code: compactReferenceText(30),
  name: compactReferenceText(50).optional(),
  description: compactReferenceText(4_000).optional(),
  purchase_description: compactReferenceText(4_000).optional(),
  is_sold: z.boolean().default(true),
  is_purchased: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (!value.is_sold && value.description) {
    context.addIssue({ code: "custom", path: ["description"], message: "description requires is_sold=true" });
  }
  if (!value.is_purchased && value.purchase_description) {
    context.addIssue({ code: "custom", path: ["purchase_description"], message: "purchase_description requires is_purchased=true" });
  }
  if (!value.is_sold && !value.is_purchased) {
    context.addIssue({ code: "custom", path: ["is_sold"], message: "item must remain usable" });
  }
});
const itemBasicPatch = z.object({
  name: compactReferenceText(50).optional(),
  description: compactReferenceText(4_000).optional(),
  purchase_description: compactReferenceText(4_000).optional(),
  is_sold: z.boolean().optional(),
  is_purchased: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "item patch must include at least one basic field",
});
const itemBasicCreateUntracked = z.object({
  ...factBase,
  kind: z.literal("ITEM_BASIC_CREATE_UNTRACKED"),
  item: itemBasicCreate,
}).strict();
const itemBasicUpdateUntracked = z.object({
  ...factBase,
  kind: z.literal("ITEM_BASIC_UPDATE_UNTRACKED"),
  itemId: z.string().uuid(),
  patch: itemBasicPatch,
}).strict();

const trackingReferenceData = z.object({
  ...factBase,
  kind: z.literal("TRACKING_REFERENCE_DATA"),
  action: z.enum([
    "tracking_category.create",
    "tracking_category.update",
    "tracking_option.create",
    "tracking_option.update",
  ]),
  name: z.string().trim().min(1).max(100),
  trackingCategoryId: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
  trackingOptionId: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
}).strict().superRefine((value, context) => {
  const categoryRequired = value.action !== "tracking_category.create";
  const optionRequired = value.action === "tracking_option.update";
  if (categoryRequired !== (value.trackingCategoryId !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["trackingCategoryId"],
      message: categoryRequired ? "is required for this tracking action" : "is not accepted for category create",
    });
  }
  if (optionRequired !== (value.trackingOptionId !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["trackingOptionId"],
      message: optionRequired ? "is required for option update" : "is accepted only for option update",
    });
  }
});

// Provider-native ledger coordinates declared by the caller. The kernel only
// bounds their shape; existence, status and applicability are proven against
// the target tenant's live data by the injected accounting policy.
const accountCode = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/u);
const taxType = z.string().trim().regex(/^[A-Za-z0-9_]{1,50}$/u);

const nativeDocumentLine = z.object({
  lineId: id,
  description: z.string().trim().min(1).max(1_000),
  quantity: positiveDecimal4,
  unitAmount: nonNegativeDecimal4,
  sourceTax: money,
  accountCode,
  taxType,
}).strict();

// Quote/purchase-order lines: same provider-native account_code/tax_type
// coordinate as native-document lines, but no sourceTax -- there is no
// caller-declared net/tax/gross to reconcile a source tax figure against
// (see CommercialDocumentFact in accountingCase.ts).
const commercialDocumentLine = z.object({
  lineId: id,
  description: z.string().trim().min(1).max(1_000),
  quantity: positiveDecimal4,
  unitAmount: nonNegativeDecimal4,
  accountCode,
  taxType,
}).strict();

const commercialDocument = z.object({
  ...factBase,
  kind: z.literal("COMMERCIAL_DOCUMENT"),
  documentKind: z.enum(["QUOTE", "PURCHASE_ORDER"]),
  counterpartyRole: z.enum(["CUSTOMER", "SUPPLIER"]),
  reference: z.string().trim().min(1).max(255),
  documentDate: date,
  // QUOTE requires this; PURCHASE_ORDER never sets it. Requiredness by
  // documentKind is a route-contract concern (like INVOICE's dueDate below),
  // not a schema-level one -- see commercialDocumentRouteReasonCodes in
  // accountingCaseCompiler.ts.
  expiryDate: date.optional(),
  // PURCHASE_ORDER only, both optional; QUOTE never sets either.
  expectedArrivalDate: date.optional(),
  deliveryDate: date.optional(),
  currency,
  contactName: z.string().trim().min(1).max(255),
  contactDurableIdentity: contactDurableIdentity.optional(),
  lineAmountType: z.enum(["EXCLUSIVE", "INCLUSIVE", "NO_TAX"]),
  lines: z.array(commercialDocumentLine).min(1).max(20)
    .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, "line IDs must be unique"),
  documentValidity: z.enum(["VALID_FOR_LIVE_BOOKS", "TEST_OR_NOT_VALID", "UNKNOWN"]),
}).strict().superRefine((value, context) => {
  if (value.expiryDate && value.expiryDate < value.documentDate) {
    context.addIssue({ code: "custom", path: ["expiryDate"], message: "must not be before documentDate" });
  }
  if (value.expectedArrivalDate && value.expectedArrivalDate < value.documentDate) {
    context.addIssue({ code: "custom", path: ["expectedArrivalDate"], message: "must not be before documentDate" });
  }
  if (value.deliveryDate && value.deliveryDate < value.documentDate) {
    context.addIssue({ code: "custom", path: ["deliveryDate"], message: "must not be before documentDate" });
  }
});

// Balanced-journal lines: same provider-native account_code/tax_type
// coordinate as every other line kind, but no quantity/unitAmount -- a
// journal line is a bare debit or credit against an account, not a priced
// item (see BalancedJournalFact in accountingCase.ts). Exactly one of
// debit/credit must be present; both positive, matching Xero's own
// convention that a journal's per-line amount is signed only via which side
// it appears on, not via a negative number.
const balancedJournalLine = z.object({
  lineId: id,
  description: z.string().trim().min(1).max(1_000),
  accountCode,
  taxType,
  debit: positiveMoney.optional(),
  credit: positiveMoney.optional(),
}).strict().refine(
  (line) => (line.debit !== undefined) !== (line.credit !== undefined),
  "each line must declare exactly one of debit or credit",
);

// Whole-journal debits-equal-credits is deliberately NOT checked here. It is
// an accounting identity, not a structural shape constraint, and belongs in
// the compiler (JOURNAL_NOT_BALANCED in accountingCaseCompiler.ts) so it is
// decided before the proposal is sealed into an operation and
// canonicalPayloadHash, using the repository's fixed-decimal monetary
// helpers rather than floating point -- see docs/MANUAL-JOURNAL-DESIGN-2026-08-20.md.
const balancedJournal = z.object({
  ...factBase,
  kind: z.literal("BALANCED_JOURNAL"),
  narration: z.string().trim().min(1).max(255),
  date,
  lines: z.array(balancedJournalLine).min(2).max(50)
    .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, "line IDs must be unique"),
  documentValidity: z.enum(["VALID_FOR_LIVE_BOOKS", "TEST_OR_NOT_VALID", "UNKNOWN"]),
}).strict();

const ledgerStateTransition = z.object({
  ...factBase,
  kind: z.literal("LEDGER_STATE_TRANSITION"),
  actionId: z.enum([
    "customer_invoice.authorise",
    "supplier_bill.authorise",
    "manual_journal.post",
  ]),
  targetXeroObjectId: z.string().uuid(),
}).strict();

const ledgerAdjustment = z.discriminatedUnion("actionId", [
  z.object({ ...factBase, kind: z.literal("LEDGER_ADJUSTMENT"), actionId: z.literal("customer_invoice.void"), payload: voidInvoicePayloadSchema.extend({ invoiceType: z.literal("ACCREC") }) }).strict(),
  z.object({ ...factBase, kind: z.literal("LEDGER_ADJUSTMENT"), actionId: z.literal("supplier_bill.void"), payload: voidInvoicePayloadSchema.extend({ invoiceType: z.literal("ACCPAY") }) }).strict(),
  z.object({ ...factBase, kind: z.literal("LEDGER_ADJUSTMENT"), actionId: z.literal("credit_note.authorise"), payload: authoriseCreditNotePayloadSchema }).strict(),
  z.object({ ...factBase, kind: z.literal("LEDGER_ADJUSTMENT"), actionId: z.literal("credit_note.allocate"), payload: allocateCreditNotePayloadSchema }).strict(),
  z.object({ ...factBase, kind: z.literal("LEDGER_ADJUSTMENT"), actionId: z.literal("credit_note.refund"), payload: refundCreditNotePayloadSchema }).strict(),
  z.object({ ...factBase, kind: z.literal("LEDGER_ADJUSTMENT"), actionId: z.literal("credit_note.void"), payload: voidCreditNotePayloadSchema }).strict(),
  z.object({ ...factBase, kind: z.literal("LEDGER_ADJUSTMENT"), actionId: z.literal("credit_note.unallocate"), payload: unallocateCreditNotePayloadSchema }).strict(),
  z.object({ ...factBase, kind: z.literal("LEDGER_ADJUSTMENT"), actionId: z.literal("manual_journal.void"), payload: voidManualJournalPayloadSchema }).strict(),
]);

const paymentBankLedger = z.discriminatedUnion("actionId", [
  z.object({ ...factBase, kind: z.literal("PAYMENT_BANK_LEDGER"), actionId: z.literal("payment.create"), payload: paymentCreateInputSchema.extend({ schemaVersion: z.literal("xero-payment-bank-transaction:v1"), objectType: z.literal("PAYMENT"), operation: z.literal("CREATE") }).strict() }).strict(),
  z.object({ ...factBase, kind: z.literal("PAYMENT_BANK_LEDGER"), actionId: z.literal("payment.reverse"), payload: paymentReverseInputSchema.extend({ schemaVersion: z.literal("xero-payment-bank-transaction:v1"), objectType: z.literal("PAYMENT"), operation: z.literal("REVERSE") }).strict() }).strict(),
  z.object({ ...factBase, kind: z.literal("PAYMENT_BANK_LEDGER"), actionId: z.literal("bank_transaction.create"), payload: bankTransactionCreateInputSchema.extend({ schemaVersion: z.literal("xero-payment-bank-transaction:v1"), objectType: z.literal("BANK_TRANSACTION"), operation: z.literal("CREATE") }).strict() }).strict(),
  z.object({ ...factBase, kind: z.literal("PAYMENT_BANK_LEDGER"), actionId: z.literal("bank_transaction.update"), payload: bankTransactionUpdateInputSchema.extend({ schemaVersion: z.literal("xero-payment-bank-transaction:v1"), objectType: z.literal("BANK_TRANSACTION"), operation: z.literal("UPDATE") }).strict() }).strict(),
  z.object({ ...factBase, kind: z.literal("PAYMENT_BANK_LEDGER"), actionId: z.literal("bank_transaction.reverse"), payload: bankTransactionReverseInputSchema.extend({ schemaVersion: z.literal("xero-payment-bank-transaction:v1"), objectType: z.literal("BANK_TRANSACTION"), operation: z.literal("REVERSE") }).strict() }).strict(),
]);

const nativeDocument = z.object({
  ...factBase,
  kind: z.literal("NATIVE_DOCUMENT"),
  documentKind: z.enum(["INVOICE", "CREDIT_NOTE"]),
  counterpartyRole: z.enum(["CUSTOMER", "SUPPLIER"]),
  reference: z.string().trim().min(1).max(255),
  referenceKind: z.enum(ACCOUNTING_DOCUMENT_REFERENCE_KINDS),
  documentDate: date,
  dueDate: date.optional(),
  currency,
  contactName: z.string().trim().min(1).max(255),
  contactDurableIdentity: contactDurableIdentity.optional(),
  /**
   * Informational source-review record; no decision reads it. It carries the
   * public `review_note` free text verbatim, so it must accept ordinary prose
   * rather than the identifier charset — an accountant's note legitimately
   * contains spaces and punctuation.
   */
  taxPolicyBasis: z.string().trim().min(1).max(256).optional(),
  originalDocumentEventKey: id.optional(),
  originalDocumentReference: z.string().trim().min(1).max(255).optional(),
  originalDocumentReferenceKind: z.enum(ACCOUNTING_DOCUMENT_REFERENCE_KINDS).optional(),
  originalDocumentDate: date.optional(),
  originalTransactionEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  lineAmountType: id,
  lines: z.array(nativeDocumentLine).min(1).max(100)
    .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, "line IDs must be unique"),
  declaredNet: positiveMoney,
  declaredTax: money,
  declaredGross: positiveMoney,
  invoiceRate: positiveDecimal4.optional(),
  allocationStatus: z.literal("UNALLOCATED").optional(),
  documentValidity: z.enum(["VALID_FOR_LIVE_BOOKS", "TEST_OR_NOT_VALID", "UNKNOWN"]),
}).strict().superRefine((value, context) => {
  if (value.dueDate && value.dueDate < value.documentDate) {
    context.addIssue({ code: "custom", path: ["dueDate"], message: "must not be before documentDate" });
  }
  if (value.documentKind === "CREDIT_NOTE" && value.allocationStatus !== "UNALLOCATED") {
    context.addIssue({ code: "custom", path: ["allocationStatus"], message: "credit notes require a typed allocation status" });
  }
  if (value.documentKind === "INVOICE" && value.allocationStatus !== undefined) {
    context.addIssue({ code: "custom", path: ["allocationStatus"], message: "invoice cannot have credit allocation status" });
  }
  if (value.documentKind === "CREDIT_NOTE") {
    if (!value.originalDocumentReference) {
      context.addIssue({ code: "custom", path: ["originalDocumentReference"], message: "credit notes require the original document reference" });
    }
    if (!value.originalDocumentReferenceKind) {
      context.addIssue({ code: "custom", path: ["originalDocumentReferenceKind"], message: "credit notes require the original document reference kind" });
    }
    if (!value.originalDocumentDate) {
      context.addIssue({ code: "custom", path: ["originalDocumentDate"], message: "credit notes require the original document date" });
    } else if (value.originalDocumentDate > value.documentDate) {
      context.addIssue({ code: "custom", path: ["originalDocumentDate"], message: "must not be after the credit note date" });
    }
  } else {
    if (value.originalDocumentEventKey !== undefined || value.originalDocumentReference !== undefined ||
        value.originalDocumentReferenceKind !== undefined || value.originalDocumentDate !== undefined ||
        value.originalTransactionEvidenceHash !== undefined) {
      context.addIssue({ code: "custom", path: ["originalDocumentReference"], message: "original document evidence is only valid for credit notes" });
    }
  }
});

const draftDocumentUpdate = z.object({
  ...factBase,
  kind: z.literal("DRAFT_DOCUMENT_UPDATE"),
  actionId: z.enum([
    "customer_invoice.update_draft",
    "supplier_bill.update_draft",
    "quote.update_draft",
    "purchase_order.update_draft",
    "credit_note.update_draft",
    "manual_journal.update_draft",
  ]),
  targetXeroObjectId: z.string().uuid(),
  expectedUpdatedAt: isoOffsetDateTime,
  replacement: z.union([nativeDocument, commercialDocument, balancedJournal]),
}).strict().superRefine((fact, context) => {
  const replacement = fact.replacement;
  const matches = (() => {
    switch (fact.actionId) {
      case "customer_invoice.update_draft":
        return replacement.kind === "NATIVE_DOCUMENT" &&
          replacement.documentKind === "INVOICE" && replacement.counterpartyRole === "CUSTOMER";
      case "supplier_bill.update_draft":
        return replacement.kind === "NATIVE_DOCUMENT" &&
          replacement.documentKind === "INVOICE" && replacement.counterpartyRole === "SUPPLIER";
      case "credit_note.update_draft":
        return replacement.kind === "NATIVE_DOCUMENT" && replacement.documentKind === "CREDIT_NOTE";
      case "quote.update_draft":
        return replacement.kind === "COMMERCIAL_DOCUMENT" && replacement.documentKind === "QUOTE";
      case "purchase_order.update_draft":
        return replacement.kind === "COMMERCIAL_DOCUMENT" && replacement.documentKind === "PURCHASE_ORDER";
      case "manual_journal.update_draft":
        return replacement.kind === "BALANCED_JOURNAL";
    }
  })();
  if (!matches) {
    context.addIssue({
      code: "custom",
      path: ["replacement"],
      message: "complete replacement kind/direction must match the explicit update action",
    });
  }
  if (
    replacement.factId !== fact.factId ||
    replacement.lineageKey !== fact.lineageKey ||
    replacement.eventKey !== fact.eventKey ||
    replacement.revision !== fact.revision ||
    replacement.origin !== fact.origin ||
    JSON.stringify(replacement.sourceUnitIds) !== JSON.stringify(fact.sourceUnitIds)
  ) {
    context.addIssue({
      code: "custom",
      path: ["replacement"],
      message: "server-normalized replacement provenance must equal its update fact provenance",
    });
  }
});

const payment = z.object({
  ...factBase,
  kind: z.literal("PAYMENT"),
  direction: z.enum(["CUSTOMER_RECEIPT", "SUPPLIER_PAYMENT"]),
  reference: z.string().trim().min(1).max(255),
  paymentDate: date,
  currency,
  amount: positiveMoney,
  relatedEventKey: id,
  cleared: z.boolean(),
}).strict();

const bankFee = z.object({
  ...factBase,
  kind: z.literal("BANK_FEE"),
  date,
  currency,
  amount: positiveMoney,
  taxSemantics: id,
}).strict();

const prepayment = z.object({
  ...factBase,
  kind: z.literal("PREPAYMENT"),
  date,
  currency,
  gross: positiveMoney,
  net: positiveMoney,
  tax: money,
  customerName: z.string().trim().min(1).max(255),
  customerConfirmed: z.boolean(),
  servicePeriod: month,
}).strict();

const employeeExpenseLine = z.object({
  lineId: id,
  expenseDate: date,
  description: z.string().trim().min(1).max(1_000),
  net: positiveMoney,
  tax: money,
  gross: positiveMoney,
  taxSemantics: id,
  receiptStatus: z.enum(["PRESENT", "MISSING"]),
}).strict();

const employeeExpense = z.object({
  ...factBase,
  kind: z.literal("EMPLOYEE_EXPENSE"),
  employeeName: z.string().trim().min(1).max(255),
  submittedDate: date,
  approvalDate: date.optional(),
  paymentDate: date.optional(),
  currency,
  declaredGross: positiveMoney,
  recognitionPolicy: z.literal("ACCRUAL_EXPENSE_DATE"),
  lines: z.array(employeeExpenseLine).min(1).max(100)
    .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, "line IDs must be unique"),
}).strict();

const fxSettlement = z.object({
  ...factBase,
  kind: z.literal("FX_SETTLEMENT"),
  reference: z.string().trim().min(1).max(255),
  settlementDate: date,
  foreignCurrency: currency,
  foreignAmount: positiveMoney,
  baseCurrency: currency,
  settlementRate: positiveDecimal4,
  invoiceBase: positiveMoney,
  principalBase: positiveMoney,
  realisedFxLoss: money,
  bankFeeBase: money,
  cashBase: positiveMoney,
  invoiceEventKey: id,
  bankAccountRef: z.string().trim().min(1).max(128),
  reconciled: z.boolean(),
}).strict();

const opening = z.object({
  ...factBase,
  kind: z.literal("OPENING_BALANCE_REVIEW"),
  date,
  currency,
  amount: positiveMoney,
}).strict();

const bankStatementSummary = z.object({
  ...factBase,
  kind: z.literal("BANK_STATEMENT_SUMMARY"),
  accountRef: z.string().trim().min(1).max(128),
  periodStart: date,
  periodEnd: date,
  currency,
  openingBalance: money,
  closingBalance: money,
  includedEventKeys: z.array(id).min(1).max(10_000)
    .refine((values) => new Set(values).size === values.length, "included event keys must be unique"),
}).strict().refine((value) => value.periodEnd >= value.periodStart, {
  path: ["periodEnd"], message: "must not be before periodStart",
});

const goodsReceiptControl = z.object({
  ...factBase,
  kind: z.literal("GOODS_RECEIPT_CONTROL"),
  relatedBillEventKey: id,
  relatedCreditEventKey: id,
  billedQuantity: positiveDecimal4,
  receivedQuantity: nonNegativeDecimal4,
  unitNet: positiveDecimal4,
}).strict().refine((value) => scaledDecimal(value.receivedQuantity) <= scaledDecimal(value.billedQuantity), {
  path: ["receivedQuantity"], message: "cannot exceed billedQuantity",
});

const evidence = z.object({
  ...factBase,
  sourceUnitIds: z.array(id).length(1),
  kind: z.literal("EVIDENCE"),
  evidenceRole: z.enum([
    "INBOUND_CUSTOMER_PO",
    "REMITTANCE_ADVICE",
    "EXPENSE_RECEIPT",
    "SUBMITTED_ORIGINAL_TRANSACTION_SUPPORT",
    "CONTROL_SUPPORT",
  ]),
  relatedEventKey: id.optional(),
  amount: positiveMoney.optional(),
  note: z.string().trim().min(1).max(1_000),
}).strict();

const originalTransactionEvidenceLine = z.object({
  evidenceLineKey: id,
  description: z.string().trim().min(1).max(1_000),
  quantity: positiveDecimal4,
  unitAmount: nonNegativeDecimal4,
  net: nonNegativeDecimal4,
  tax: nonNegativeDecimal4,
  accountCode,
  taxType,
  effectiveTaxRateBps: z.number().int().min(0).max(10_000),
  taxSemantics: id,
}).strict();

const originalTransactionEvidence = z.object({
  ...factBase,
  kind: z.literal("ORIGINAL_TRANSACTION_EVIDENCE"),
  origin: z.literal("SERVER_RESOLVED_PROVIDER_EVIDENCE"),
  creditEventKey: id,
  originalRoute: z.enum(["SALES_INVOICE", "SUPPLIER_BILL"]),
  authoritativeProviderField: z.literal("INVOICE_NUMBER"),
  reference: z.string().trim().min(1).max(255),
  referenceKind: z.enum(ACCOUNTING_DOCUMENT_REFERENCE_KINDS),
  documentDate: date,
  currency,
  contactName: z.string().trim().min(1).max(255),
  contactDurableIdentity: contactDurableIdentity.optional(),
  creditEligibility: z.literal("CREDITABLE_POSTED_TRANSACTION"),
  lineAmountType: z.enum(["EXCLUSIVE", "NO_TAX"]),
  lines: z.array(originalTransactionEvidenceLine).min(1).max(100)
    .refine((lines) => new Set(lines.map((line) => line.evidenceLineKey)).size === lines.length,
      "original transaction evidence line keys must be unique"),
  net: nonNegativeDecimal4,
  tax: nonNegativeDecimal4,
  gross: nonNegativeDecimal4,
  sourceSnapshotSealHash: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((fact, context) => {
  const expectedProviderField = "INVOICE_NUMBER";
  if (fact.authoritativeProviderField !== expectedProviderField) {
    context.addIssue({
      code: "custom",
      path: ["authoritativeProviderField"],
      message: `must be ${expectedProviderField} for ${fact.originalRoute}`,
    });
  }
  if (fact.evidenceHash !== originalTransactionEvidenceHash(fact as OriginalTransactionEvidenceFact)) {
    context.addIssue({
      code: "custom",
      path: ["evidenceHash"],
      message: "must match the complete provider-neutral original-transaction evidence projection",
    });
  }
  if (scaledDecimal(fact.net) + scaledDecimal(fact.tax) !== scaledDecimal(fact.gross)) {
    context.addIssue({ code: "custom", path: ["gross"], message: "must equal net plus tax" });
  }
});

const control = z.object({
  ...factBase,
  kind: z.literal("CONTROL_FINDING"),
  controlType: z.enum(["THREE_WAY_MATCH", "BANK_DETAILS_VERIFICATION", "MISSING_RECEIPT"]),
  severity: z.enum(["INFO", "WARNING", "BLOCK_NEW_PAYMENT_OR_BANK_CHANGE"]),
  relatedEventKey: id.optional(),
  note: z.string().trim().min(1).max(1_000),
}).strict();

export const accountingFactSchema = z.discriminatedUnion("kind", [
  contact,
  contactBasicUpdate,
  itemBasicCreateUntracked,
  itemBasicUpdateUntracked,
  trackingReferenceData,
  nativeDocument,
  commercialDocument,
  balancedJournal,
  draftDocumentUpdate,
  ledgerStateTransition,
  ledgerAdjustment,
  paymentBankLedger,
  payment,
  bankFee,
  prepayment,
  employeeExpense,
  fxSettlement,
  opening,
  bankStatementSummary,
  goodsReceiptControl,
  originalTransactionEvidence,
  evidence,
  control,
]).superRefine((fact, context) => {
  if (
    fact.kind === "CONTACT_CANDIDATE" &&
    fact.bankVerification === "VERIFIED" &&
    fact.origin === "AGENT_ASSERTED"
  ) {
    context.addIssue({
      code: "custom",
      path: ["bankVerification"],
      message: "AGENT_ASSERTED facts cannot upgrade bank verification to VERIFIED",
    });
  }
});

/** Server-resolved evidence can never be supplied or upgraded by the Agent/Host. */
export const publicAccountingFactSchema = accountingFactSchema.refine(
  (fact) => fact.kind !== "ORIGINAL_TRANSACTION_EVIDENCE" &&
    fact.origin !== "SERVER_RESOLVED_PROVIDER_EVIDENCE" &&
    (fact.kind !== "NATIVE_DOCUMENT" || fact.originalTransactionEvidenceHash === undefined),
  "server-resolved provider evidence cannot be supplied through the public contract",
);

/**
 * Optional citation of the upstream (cross-MCP) material this submitted
 * batch was read from, for example a Google Drive case. Absent whenever
 * material arrives some other way (a chat upload has no upstream case);
 * that is an ordinary, unprotected-by-this-guard Case, not a degraded one.
 * The raw case_ref never leaves this schema boundary in the clear -- the
 * server hashes it immediately and persists only the digest.
 */
export const sourceCaseSchema = z.object({
  system: z.enum(ACCOUNTING_CASE_SOURCE_SYSTEMS),
  case_ref: z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/u),
}).strict();

export const prepareAccountingCasePublicSchema = z.object({
  case_id: id,
  expected_version: z.number().int().min(0),
  continuation_token: z.string().regex(/^(?:acc|acr)_[0-9a-f]{64}$/u).optional(),
  source_case: sourceCaseSchema.optional(),
  sources: z.array(sourceArtifactSchema).min(1).max(1_000),
  facts: z.array(publicAccountingFactSchema).min(1).max(10_000),
}).strict();

export const executeAccountingCaseSchema = z.object({
  case_id: id,
  case_version: z.number().int().positive(),
  request_id: id,
}).strict();

export const getAccountingCaseStatusSchema = z.object({
  case_id: id,
  case_version: z.number().int().positive().optional(),
}).strict();

export const prepareAccountingCaseSchema = z.object({
  caseId: id,
  expectedVersion: z.number().int().min(0),
  target: z.object({
    tenantId: id,
    environment: z.enum(["TEST", "PRODUCTION"]),
    baseCurrency: currency,
    taxJurisdiction: id,
    periodLockDate: date.optional(),
    endOfYearLockDate: date.optional(),
    organisationStatus: z.string().trim().min(1).max(64),
  }).strict(),
  sources: z.array(sourceArtifactSchema).min(1).max(1_000),
  facts: z.array(accountingFactSchema).min(1).max(10_000),
}).strict().superRefine((value, context) => {
  const artifactIds = value.sources.map((source) => source.artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "artifact IDs must be globally unique" });
  }
  const unitIds = value.sources.flatMap((source) => source.units.map((unit) => unit.unitId));
  if (new Set(unitIds).size !== unitIds.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "source unit IDs must be globally unique" });
  }
  const knownUnits = new Set(unitIds);
  const factIds = value.facts.map((fact) => fact.factId);
  if (new Set(factIds).size !== factIds.length) {
    context.addIssue({ code: "custom", path: ["facts"], message: "fact IDs must be globally unique" });
  }
  const byId = new Map(value.facts.map((fact) => [fact.factId, fact]));
  const successors = new Map<string, number>();
  for (const [index, fact] of value.facts.entries()) {
    for (const sourceUnitId of fact.sourceUnitIds) {
      if (!knownUnits.has(sourceUnitId)) {
        context.addIssue({ code: "custom", path: ["facts", index, "sourceUnitIds"], message: `unknown source unit ${sourceUnitId}` });
      }
    }
    if (fact.revision === 1 && fact.supersedesFactId) {
      context.addIssue({ code: "custom", path: ["facts", index, "supersedesFactId"], message: "revision 1 cannot supersede another fact" });
    }
    if (fact.revision > 1 && !fact.supersedesFactId) {
      context.addIssue({ code: "custom", path: ["facts", index, "supersedesFactId"], message: "revision greater than 1 must supersede its predecessor" });
    }
    if (!fact.supersedesFactId) continue;
    const predecessor = byId.get(fact.supersedesFactId);
    successors.set(fact.supersedesFactId, (successors.get(fact.supersedesFactId) ?? 0) + 1);
    if (!predecessor) {
      context.addIssue({ code: "custom", path: ["facts", index, "supersedesFactId"], message: "superseded fact does not exist" });
      continue;
    }
    const sameSources = [...fact.sourceUnitIds].sort().join("\u0000") === [...predecessor.sourceUnitIds].sort().join("\u0000");
    if (
      predecessor.factId === fact.factId ||
      predecessor.kind !== fact.kind ||
      predecessor.lineageKey !== fact.lineageKey ||
      predecessor.eventKey !== fact.eventKey ||
      !sameSources ||
      fact.revision !== predecessor.revision + 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["facts", index, "supersedesFactId"],
        message: "supersedes must be the immediately prior fact in the same kind, lineage, event and source units",
      });
    }
  }
  if ([...successors.values()].some((count) => count > 1)) {
    context.addIssue({ code: "custom", path: ["facts"], message: "a fact revision cannot have multiple successors" });
  }
  const byLineage = new Map<string, typeof value.facts>();
  for (const fact of value.facts) {
    const lineage = byLineage.get(fact.lineageKey) ?? [];
    lineage.push(fact);
    byLineage.set(fact.lineageKey, lineage);
  }
  for (const [lineageKey, lineage] of byLineage) {
    const roots = lineage.filter((fact) => !fact.supersedesFactId);
    const heads = lineage.filter((fact) => (successors.get(fact.factId) ?? 0) === 0);
    if (roots.length !== 1 || heads.length !== 1 || lineage.length - 1 !== lineage.filter((fact) => fact.supersedesFactId).length) {
      context.addIssue({ code: "custom", path: ["facts"], message: `lineage ${lineageKey} must be one append-only chain` });
    }
  }
});

export type PrepareAccountingCaseInput = z.infer<typeof prepareAccountingCaseSchema>;
export type PrepareAccountingCasePublicInput = z.infer<typeof prepareAccountingCasePublicSchema>;
export type ExecuteAccountingCaseInput = z.infer<typeof executeAccountingCaseSchema>;
export type GetAccountingCaseStatusInput = z.infer<typeof getAccountingCaseStatusSchema>;
