import { z } from "zod/v4";
import {
  prepareAccountingCasePublicSchema,
  sourceCaseSchema,
  type PrepareAccountingCasePublicInput,
} from "../domain/accountingCaseSchemas.js";
import { ACCOUNTING_DOCUMENT_REFERENCE_KINDS } from "../domain/accountingCase.js";
import {
  prepareContactUpdateMutationSchema,
  prepareItemCreateMutationSchema,
  prepareItemUpdateMutationSchema,
} from "../domain/xeroContactItemMutationSchemas.js";
import { hashObject } from "../security/hash.js";
import {
  XERO_DECLARED_ACCOUNT_CODE_PATTERN,
  XERO_DECLARED_TAX_TYPE_PATTERN,
} from "../policy/xeroDeclaredLedgerBinding.js";
import {
  canonicalBankTransactionCreatePayload,
  canonicalBankTransactionReversePayload,
  canonicalBankTransactionUpdatePayload,
  canonicalPaymentCreatePayload,
  canonicalPaymentReversePayload,
} from "../domain/xeroPaymentBankTransaction.js";

const publicId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/u);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");
const isoOffsetDateTime = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u)
  .refine((value) => Number.isFinite(new Date(value).getTime()), "must be a valid ISO datetime with an explicit offset");
const currency = z.string().regex(/^[A-Z]{3}$/u);
const decimal4 = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/u);
function scaledDecimal(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000n + BigInt((fraction + "0000").slice(0, 4));
}
const positiveDecimal4 = decimal4.refine((value) => scaledDecimal(value) > 0n, "must be greater than zero");
// Currency scale is validated by the injected accounting policy after this
// MCP-only normalizer; accepting up to four decimals supports typed 0/2/3
// minor-unit currencies without guessing one universal money scale here.
const money = decimal4;
const positiveMoney = positiveDecimal4;
const accountCode = z.string().trim().regex(XERO_DECLARED_ACCOUNT_CODE_PATTERN);
const taxType = z.string().trim().regex(XERO_DECLARED_TAX_TYPE_PATTERN);

export const XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES = [
  "CUSTOMER_INVOICE",
  "SUPPLIER_BILL",
  "CUSTOMER_CREDIT_NOTE",
  "SUPPLIER_CREDIT_NOTE",
] as const;

const durableContactIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("LEGAL_REGISTRY"),
    jurisdiction: publicId.describe("Registration jurisdiction supported by the source, for example SG or US."),
    registry_scheme: publicId.describe("Issuing registry or scheme, for example ACRA_UEN or IRS_EIN."),
    number: z.string().trim().min(1).max(128).describe(
      "The registration number exactly as the source document shows it. Never invent, guess, or " +
      "synthesise a placeholder in the right format to get past this field — that writes a false " +
      "regulatory identifier into the ledger, which is worse than the missing contact it unblocks. " +
      "When the counterparty has no registry number in the source, use kind PROVIDER_TENANT_ACCOUNT " +
      "instead, or stop and ask.",
    ),
  }).strict(),
  z.object({
    kind: z.literal("PROVIDER_TENANT_ACCOUNT"),
    provider: z.literal("xero"),
    scope: z.literal("PROVIDER_TENANT"),
    namespace: publicId.describe(
      "Explicit account-number namespace whose uniqueness is guaranteed inside this Xero tenant.",
    ),
    number: z.string().trim().min(1).max(128),
  }).strict(),
]).describe(
  "Typed durable identity. Omit unless the source supports every namespace field; a bare number must never be upgraded by inference.",
);

const contactSchema = z.object({
  name: z.string().trim().min(1).max(255).describe(
    "Counterparty name exactly as shown by the source document. Existing contacts are resolved server-side by this identity.",
  ),
  email: z.string().email().optional().describe("Source-supported contact email; omit when the source does not contain it."),
  durable_identity: durableContactIdentitySchema.optional(),
  company_number: z.string().trim().min(1).max(64).optional().describe(
    "Legacy bare provider field. It is collision/read-back evidence only; use durable_identity for a namespaced legal identity.",
  ),
  account_number: z.string().trim().min(1).max(64).optional().describe(
    "Legacy bare provider field. It is collision/read-back evidence only and is not a provider contact ID.",
  ),
}).strict().superRefine((value, context) => {
  const canonical = (input: string) => input.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
  if (
    value.durable_identity?.kind === "LEGAL_REGISTRY" &&
    value.company_number !== undefined &&
    canonical(value.durable_identity.number) !== canonical(value.company_number)
  ) {
    context.addIssue({
      code: "custom",
      path: ["company_number"],
      message: "must equal durable_identity.number when a legal-registry identity is supplied",
    });
  }
  if (
    value.durable_identity?.kind === "PROVIDER_TENANT_ACCOUNT" &&
    value.account_number !== undefined &&
    canonical(value.durable_identity.number) !== canonical(value.account_number)
  ) {
    context.addIssue({
      code: "custom",
      path: ["account_number"],
      message: "must equal durable_identity.number when a provider-tenant account identity is supplied",
    });
  }
});

type PublicContact = z.infer<typeof contactSchema>;

function canonicalPublicContactText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

function publicDurableContactIdentityHash(contact: PublicContact): string | undefined {
  const identity = contact.durable_identity;
  if (!identity) return undefined;
  return hashObject(identity.kind === "LEGAL_REGISTRY" ? {
    kind: identity.kind,
    jurisdiction: canonicalPublicContactText(identity.jurisdiction),
    registryScheme: canonicalPublicContactText(identity.registry_scheme),
    number: canonicalPublicContactText(identity.number),
  } : {
    kind: identity.kind,
    provider: identity.provider,
    scope: identity.scope,
    namespace: canonicalPublicContactText(identity.namespace),
    number: canonicalPublicContactText(identity.number),
  });
}

function publicContactIdentityKey(contact: PublicContact): string {
  const durableHash = publicDurableContactIdentityHash(contact);
  return durableHash
    ? `durable:${durableHash}`
    : `name:${canonicalPublicContactText(contact.name)}`;
}

function samePublicContactIdentity(left: PublicContact, right: PublicContact): boolean {
  const leftDurable = publicDurableContactIdentityHash(left);
  const rightDurable = publicDurableContactIdentityHash(right);
  if (leftDurable !== undefined || rightDurable !== undefined) {
    return leftDurable !== undefined && rightDurable !== undefined && leftDurable === rightDurable;
  }
  return canonicalPublicContactText(left.name) === canonicalPublicContactText(right.name);
}

const lineBaseShape = {
  description: z.string().trim().min(1).max(1_000),
  quantity: decimal4.describe("Positive decimal string, for example 1 or 2.5000."),
  unit_amount_excluding_tax: decimal4.describe("Per-unit amount before tax, as a decimal string."),
  source_tax_amount: money.describe("Tax printed for this source line, as a decimal string."),
} as const;

const lineSchema = z.object({
  ...lineBaseShape,
  account_code: accountCode.describe(
    "The exact ledger account code this line must post to, as it appears in the target organisation's chart of accounts. The server verifies it exists, is active and is postable; it never selects or corrects it.",
  ),
  tax_type: taxType.describe(
    "The exact ledger tax code (TaxType) for this line, as it appears in the target organisation's tax rates. The server verifies it exists, is active, is applicable to the account, and that source_tax_amount equals the organisation's real rate applied to this line.",
  ),
}).strict().superRefine((line, context) => {
  if (scaledDecimal(line.quantity) <= 0n) {
    context.addIssue({ code: "custom", path: ["quantity"], message: "must be greater than zero" });
  }
});

const originalDocumentSchema = z.object({
  reference: z.string().trim().min(1).max(255).describe(
    "Ordinary issuer reference of the historical original invoice or bill. Never supply a provider object ID.",
  ),
  reference_kind: z.enum(ACCOUNTING_DOCUMENT_REFERENCE_KINDS).describe(
    "Source-supported meaning of the historical original reference.",
  ),
  document_date: date.describe("Date of the historical original invoice or bill."),
}).strict().describe(
  "Provider-neutral historical linkage. The server resolves the exact original from complete provider history; this coordinate carries no provider ID.",
);

const documentBaseShape = {
  document_type: z.enum(XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES).describe(
    "Business document direction and kind; this is not a provider action or route ID.",
  ),
  reference: z.string().trim().min(1).max(255),
  reference_kind: z.enum(ACCOUNTING_DOCUMENT_REFERENCE_KINDS).describe(
    "Meaning of the source reference. FORMAL_DOCUMENT_NUMBER is an issuer-assigned number for one document; GENERIC_RECURRING_REFERENCE is a reusable label that may recur on different dates. This is source evidence, not a provider ID, and must never be inferred from the string format.",
  ),
  document_date: date,
  due_date: date.optional(),
  currency,
  contact: contactSchema,
  invoice_exchange_rate: positiveDecimal4.optional().describe(
    "Optional source-supported invoice exchange rate. Omit rather than guess; the server will block a foreign-currency route when required evidence is absent.",
  ),
  review_note: z.string().trim().min(1).max(256).optional().describe(
    "Optional free-text source-review record kept with the document for audit. It is recorded verbatim and never changes any server decision.",
  ),
  declared_net: positiveMoney,
  declared_tax: money,
  declared_gross: positiveMoney,
  document_validity: z.enum(["VALID_FOR_LIVE_BOOKS", "TEST_OR_NOT_VALID", "UNKNOWN"]),
  original_document: originalDocumentSchema.optional(),
} as const;

const documentSchema = z.object({
  ...documentBaseShape,
  lines: z.array(lineSchema).min(1).max(100),
}).strict().superRefine((document, context) => {
  const credit = document.document_type.endsWith("CREDIT_NOTE");
  if (!credit && !document.due_date) {
    context.addIssue({ code: "custom", path: ["due_date"], message: "invoices and bills require a due date" });
  }
  if (document.due_date && document.due_date < document.document_date) {
    context.addIssue({ code: "custom", path: ["due_date"], message: "must not be before document_date" });
  }
  if (credit && !document.original_document) {
    context.addIssue({ code: "custom", path: ["original_document"], message: "credit notes require original-document evidence" });
  }
  if (credit && document.original_document && document.original_document.document_date > document.document_date) {
    context.addIssue({
      code: "custom",
      path: ["original_document", "document_date"],
      message: "must not be after the credit-note date",
    });
  }
  if (!credit && document.original_document) {
    context.addIssue({ code: "custom", path: ["original_document"], message: "only credit notes accept original-document evidence" });
  }
});

/**
 * Quote / purchase-order lines deliberately omit `source_tax_amount`: these
 * commercial documents are not journal events, so the Case compiler must not
 * pretend that an invoice-style source net/tax/gross reconciliation exists.
 * Xero still validates the declared AccountCode and TaxType during the
 * existing commercial-document preflight and again at write time.
 */
const commercialLineSchema = z.object({
  description: z.string().trim().min(1).max(1_000),
  quantity: positiveDecimal4,
  unit_amount: money,
  account_code: accountCode,
  tax_type: taxType,
}).strict();

const commercialDocumentCommon = {
  reference: z.string().trim().min(1).max(255),
  document_date: date,
  currency,
  contact: contactSchema,
  line_amount_type: z.enum(["EXCLUSIVE", "INCLUSIVE", "NO_TAX"]),
  lines: z.array(commercialLineSchema).min(1).max(20),
  document_validity: z.enum(["VALID_FOR_LIVE_BOOKS", "TEST_OR_NOT_VALID", "UNKNOWN"]),
} as const;

const commercialDocumentSchema = z.discriminatedUnion("document_type", [
  z.object({
    ...commercialDocumentCommon,
    document_type: z.literal("QUOTE"),
    expiry_date: date,
  }).strict().superRefine((document, context) => {
    if (document.expiry_date < document.document_date) {
      context.addIssue({ code: "custom", path: ["expiry_date"], message: "must not be before document_date" });
    }
  }),
  z.object({
    ...commercialDocumentCommon,
    document_type: z.literal("PURCHASE_ORDER"),
    expected_arrival_date: date.optional(),
    delivery_date: date.optional(),
  }).strict().superRefine((document, context) => {
    if (document.expected_arrival_date && document.expected_arrival_date < document.document_date) {
      context.addIssue({ code: "custom", path: ["expected_arrival_date"], message: "must not be before document_date" });
    }
    if (document.delivery_date && document.delivery_date < document.document_date) {
      context.addIssue({ code: "custom", path: ["delivery_date"], message: "must not be before document_date" });
    }
  }),
]);

const manualJournalLineSchema = z.object({
  description: z.string().trim().min(1).max(1_000),
  account_code: accountCode,
  // Xero's released DRAFT manual-journal adapter has no tax field. Keeping
  // this explicit avoids inventing tax treatment while making the existing
  // route contract's NONE-only rule visible to the Agent.
  tax_type: z.literal("NONE"),
  debit: positiveMoney.optional(),
  credit: positiveMoney.optional(),
}).strict().refine(
  (line) => (line.debit !== undefined) !== (line.credit !== undefined),
  "each line must declare exactly one of debit or credit",
);

const manualJournalSchema = z.object({
  narration: z.string().trim().min(1).max(255),
  journal_date: date,
  lines: z.array(manualJournalLineSchema).min(2).max(50),
  document_validity: z.enum(["VALID_FOR_LIVE_BOOKS", "TEST_OR_NOT_VALID", "UNKNOWN"]),
}).strict();

const updateNativeReplacement = (documentType: typeof XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES[number]) =>
  z.object({
    ...documentBaseShape,
    document_type: z.literal(documentType),
    status: z.literal("DRAFT"),
    lines: z.array(lineSchema).min(1).max(100),
  }).strict().superRefine((document, context) => {
    const credit = document.document_type.endsWith("CREDIT_NOTE");
    if (!credit && !document.due_date) {
      context.addIssue({ code: "custom", path: ["due_date"], message: "invoices and bills require a due date" });
    }
    if (document.due_date && document.due_date < document.document_date) {
      context.addIssue({ code: "custom", path: ["due_date"], message: "must not be before document_date" });
    }
    if (credit && !document.original_document) {
      context.addIssue({ code: "custom", path: ["original_document"], message: "credit notes require original-document evidence" });
    }
    if (credit && document.original_document && document.original_document.document_date > document.document_date) {
      context.addIssue({
        code: "custom",
        path: ["original_document", "document_date"],
        message: "must not be after the credit-note date",
      });
    }
    if (!credit && document.original_document) {
      context.addIssue({ code: "custom", path: ["original_document"], message: "only credit notes accept original-document evidence" });
    }
  });

const quoteUpdateReplacementSchema = z.object({
  ...commercialDocumentCommon,
  document_type: z.literal("QUOTE"),
  status: z.literal("DRAFT"),
  expiry_date: date,
}).strict().superRefine((document, context) => {
  if (document.expiry_date < document.document_date) {
    context.addIssue({ code: "custom", path: ["expiry_date"], message: "must not be before document_date" });
  }
});

const purchaseOrderUpdateReplacementSchema = z.object({
  ...commercialDocumentCommon,
  document_type: z.literal("PURCHASE_ORDER"),
  status: z.literal("DRAFT"),
  expected_arrival_date: date.optional(),
  delivery_date: date.optional(),
}).strict().superRefine((document, context) => {
  if (document.expected_arrival_date && document.expected_arrival_date < document.document_date) {
    context.addIssue({ code: "custom", path: ["expected_arrival_date"], message: "must not be before document_date" });
  }
  if (document.delivery_date && document.delivery_date < document.document_date) {
    context.addIssue({ code: "custom", path: ["delivery_date"], message: "must not be before document_date" });
  }
});

const manualJournalUpdateReplacementSchema = z.object({
  narration: z.string().trim().min(1).max(255),
  journal_date: date,
  lines: z.array(manualJournalLineSchema).min(2).max(50),
  document_validity: z.enum(["VALID_FOR_LIVE_BOOKS", "TEST_OR_NOT_VALID", "UNKNOWN"]),
  status: z.literal("DRAFT"),
}).strict();

export const draftDocumentUpdateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("customer_invoice.update_draft"),
    target_xero_object_id: z.string().uuid(),
    expected_updated_at: isoOffsetDateTime,
    replacement: updateNativeReplacement("CUSTOMER_INVOICE"),
  }).strict(),
  z.object({
    action: z.literal("supplier_bill.update_draft"),
    target_xero_object_id: z.string().uuid(),
    expected_updated_at: isoOffsetDateTime,
    replacement: updateNativeReplacement("SUPPLIER_BILL"),
  }).strict(),
  z.object({
    action: z.literal("credit_note.update_draft"),
    target_xero_object_id: z.string().uuid(),
    expected_updated_at: isoOffsetDateTime,
    replacement: z.union([
      updateNativeReplacement("CUSTOMER_CREDIT_NOTE"),
      updateNativeReplacement("SUPPLIER_CREDIT_NOTE"),
    ]),
  }).strict(),
  z.object({
    action: z.literal("quote.update_draft"),
    target_xero_object_id: z.string().uuid(),
    expected_updated_at: isoOffsetDateTime,
    replacement: quoteUpdateReplacementSchema,
  }).strict(),
  z.object({
    action: z.literal("purchase_order.update_draft"),
    target_xero_object_id: z.string().uuid(),
    expected_updated_at: isoOffsetDateTime,
    replacement: purchaseOrderUpdateReplacementSchema,
  }).strict(),
  z.object({
    action: z.literal("manual_journal.update_draft"),
    target_xero_object_id: z.string().uuid(),
    expected_updated_at: isoOffsetDateTime,
    replacement: manualJournalUpdateReplacementSchema,
  }).strict(),
]).describe(
  "A complete replacement of one exact existing Xero DRAFT. It is optimistic-concurrency protected by expected_updated_at and never accepts a patch.",
);

// Reuse the legacy primitive input schemas for their exact field whitelist;
// the business intake removes only legacy source bookkeeping because Case
// provenance is generated server-side from the Case event/unit instead.
const contactBasicUpdateSchema = prepareContactUpdateMutationSchema.omit({
  source_ref: true,
  source_unit_key: true,
  source_sha256: true,
});
const itemBasicCreateSchema = prepareItemCreateMutationSchema.omit({
  source_ref: true,
  source_unit_key: true,
  source_sha256: true,
});
const itemBasicUpdateSchema = prepareItemUpdateMutationSchema.omit({
  source_ref: true,
  source_unit_key: true,
  source_sha256: true,
});

const newContactSchema = z.object({
  usage_roles: z.array(z.enum(["CUSTOMER", "SUPPLIER"])).min(1).max(2)
    .refine((values) => new Set(values).size === values.length, "usage roles must be unique")
    .optional().describe(
      "Optional usage directions for contact-only recovery. For documents, the server derives customer/supplier usage from those documents.",
    ),
  contact: contactSchema,
}).strict().describe(
  "Use only when this submitted Case explicitly requires creation of a genuinely new contact, including a server-issued contact recovery continuation. Do not repeat a known existing contact.",
);

export const ledgerStateTransitionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("customer_invoice.authorise"),
    invoice_id: z.string().uuid(),
  }).strict(),
  z.object({
    action: z.literal("supplier_bill.authorise"),
    invoice_id: z.string().uuid(),
  }).strict(),
  z.object({
    action: z.literal("manual_journal.post"),
    manual_journal_id: z.string().uuid(),
  }).strict(),
]).describe(
  "One exact transition of an existing Xero DRAFT object. The action vocabulary is closed; no generic status or provider payload is accepted.",
);

const fixedFourPositive = z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{4}$/u)
  .refine((value) => BigInt(value.replace(".", "")) > 0n, "must be greater than zero");
const creditNoteType = z.enum(["ACCRECCREDIT", "ACCPAYCREDIT"]);

export const ledgerAdjustmentSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("customer_invoice.void"), invoice_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("supplier_bill.void"), invoice_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("credit_note.authorise"), credit_note_id: z.string().uuid(), credit_note_type: creditNoteType }).strict(),
  z.object({
    action: z.literal("credit_note.allocate"),
    credit_note_id: z.string().uuid(),
    credit_note_type: creditNoteType,
    target_invoice_id: z.string().uuid(),
    target_invoice_type: z.enum(["ACCREC", "ACCPAY"]),
    amount: fixedFourPositive,
    allocation_date: date,
  }).strict(),
  z.object({
    action: z.literal("credit_note.refund"),
    credit_note_id: z.string().uuid(),
    credit_note_type: creditNoteType,
    bank_account_id: z.string().uuid(),
    amount: fixedFourPositive,
    refund_date: date,
  }).strict(),
  z.object({ action: z.literal("credit_note.void"), credit_note_id: z.string().uuid(), credit_note_type: creditNoteType }).strict(),
  z.object({ action: z.literal("credit_note.unallocate"), credit_note_id: z.string().uuid(), allocation_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("manual_journal.void"), manual_journal_id: z.string().uuid() }).strict(),
]).superRefine((value, context) => {
  if (value.action === "credit_note.allocate") {
    const expected = value.credit_note_type === "ACCRECCREDIT" ? "ACCREC" : "ACCPAY";
    if (value.target_invoice_type !== expected) {
      context.addIssue({ code: "custom", path: ["target_invoice_type"], message: "must match credit-note direction" });
    }
  }
}).describe("One closed exact-target ledger adjustment; no generic status transition or provider payload is accepted.");

const paymentBankLineSchema = z.object({
  description: z.string().trim().min(1).max(4_000), quantity: positiveMoney,
  unit_amount: z.string().regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/u),
  account_code: accountCode, tax_type: z.string().trim().min(1).max(50),
  tracking_option_ids: z.array(z.string().uuid()).max(2).default([]),
}).strict();
const paymentBankCommon = {
  type: z.enum(["SPEND", "RECEIVE"]), contact_id: z.string().uuid(), bank_account_id: z.string().uuid(),
  transaction_date: date, reference: z.string().trim().min(1).max(512),
  line_amount_type: z.enum(["EXCLUSIVE", "INCLUSIVE", "NO_TAX"]),
  currency_rate: positiveMoney.optional(), lines: z.array(paymentBankLineSchema).min(1).max(50),
} as const;
export const paymentBankLedgerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("payment.create"), invoice_id: z.string().uuid(), invoice_type: z.enum(["ACCREC", "ACCPAY"]),
    bank_account_id: z.string().uuid(), payment_date: date, amount: positiveMoney, reference: z.string().trim().min(1).max(512).optional() }).strict(),
  z.object({ action: z.literal("payment.reverse"), payment_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("bank_transaction.create"), ...paymentBankCommon }).strict(),
  z.object({ action: z.literal("bank_transaction.update"), bank_transaction_id: z.string().uuid(), expected_updated_at: isoOffsetDateTime,
    ...paymentBankCommon }).strict(),
  z.object({ action: z.literal("bank_transaction.reverse"), bank_transaction_id: z.string().uuid() }).strict(),
]);

export const trackingReferenceDataSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tracking_category.create"), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({
    action: z.literal("tracking_category.update"),
    tracking_category_id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
  }).strict(),
  z.object({
    action: z.literal("tracking_option.create"),
    tracking_category_id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
  }).strict(),
  z.object({
    action: z.literal("tracking_option.update"),
    tracking_category_id: z.string().uuid(),
    tracking_option_id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
  }).strict(),
]).describe("Create or rename one ACTIVE Xero tracking category or option through the closed reference-data Case family.");

/**
 * Agent-facing prepare contract. It expresses ordinary business documents and
 * deliberately excludes tenant IDs, generic provider actions, account codes,
 * tax type IDs, canonical payloads, receipts and mutation identities. The
 * only action IDs admitted are the three closed existing-draft transitions.
 */
export const xeroAccountingCaseBusinessIntakeSchema = z.object({
  case_id: publicId.describe("Agent-chosen stable Case identity; it is not a provider or tenant ID."),
  expected_version: z.number().int().min(0).describe("Use 0 when creating the first Case version."),
  continuation_token: z.string().regex(/^(?:acc|acr)_[0-9a-f]{64}$/u).optional().describe(
    "Opaque server-issued continuation token. Never construct or modify it.",
  ),
  source_case: sourceCaseSchema.optional().describe(
    "Optional citation of the upstream case this submitted batch was read from, for example a Google Drive " +
    "case shared with a separate connector. Omit when material arrived some other way, such as a direct chat " +
    "upload; that is an ordinary Case and is not degraded by the omission. One upstream case binds to exactly " +
    "one Xero organisation on first use; citing it again against a different organisation is refused.",
  ),
  source_label: z.string().trim().min(1).max(256),
  source_set_complete: z.literal(true).describe(
    "True only when this submitted Case's bounded source set is complete. It never asserts the whole business, ledger, period, or real-world document population is complete.",
  ),
  documents: z.array(documentSchema).max(256),
  commercial_documents: z.array(commercialDocumentSchema).max(256).optional().describe(
    "Customer quotes and supplier purchase orders to create only in Xero DRAFT. These are typed commercial documents, not generic object writes.",
  ),
  manual_journals: z.array(manualJournalSchema).max(100).optional().describe(
    "Balanced Xero DRAFT manual journals. Every line explicitly names one active account code and uses tax_type NONE; the server rejects an unbalanced journal before any provider request.",
  ),
  draft_document_updates: z.array(draftDocumentUpdateSchema).max(100).optional().describe(
    "Complete same-ID replacements of existing Xero DRAFT invoices, bills, credit notes, quotes, purchase orders, or manual journals.",
  ),
  ledger_state_transitions: z.array(ledgerStateTransitionSchema).max(100).optional().describe(
    "Promote an exact existing Xero draft: authorise a customer invoice, authorise a supplier bill, or post a manual journal.",
  ),
  ledger_adjustments: z.array(ledgerAdjustmentSchema).max(100).optional().describe(
    "Authorise, allocate, refund, or void one exact supported existing ledger object.",
  ),
  payment_bank_ledger: z.array(paymentBankLedgerSchema).max(100).optional().describe(
    "Create/reverse one Xero payment record or create/replace one Bank Transaction; this never initiates external money movement.",
  ),
  contact_basic_updates: z.array(contactBasicUpdateSchema).max(100).optional().describe(
    "Constrained updates to an existing Xero Contact's basic fields only. The server rereads the exact contact, rejects stale or duplicate changes, and records exact read-back through the Accounting Case.",
  ),
  item_basic_creates: z.array(itemBasicCreateSchema).max(100).optional().describe(
    "Create an untracked Xero Item using only the safe basic fields. Inventory quantities, values and tracked-inventory state are not accepted.",
  ),
  item_basic_updates: z.array(itemBasicUpdateSchema).max(100).optional().describe(
    "Constrained updates to an existing untracked Xero Item. The server rereads the exact Item and rejects a tracked-inventory target or stale version.",
  ),
  tracking_reference_data: z.array(trackingReferenceDataSchema).max(100).optional().describe(
    "Create or rename ACTIVE tracking categories/options. Archive, delete and generic status changes are not accepted.",
  ),
  new_contacts: z.array(newContactSchema).max(100).optional().describe(
    "Omit for known existing counterparties. Include only genuinely new contacts that this exact submitted Case must create; the server resolves existing identities and same-Case dependencies.",
  ),
}).strict().superRefine((intake, context) => {
  if (
    intake.documents.length === 0 &&
    (intake.commercial_documents?.length ?? 0) === 0 &&
    (intake.manual_journals?.length ?? 0) === 0 &&
    (intake.draft_document_updates?.length ?? 0) === 0 &&
    (intake.ledger_state_transitions?.length ?? 0) === 0 &&
    (intake.ledger_adjustments?.length ?? 0) === 0 &&
    (intake.payment_bank_ledger?.length ?? 0) === 0 &&
    (intake.contact_basic_updates?.length ?? 0) === 0 &&
    (intake.item_basic_creates?.length ?? 0) === 0 &&
    (intake.item_basic_updates?.length ?? 0) === 0 &&
    (intake.tracking_reference_data?.length ?? 0) === 0 &&
    (intake.new_contacts?.length ?? 0) === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["documents"],
      message: "must include at least one typed business document, journal, reference-data action, or genuinely new contact",
    });
  }
  for (const [index, document] of intake.documents.entries()) {
    if (!document.document_type.endsWith("CREDIT_NOTE")) continue;
    const coordinateCandidates = intake.documents.filter((candidate) =>
      candidate.document_type === originalDocumentType(document.document_type) &&
      candidate.reference === document.original_document?.reference &&
      candidate.document_date === document.original_document?.document_date);
    if (coordinateCandidates.length > 1) {
      context.addIssue({
        code: "custom",
        path: ["documents", index, "original_document"],
        message: "matches more than one submitted original invoice or bill",
      });
      continue;
    }
    const submittedOriginal = coordinateCandidates[0];
    if (submittedOriginal && !matchesCreditOriginal(document, submittedOriginal)) {
      context.addIssue({
        code: "custom",
        path: ["documents", index, "original_document"],
        message: "a submitted original with this reference/date must exactly match reference kind, contact, currency, and direction",
      });
    }
  }
  const contactsByCanonicalName = new Map<string, Set<string>>();
  const everyContact = [
    ...(intake.new_contacts ?? []).map((candidate) => candidate.contact),
    ...intake.documents.map((document) => document.contact),
    ...(intake.commercial_documents ?? []).map((document) => document.contact),
    ...(intake.draft_document_updates ?? []).flatMap((update) =>
      "contact" in update.replacement ? [update.replacement.contact] : []),
  ];
  for (const contact of everyContact) {
    const durableHash = publicDurableContactIdentityHash(contact);
    if (!durableHash) continue;
    const canonicalName = canonicalPublicContactText(contact.name);
    const identities = contactsByCanonicalName.get(canonicalName) ?? new Set<string>();
    identities.add(durableHash);
    contactsByCanonicalName.set(canonicalName, identities);
  }
  if ([...contactsByCanonicalName.values()].some((identities) => identities.size > 1)) {
    context.addIssue({
      code: "custom",
      path: ["new_contacts"],
      message: "one Xero display name cannot represent different typed durable contact identities",
    });
  }
  const groups = new Map<string, NonNullable<typeof intake.new_contacts>>();
  for (const candidate of intake.new_contacts ?? []) {
    const key = publicContactIdentityKey(candidate.contact);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const conflicting = group.some((candidate) =>
      canonicalPublicContactText(candidate.contact.name) !== canonicalPublicContactText(first.contact.name) ||
      (["email", "company_number", "account_number"] as const).some((field) =>
        candidate.contact[field] !== undefined && first.contact[field] !== undefined &&
        canonicalPublicContactText(candidate.contact[field]!) !== canonicalPublicContactText(first.contact[field]!)));
    if (conflicting) {
      context.addIssue({
        code: "custom",
        path: ["new_contacts"],
        message: "one typed durable contact identity has conflicting submitted contact fields",
      });
    }
    const derivedRoles = [
      ...intake.documents.map((document) => ({ contact: document.contact, role: role(document.document_type) })),
      ...(intake.commercial_documents ?? []).map((document) => ({
        contact: document.contact,
        role: document.document_type === "QUOTE" ? "CUSTOMER" as const : "SUPPLIER" as const,
      })),
      ...(intake.draft_document_updates ?? []).flatMap((update) => {
        const replacement = update.replacement;
        if (!("contact" in replacement)) return [];
        return [{
          contact: replacement.contact,
          role: replacement.document_type === "QUOTE" || replacement.document_type.startsWith("CUSTOMER_")
            ? "CUSTOMER" as const
            : "SUPPLIER" as const,
        }];
      }),
    ].flatMap((document) => samePublicContactIdentity(first.contact, document.contact) ? [document.role] : []);
    const explicitRoles = group.flatMap((candidate) => candidate.usage_roles ?? []);
    if (new Set([...explicitRoles, ...derivedRoles]).size === 0) {
      context.addIssue({
        code: "custom",
        path: ["new_contacts"],
        message: "a new contact requires a document-derived or explicit usage role",
      });
    }
  }
});

export type XeroAccountingCaseBusinessIntake = z.infer<typeof xeroAccountingCaseBusinessIntakeSchema>;

function derivedId(prefix: string, material: unknown): string {
  return `${prefix}-${hashObject(material).slice(0, 32)}`;
}

type BusinessDocument = z.infer<typeof documentSchema>;
type BusinessCommercialDocument = z.infer<typeof commercialDocumentSchema>;
type BusinessManualJournal = z.infer<typeof manualJournalSchema>;
type BusinessLedgerStateTransition = z.infer<typeof ledgerStateTransitionSchema>;
type BusinessLedgerAdjustment = z.infer<typeof ledgerAdjustmentSchema>;
type BusinessPaymentBankLedger = z.infer<typeof paymentBankLedgerSchema>;
type BusinessDraftDocumentUpdate = z.infer<typeof draftDocumentUpdateSchema>;

function originalDocumentType(
  documentType: typeof XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES[number],
): "CUSTOMER_INVOICE" | "SUPPLIER_BILL" {
  return documentType.startsWith("CUSTOMER_") ? "CUSTOMER_INVOICE" : "SUPPLIER_BILL";
}

function matchesCreditOriginal(credit: BusinessDocument, candidate: BusinessDocument): boolean {
  return credit.document_type.endsWith("CREDIT_NOTE") &&
    candidate.document_type === originalDocumentType(credit.document_type) &&
    candidate.reference === credit.original_document?.reference &&
    candidate.reference_kind === credit.original_document.reference_kind &&
    candidate.document_date === credit.original_document.document_date &&
    candidate.currency === credit.currency &&
    candidate.contact.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en") ===
      credit.contact.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en") &&
    hashObject(candidate.contact.durable_identity ?? null) === hashObject(credit.contact.durable_identity ?? null);
}

function documentIdentity(caseId: string, index: number, document: BusinessDocument) {
  return { caseId, kind: "DOCUMENT", index, reference: document.reference } as const;
}

function commercialDocumentIdentity(
  caseId: string,
  index: number,
  document: BusinessCommercialDocument,
) {
  return { caseId, kind: "COMMERCIAL_DOCUMENT", index, documentType: document.document_type, reference: document.reference } as const;
}

function manualJournalIdentity(caseId: string, index: number, journal: BusinessManualJournal) {
  return { caseId, kind: "MANUAL_JOURNAL", index, narration: journal.narration, date: journal.journal_date } as const;
}

function referenceDataIdentity(
  caseId: string,
  kind: "CONTACT_BASIC_UPDATE" | "ITEM_BASIC_CREATE_UNTRACKED" | "ITEM_BASIC_UPDATE_UNTRACKED" |
    "TRACKING_REFERENCE_DATA",
  index: number,
  action: unknown,
) {
  return { caseId, kind, index, action } as const;
}

function ledgerStateTransitionIdentity(
  caseId: string,
  index: number,
  transition: BusinessLedgerStateTransition,
) {
  return { caseId, kind: "LEDGER_STATE_TRANSITION", index, transition } as const;
}

function ledgerAdjustmentIdentity(caseId: string, index: number, adjustment: BusinessLedgerAdjustment) {
  return { caseId, kind: "LEDGER_ADJUSTMENT", index, adjustment } as const;
}
function paymentBankLedgerIdentity(caseId: string, index: number, item: BusinessPaymentBankLedger) {
  return { caseId, kind: "PAYMENT_BANK_LEDGER", index, item } as const;
}

function draftDocumentUpdateIdentity(
  caseId: string,
  index: number,
  update: BusinessDraftDocumentUpdate,
) {
  return {
    caseId,
    kind: "DRAFT_DOCUMENT_UPDATE",
    index,
    action: update.action,
    targetXeroObjectId: update.target_xero_object_id,
  } as const;
}

function role(documentType: typeof XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES[number]): "CUSTOMER" | "SUPPLIER" {
  return documentType.startsWith("CUSTOMER_") ? "CUSTOMER" : "SUPPLIER";
}

function documentKind(
  documentType: typeof XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES[number],
): "INVOICE" | "CREDIT_NOTE" {
  return documentType.endsWith("CREDIT_NOTE") ? "CREDIT_NOTE" : "INVOICE";
}

/** Deterministic MCP-layer normalization; it performs no ledger or policy decision. */
export function normalizeXeroAccountingCaseBusinessIntake(
  raw: XeroAccountingCaseBusinessIntake,
): PrepareAccountingCasePublicInput {
  const intake = xeroAccountingCaseBusinessIntakeSchema.parse(raw);
  const documentArtifactId = derivedId("source", {
    caseId: intake.case_id,
    label: intake.source_label,
    kind: "DOCUMENTS",
  });
  const contactArtifactId = derivedId("source", {
    caseId: intake.case_id,
    label: intake.source_label,
    kind: "NEW_CONTACTS",
  });
  const groupedContacts = [...(intake.new_contacts ?? []).reduce((groups, candidate) => {
    const key = publicContactIdentityKey(candidate.contact);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
    return groups;
  }, new Map<string, NonNullable<typeof intake.new_contacts>>())]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([identityKey, candidates]) => {
      const representative = [...candidates]
        .sort((left, right) => hashObject(left).localeCompare(hashObject(right)))[0]!;
      const usageRoles = [...new Set([
        ...candidates.flatMap((candidate) => candidate.usage_roles ?? []),
        ...intake.documents.flatMap((document) =>
          samePublicContactIdentity(representative.contact, document.contact)
            ? [role(document.document_type)]
            : []),
        ...(intake.commercial_documents ?? []).flatMap((document) =>
          samePublicContactIdentity(representative.contact, document.contact)
            ? [document.document_type === "QUOTE" ? "CUSTOMER" as const : "SUPPLIER" as const]
            : []),
        ...(intake.draft_document_updates ?? []).flatMap((update) => {
          const replacement = update.replacement;
          if (!("contact" in replacement)) return [];
          return samePublicContactIdentity(representative.contact, replacement.contact)
            ? [replacement.document_type === "QUOTE" || replacement.document_type.startsWith("CUSTOMER_")
                ? "CUSTOMER" as const
                : "SUPPLIER" as const]
            : [];
        }),
      ])].sort((left, right) => left.localeCompare(right)) as Array<"CUSTOMER" | "SUPPLIER">;
      return { identityKey, representative, usageRoles };
    });
  const contactUnits = groupedContacts.map((contact) => ({
    unitId: derivedId("unit", { caseId: intake.case_id, kind: "CONTACT", identityKey: contact.identityKey }),
    expectedFactKinds: ["CONTACT_CANDIDATE" as const],
  }));
  const submittedOriginalForCredit = new Map<number, number>();
  for (const [creditIndex, credit] of intake.documents.entries()) {
    if (!credit.document_type.endsWith("CREDIT_NOTE")) continue;
    const originalIndex = intake.documents.findIndex((candidate) => matchesCreditOriginal(credit, candidate));
    if (originalIndex >= 0) submittedOriginalForCredit.set(creditIndex, originalIndex);
  }
  const submittedOriginalIndices = new Set(submittedOriginalForCredit.values());
  const documentUnits = intake.documents.map((document, index) => ({
    unitId: derivedId("unit", { caseId: intake.case_id, kind: "DOCUMENT", index, document }),
    expectedFactKinds: [submittedOriginalIndices.has(index) ? "EVIDENCE" as const : "NATIVE_DOCUMENT" as const],
  }));
  const commercialDocumentUnits = (intake.commercial_documents ?? []).map((document, index) => ({
    unitId: derivedId("unit", { caseId: intake.case_id, kind: "COMMERCIAL_DOCUMENT", index, document }),
    expectedFactKinds: ["COMMERCIAL_DOCUMENT" as const],
  }));
  const manualJournalUnits = (intake.manual_journals ?? []).map((journal, index) => ({
    unitId: derivedId("unit", { caseId: intake.case_id, kind: "BALANCED_JOURNAL", index, journal }),
    expectedFactKinds: ["BALANCED_JOURNAL" as const],
  }));
  const ledgerStateTransitionUnits = (intake.ledger_state_transitions ?? []).map((transition, index) => ({
    unitId: derivedId("unit", ledgerStateTransitionIdentity(intake.case_id, index, transition)),
    expectedFactKinds: ["LEDGER_STATE_TRANSITION" as const],
  }));
  const ledgerAdjustmentUnits = (intake.ledger_adjustments ?? []).map((adjustment, index) => ({
    unitId: derivedId("unit", ledgerAdjustmentIdentity(intake.case_id, index, adjustment)),
    expectedFactKinds: ["LEDGER_ADJUSTMENT" as const],
  }));
  const paymentBankLedgerUnits = (intake.payment_bank_ledger ?? []).map((item, index) => ({
    unitId: derivedId("unit", paymentBankLedgerIdentity(intake.case_id, index, item)),
    expectedFactKinds: ["PAYMENT_BANK_LEDGER" as const],
  }));
  const draftDocumentUpdateUnits = (intake.draft_document_updates ?? []).map((update, index) => ({
    unitId: derivedId("unit", draftDocumentUpdateIdentity(intake.case_id, index, update)),
    expectedFactKinds: ["DRAFT_DOCUMENT_UPDATE" as const],
  }));
  const contactBasicUpdateUnits = (intake.contact_basic_updates ?? []).map((update, index) => ({
    unitId: derivedId("unit", { caseId: intake.case_id, kind: "CONTACT_BASIC_UPDATE", index, update }),
    expectedFactKinds: ["CONTACT_BASIC_UPDATE" as const],
  }));
  const itemBasicCreateUnits = (intake.item_basic_creates ?? []).map((item, index) => ({
    unitId: derivedId("unit", { caseId: intake.case_id, kind: "ITEM_BASIC_CREATE_UNTRACKED", index, item }),
    expectedFactKinds: ["ITEM_BASIC_CREATE_UNTRACKED" as const],
  }));
  const itemBasicUpdateUnits = (intake.item_basic_updates ?? []).map((update, index) => ({
    unitId: derivedId("unit", { caseId: intake.case_id, kind: "ITEM_BASIC_UPDATE_UNTRACKED", index, update }),
    expectedFactKinds: ["ITEM_BASIC_UPDATE_UNTRACKED" as const],
  }));
  const trackingReferenceDataUnits = (intake.tracking_reference_data ?? []).map((tracking, index) => ({
    unitId: derivedId("unit", { caseId: intake.case_id, kind: "TRACKING_REFERENCE_DATA", index, tracking }),
    expectedFactKinds: ["TRACKING_REFERENCE_DATA" as const],
  }));
  const documentEventKeys = intake.documents.map((document, index) =>
    derivedId("event", documentIdentity(intake.case_id, index, document)));
  const contactFacts = groupedContacts.map(({ identityKey, representative: candidate, usageRoles }, index) => {
    const unit = contactUnits[index]!;
    const identity = { caseId: intake.case_id, kind: "CONTACT", identityKey };
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "CONTACT_CANDIDATE" as const,
      usageRoles,
      name: candidate.contact.name,
      ...(candidate.contact.email ? { email: candidate.contact.email } : {}),
      ...(candidate.contact.durable_identity ? {
        durableIdentity: candidate.contact.durable_identity.kind === "LEGAL_REGISTRY"
          ? {
              kind: "LEGAL_REGISTRY" as const,
              jurisdiction: candidate.contact.durable_identity.jurisdiction,
              registryScheme: candidate.contact.durable_identity.registry_scheme,
              number: candidate.contact.durable_identity.number,
            }
          : {
              kind: "PROVIDER_TENANT_ACCOUNT" as const,
              providerId: candidate.contact.durable_identity.provider,
              namespace: candidate.contact.durable_identity.namespace,
              number: candidate.contact.durable_identity.number,
            },
      } : {}),
      ...(candidate.contact.company_number ? { companyNumber: candidate.contact.company_number } : {}),
      ...(candidate.contact.account_number ? { accountNumber: candidate.contact.account_number } : {}),
    };
  });
  const documentFacts = intake.documents.map((document, index) => {
    const unit = documentUnits[index]!;
    const identity = documentIdentity(intake.case_id, index, document);
    if (submittedOriginalIndices.has(index)) {
      const relatedCreditIndex = [...submittedOriginalForCredit.entries()]
        .find(([, originalIndex]) => originalIndex === index)?.[0];
      return {
        factId: derivedId("fact", identity),
        lineageKey: derivedId("lineage", identity),
        eventKey: derivedId("event", identity),
        sourceUnitIds: [unit.unitId],
        origin: "MODEL_EXTRACTED" as const,
        revision: 1,
        kind: "EVIDENCE" as const,
        evidenceRole: "SUBMITTED_ORIGINAL_TRANSACTION_SUPPORT" as const,
        ...(relatedCreditIndex !== undefined
          ? { relatedEventKey: documentEventKeys[relatedCreditIndex]! }
          : {}),
        note: "Submitted historical original support; server provider-history resolution is authoritative and this fact emits no write operation.",
      };
    }
    const kind = documentKind(document.document_type);
    const counterpartyRole = role(document.document_type);
    const eventKey = derivedId("event", identity);
    const normalizedLines = document.lines.map((line, lineIndex) => ({
      lineId: derivedId("line", { ...identity, lineIndex, description: line.description }),
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unit_amount_excluding_tax,
      sourceTax: line.source_tax_amount,
      accountCode: line.account_code,
      taxType: line.tax_type,
    }));
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey,
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "NATIVE_DOCUMENT" as const,
      documentKind: kind,
      counterpartyRole,
      reference: document.reference,
      referenceKind: document.reference_kind,
      documentDate: document.document_date,
      ...(document.due_date ? { dueDate: document.due_date } : {}),
      currency: document.currency,
      contactName: document.contact.name,
      ...(document.contact.durable_identity ? {
        contactDurableIdentity: document.contact.durable_identity.kind === "LEGAL_REGISTRY"
          ? {
              kind: "LEGAL_REGISTRY" as const,
              jurisdiction: document.contact.durable_identity.jurisdiction,
              registryScheme: document.contact.durable_identity.registry_scheme,
              number: document.contact.durable_identity.number,
            }
          : {
              kind: "PROVIDER_TENANT_ACCOUNT" as const,
              providerId: document.contact.durable_identity.provider,
              namespace: document.contact.durable_identity.namespace,
              number: document.contact.durable_identity.number,
            },
      } : {}),
      ...(document.review_note ? { taxPolicyBasis: document.review_note } : {}),
      ...(document.invoice_exchange_rate ? { invoiceRate: document.invoice_exchange_rate } : {}),
      ...(kind === "CREDIT_NOTE" ? {
        ...(submittedOriginalForCredit.has(index)
          ? { originalDocumentEventKey: documentEventKeys[submittedOriginalForCredit.get(index)!]! }
          : {}),
        originalDocumentReference: document.original_document!.reference,
        originalDocumentReferenceKind: document.original_document!.reference_kind,
        originalDocumentDate: document.original_document!.document_date,
        allocationStatus: "UNALLOCATED" as const,
      } : {}),
      // Tax is always computed by the provider from the per-line net and the
      // organisation's own rate for the declared TaxType.
      lineAmountType: "EXCLUSIVE" as const,
      lines: normalizedLines,
      declaredNet: document.declared_net,
      declaredTax: document.declared_tax,
      declaredGross: document.declared_gross,
      documentValidity: document.document_validity,
    };
  });
  const commercialDocumentFacts = (intake.commercial_documents ?? []).map((document, index) => {
    const unit = commercialDocumentUnits[index]!;
    const identity = commercialDocumentIdentity(intake.case_id, index, document);
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "COMMERCIAL_DOCUMENT" as const,
      documentKind: document.document_type,
      counterpartyRole: document.document_type === "QUOTE" ? "CUSTOMER" as const : "SUPPLIER" as const,
      reference: document.reference,
      documentDate: document.document_date,
      ...(document.document_type === "QUOTE"
        ? { expiryDate: document.expiry_date }
        : {
            ...(document.expected_arrival_date ? { expectedArrivalDate: document.expected_arrival_date } : {}),
            ...(document.delivery_date ? { deliveryDate: document.delivery_date } : {}),
          }),
      currency: document.currency,
      contactName: document.contact.name,
      ...(document.contact.durable_identity ? {
        contactDurableIdentity: document.contact.durable_identity.kind === "LEGAL_REGISTRY"
          ? {
              kind: "LEGAL_REGISTRY" as const,
              jurisdiction: document.contact.durable_identity.jurisdiction,
              registryScheme: document.contact.durable_identity.registry_scheme,
              number: document.contact.durable_identity.number,
            }
          : {
              kind: "PROVIDER_TENANT_ACCOUNT" as const,
              providerId: document.contact.durable_identity.provider,
              namespace: document.contact.durable_identity.namespace,
              number: document.contact.durable_identity.number,
            },
      } : {}),
      lineAmountType: document.line_amount_type,
      lines: document.lines.map((line, lineIndex) => ({
        lineId: derivedId("line", { ...identity, lineIndex, description: line.description }),
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.unit_amount,
        accountCode: line.account_code,
        taxType: line.tax_type,
      })),
      documentValidity: document.document_validity,
    };
  });
  const manualJournalFacts = (intake.manual_journals ?? []).map((journal, index) => {
    const unit = manualJournalUnits[index]!;
    const identity = manualJournalIdentity(intake.case_id, index, journal);
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "BALANCED_JOURNAL" as const,
      narration: journal.narration,
      date: journal.journal_date,
      lines: journal.lines.map((line, lineIndex) => ({
        lineId: derivedId("line", { ...identity, lineIndex, description: line.description }),
        description: line.description,
        accountCode: line.account_code,
        taxType: line.tax_type,
        ...(line.debit ? { debit: line.debit } : { credit: line.credit! }),
      })),
      documentValidity: journal.document_validity,
    };
  });
  const ledgerStateTransitionFacts = (intake.ledger_state_transitions ?? []).map((transition, index) => {
    const unit = ledgerStateTransitionUnits[index]!;
    const identity = ledgerStateTransitionIdentity(intake.case_id, index, transition);
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "LEDGER_STATE_TRANSITION" as const,
      actionId: transition.action,
      targetXeroObjectId: transition.action === "manual_journal.post"
        ? transition.manual_journal_id
        : transition.invoice_id,
    };
  });
  const ledgerAdjustmentFacts = (intake.ledger_adjustments ?? []).map((adjustment, index) => {
    const unit = ledgerAdjustmentUnits[index]!;
    const identity = ledgerAdjustmentIdentity(intake.case_id, index, adjustment);
    const payload = (() => {
      switch (adjustment.action) {
        case "customer_invoice.void":
          return { invoiceId: adjustment.invoice_id, invoiceType: "ACCREC" as const, expectedStatus: "AUTHORISED" as const };
        case "supplier_bill.void":
          return { invoiceId: adjustment.invoice_id, invoiceType: "ACCPAY" as const, expectedStatus: "AUTHORISED" as const };
        case "credit_note.authorise":
          return { creditNoteId: adjustment.credit_note_id, creditNoteType: adjustment.credit_note_type, expectedStatus: "DRAFT" as const };
        case "credit_note.allocate":
          return {
            creditNoteId: adjustment.credit_note_id,
            creditNoteType: adjustment.credit_note_type,
            targetInvoiceId: adjustment.target_invoice_id,
            targetInvoiceType: adjustment.target_invoice_type,
            amount: adjustment.amount,
            allocationDate: adjustment.allocation_date,
            expectedCreditStatus: "AUTHORISED" as const,
            expectedTargetStatus: "AUTHORISED" as const,
          };
        case "credit_note.refund":
          return {
            creditNoteId: adjustment.credit_note_id,
            creditNoteType: adjustment.credit_note_type,
            bankAccountId: adjustment.bank_account_id,
            amount: adjustment.amount,
            refundDate: adjustment.refund_date,
            expectedStatus: "AUTHORISED" as const,
          };
        case "credit_note.void":
          return { creditNoteId: adjustment.credit_note_id, creditNoteType: adjustment.credit_note_type, expectedStatus: "AUTHORISED" as const };
        case "credit_note.unallocate":
          return { creditNoteId: adjustment.credit_note_id, allocationId: adjustment.allocation_id, expectedStatus: "AUTHORISED" as const };
        case "manual_journal.void":
          return { manualJournalId: adjustment.manual_journal_id, expectedStatus: "POSTED" as const };
      }
    })();
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "LEDGER_ADJUSTMENT" as const,
      actionId: adjustment.action,
      payload,
    };
  });
  const paymentBankLedgerFacts = (intake.payment_bank_ledger ?? []).map((item, index) => {
    const unit = paymentBankLedgerUnits[index]!;
    const identity = paymentBankLedgerIdentity(intake.case_id, index, item);
    const payload = (() => {
      switch (item.action) {
        case "payment.create": return canonicalPaymentCreatePayload({ invoiceId: item.invoice_id, invoiceType: item.invoice_type,
          bankAccountId: item.bank_account_id, paymentDate: item.payment_date, amount: item.amount, ...(item.reference ? { reference: item.reference } : {}) });
        case "payment.reverse": return canonicalPaymentReversePayload({ paymentId: item.payment_id });
        case "bank_transaction.create": return canonicalBankTransactionCreatePayload({ type: item.type, contactId: item.contact_id,
          bankAccountId: item.bank_account_id, transactionDate: item.transaction_date, reference: item.reference,
          lineAmountType: item.line_amount_type, ...(item.currency_rate ? { currencyRate: item.currency_rate } : {}),
          lines: item.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitAmount: line.unit_amount,
            accountCode: line.account_code, taxType: line.tax_type, trackingOptionIds: line.tracking_option_ids })) });
        case "bank_transaction.update": return canonicalBankTransactionUpdatePayload({ bankTransactionId: item.bank_transaction_id,
          expectedUpdatedAt: item.expected_updated_at, type: item.type, contactId: item.contact_id, bankAccountId: item.bank_account_id,
          transactionDate: item.transaction_date, reference: item.reference, lineAmountType: item.line_amount_type,
          ...(item.currency_rate ? { currencyRate: item.currency_rate } : {}), lines: item.lines.map((line) => ({ description: line.description,
            quantity: line.quantity, unitAmount: line.unit_amount, accountCode: line.account_code,
            taxType: line.tax_type, trackingOptionIds: line.tracking_option_ids })) });
        case "bank_transaction.reverse": return canonicalBankTransactionReversePayload({ bankTransactionId: item.bank_transaction_id });
      }
    })();
    return { factId: derivedId("fact", identity), lineageKey: derivedId("lineage", identity), eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId], origin: "MODEL_EXTRACTED" as const, revision: 1, kind: "PAYMENT_BANK_LEDGER" as const,
      actionId: item.action, payload };
  });
  const draftDocumentUpdateFacts = (intake.draft_document_updates ?? []).map((update, index) => {
    const unit = draftDocumentUpdateUnits[index]!;
    const identity = draftDocumentUpdateIdentity(intake.case_id, index, update);
    const provenance = {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
    };
    const replacement = (() => {
      if (update.action === "manual_journal.update_draft") {
        const journal = update.replacement;
        return {
          ...provenance,
          kind: "BALANCED_JOURNAL" as const,
          narration: journal.narration,
          date: journal.journal_date,
          lines: journal.lines.map((line, lineIndex) => ({
            lineId: derivedId("line", { ...identity, lineIndex, description: line.description }),
            description: line.description,
            accountCode: line.account_code,
            taxType: line.tax_type,
            ...(line.debit ? { debit: line.debit } : { credit: line.credit! }),
          })),
          documentValidity: journal.document_validity,
        };
      }
      if (update.action === "quote.update_draft" || update.action === "purchase_order.update_draft") {
        const document = update.replacement;
        return {
          ...provenance,
          kind: "COMMERCIAL_DOCUMENT" as const,
          documentKind: document.document_type,
          counterpartyRole: document.document_type === "QUOTE" ? "CUSTOMER" as const : "SUPPLIER" as const,
          reference: document.reference,
          documentDate: document.document_date,
          ...(document.document_type === "QUOTE"
            ? { expiryDate: document.expiry_date }
            : {
                ...(document.expected_arrival_date ? { expectedArrivalDate: document.expected_arrival_date } : {}),
                ...(document.delivery_date ? { deliveryDate: document.delivery_date } : {}),
              }),
          currency: document.currency,
          contactName: document.contact.name,
          ...(document.contact.durable_identity ? {
            contactDurableIdentity: document.contact.durable_identity.kind === "LEGAL_REGISTRY"
              ? {
                  kind: "LEGAL_REGISTRY" as const,
                  jurisdiction: document.contact.durable_identity.jurisdiction,
                  registryScheme: document.contact.durable_identity.registry_scheme,
                  number: document.contact.durable_identity.number,
                }
              : {
                  kind: "PROVIDER_TENANT_ACCOUNT" as const,
                  providerId: document.contact.durable_identity.provider,
                  namespace: document.contact.durable_identity.namespace,
                  number: document.contact.durable_identity.number,
                },
          } : {}),
          lineAmountType: document.line_amount_type,
          lines: document.lines.map((line, lineIndex) => ({
            lineId: derivedId("line", { ...identity, lineIndex, description: line.description }),
            description: line.description,
            quantity: line.quantity,
            unitAmount: line.unit_amount,
            accountCode: line.account_code,
            taxType: line.tax_type,
          })),
          documentValidity: document.document_validity,
        };
      }
      const document = update.replacement;
      const kind = documentKind(document.document_type);
      return {
        ...provenance,
        kind: "NATIVE_DOCUMENT" as const,
        documentKind: kind,
        counterpartyRole: role(document.document_type),
        reference: document.reference,
        referenceKind: document.reference_kind,
        documentDate: document.document_date,
        ...(document.due_date ? { dueDate: document.due_date } : {}),
        currency: document.currency,
        contactName: document.contact.name,
        ...(document.contact.durable_identity ? {
          contactDurableIdentity: document.contact.durable_identity.kind === "LEGAL_REGISTRY"
            ? {
                kind: "LEGAL_REGISTRY" as const,
                jurisdiction: document.contact.durable_identity.jurisdiction,
                registryScheme: document.contact.durable_identity.registry_scheme,
                number: document.contact.durable_identity.number,
              }
            : {
                kind: "PROVIDER_TENANT_ACCOUNT" as const,
                providerId: document.contact.durable_identity.provider,
                namespace: document.contact.durable_identity.namespace,
                number: document.contact.durable_identity.number,
              },
        } : {}),
        ...(document.review_note ? { taxPolicyBasis: document.review_note } : {}),
        ...(document.invoice_exchange_rate ? { invoiceRate: document.invoice_exchange_rate } : {}),
        ...(kind === "CREDIT_NOTE" ? {
          originalDocumentReference: document.original_document!.reference,
          originalDocumentReferenceKind: document.original_document!.reference_kind,
          originalDocumentDate: document.original_document!.document_date,
          allocationStatus: "UNALLOCATED" as const,
        } : {}),
        lineAmountType: "EXCLUSIVE" as const,
        lines: document.lines.map((line, lineIndex) => ({
          lineId: derivedId("line", { ...identity, lineIndex, description: line.description }),
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unit_amount_excluding_tax,
          sourceTax: line.source_tax_amount,
          accountCode: line.account_code,
          taxType: line.tax_type,
        })),
        declaredNet: document.declared_net,
        declaredTax: document.declared_tax,
        declaredGross: document.declared_gross,
        documentValidity: document.document_validity,
      };
    })();
    return {
      ...provenance,
      kind: "DRAFT_DOCUMENT_UPDATE" as const,
      actionId: update.action,
      targetXeroObjectId: update.target_xero_object_id,
      expectedUpdatedAt: update.expected_updated_at,
      replacement,
    };
  });
  const contactBasicUpdateFacts = (intake.contact_basic_updates ?? []).map((update, index) => {
    const unit = contactBasicUpdateUnits[index]!;
    const identity = referenceDataIdentity(intake.case_id, "CONTACT_BASIC_UPDATE", index, update);
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "CONTACT_BASIC_UPDATE" as const,
      contactId: update.contact_id,
      patch: update.patch,
    };
  });
  const itemBasicCreateFacts = (intake.item_basic_creates ?? []).map((item, index) => {
    const unit = itemBasicCreateUnits[index]!;
    const identity = referenceDataIdentity(intake.case_id, "ITEM_BASIC_CREATE_UNTRACKED", index, item);
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "ITEM_BASIC_CREATE_UNTRACKED" as const,
      item,
    };
  });
  const itemBasicUpdateFacts = (intake.item_basic_updates ?? []).map((update, index) => {
    const unit = itemBasicUpdateUnits[index]!;
    const identity = referenceDataIdentity(intake.case_id, "ITEM_BASIC_UPDATE_UNTRACKED", index, update);
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "ITEM_BASIC_UPDATE_UNTRACKED" as const,
      itemId: update.item_id,
      patch: update.patch,
    };
  });
  const trackingReferenceDataFacts = (intake.tracking_reference_data ?? []).map((tracking, index) => {
    const unit = trackingReferenceDataUnits[index]!;
    const identity = referenceDataIdentity(intake.case_id, "TRACKING_REFERENCE_DATA", index, tracking);
    return {
      factId: derivedId("fact", identity),
      lineageKey: derivedId("lineage", identity),
      eventKey: derivedId("event", identity),
      sourceUnitIds: [unit.unitId],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "TRACKING_REFERENCE_DATA" as const,
      action: tracking.action,
      name: tracking.name,
      ...("tracking_category_id" in tracking ? { trackingCategoryId: tracking.tracking_category_id } : {}),
      ...("tracking_option_id" in tracking ? { trackingOptionId: tracking.tracking_option_id } : {}),
    };
  });
  return prepareAccountingCasePublicSchema.parse({
    case_id: intake.case_id,
    expected_version: intake.expected_version,
    ...(intake.continuation_token ? { continuation_token: intake.continuation_token } : {}),
    ...(intake.source_case ? { source_case: intake.source_case } : {}),
    sources: [...(documentUnits.length + commercialDocumentUnits.length + manualJournalUnits.length +
      ledgerStateTransitionUnits.length + ledgerAdjustmentUnits.length + paymentBankLedgerUnits.length + draftDocumentUpdateUnits.length +
      contactBasicUpdateUnits.length + itemBasicCreateUnits.length + itemBasicUpdateUnits.length +
      trackingReferenceDataUnits.length > 0 ? [{
      artifactId: documentArtifactId,
      label: intake.source_label,
      units: [
        ...documentUnits,
        ...commercialDocumentUnits,
        ...manualJournalUnits,
        ...ledgerStateTransitionUnits,
        ...ledgerAdjustmentUnits,
        ...paymentBankLedgerUnits,
        ...draftDocumentUpdateUnits,
        ...contactBasicUpdateUnits,
        ...itemBasicCreateUnits,
        ...itemBasicUpdateUnits,
        ...trackingReferenceDataUnits,
      ],
    }] : []), ...(contactUnits.length > 0 ? [{
      artifactId: contactArtifactId,
      label: intake.source_label,
      units: contactUnits,
    }] : [])],
    facts: [
      ...contactFacts,
      ...documentFacts,
      ...commercialDocumentFacts,
      ...manualJournalFacts,
      ...ledgerStateTransitionFacts,
      ...ledgerAdjustmentFacts,
      ...paymentBankLedgerFacts,
      ...draftDocumentUpdateFacts,
      ...contactBasicUpdateFacts,
      ...itemBasicCreateFacts,
      ...itemBasicUpdateFacts,
      ...trackingReferenceDataFacts,
    ],
  });
}
