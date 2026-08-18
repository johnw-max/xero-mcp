import { z } from "zod/v4";
import {
  prepareAccountingCasePublicSchema,
  type PrepareAccountingCasePublicInput,
} from "../domain/accountingCaseSchemas.js";
import { ACCOUNTING_DOCUMENT_REFERENCE_KINDS } from "../domain/accountingCase.js";
import { hashObject } from "../security/hash.js";
import {
  XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS,
  XERO_SINGAPORE_TAX_CLASS_KEYS,
} from "../policy/xeroSingaporeAccountingPolicy.js";

const publicId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:/-]+$/u);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");
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
const percentage = z.string().regex(/^(?:100(?:\.0{1,2})?|(?:0|[1-9]\d?)(?:\.\d{1,2})?)$/u);

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
    number: z.string().trim().min(1).max(128),
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

const defaultLineSchema = z.object({
  ...lineBaseShape,
}).strict().superRefine((line, context) => {
  if (scaledDecimal(line.quantity) <= 0n) {
    context.addIssue({ code: "custom", path: ["quantity"], message: "must be greater than zero" });
  }
});

const perLineSchema = z.object({
  ...lineBaseShape,
  accounting_category: z.enum(XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS).describe(
    "The policy category supported for this exact source line.",
  ),
  tax_class: z.enum(XERO_SINGAPORE_TAX_CLASS_KEYS).describe(
    "The tax class supported for this exact source line.",
  ),
  effective_tax_rate_percent: percentage.describe(
    "The source-supported effective tax percentage for this exact line.",
  ),
  exempt_classification: z.enum(["REGULATION_33", "NON_REGULATION_33"]).optional().describe(
    "Line-specific exemption evidence; valid only with a complete PER_LINE accounting override.",
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
  transition_review_required: z.boolean().describe(
    "Required source-review conclusion. Use true when GST transition facts are present or unresolved; use false only when the transaction has been reviewed as non-transitional. Never decide this from invoice date alone.",
  ),
  declared_net: positiveMoney,
  declared_tax: money,
  declared_gross: positiveMoney,
  document_validity: z.enum(["VALID_FOR_LIVE_BOOKS", "TEST_OR_NOT_VALID", "UNKNOWN"]),
  original_document: originalDocumentSchema.optional(),
} as const;

const defaultAccountingDocumentSchema = z.object({
  ...documentBaseShape,
  line_accounting_mode: z.literal("DOCUMENT_DEFAULT_FOR_ALL_LINES"),
  accounting_category: z.enum(XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS).describe(
    `Explicit document line default. Used only in DOCUMENT_DEFAULT_FOR_ALL_LINES mode: ${XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS.join(", ")}.`,
  ),
  tax_class: z.enum(XERO_SINGAPORE_TAX_CLASS_KEYS).describe(
    `Explicit document line default. Used only in DOCUMENT_DEFAULT_FOR_ALL_LINES mode: ${XERO_SINGAPORE_TAX_CLASS_KEYS.join(", ")}.`,
  ),
  effective_tax_rate_percent: percentage.describe(
    "Explicit document line default effective tax percentage. Used only in DOCUMENT_DEFAULT_FOR_ALL_LINES mode.",
  ),
  exempt_classification: z.enum(["REGULATION_33", "NON_REGULATION_33"]).optional(),
  lines: z.array(defaultLineSchema).min(1).max(100),
}).strict();

const perLineAccountingDocumentSchema = z.object({
  ...documentBaseShape,
  line_accounting_mode: z.literal("PER_LINE"),
  lines: z.array(perLineSchema).min(1).max(100),
}).strict();

const documentSchema = z.discriminatedUnion("line_accounting_mode", [
  defaultAccountingDocumentSchema,
  perLineAccountingDocumentSchema,
]).superRefine((document, context) => {
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
  if (document.line_accounting_mode === "DOCUMENT_DEFAULT_FOR_ALL_LINES" &&
      document.tax_class === "EXEMPT" && document.document_type.startsWith("CUSTOMER_") &&
      !document.exempt_classification) {
    context.addIssue({
      code: "custom",
      path: ["exempt_classification"],
      message: "customer exempt documents require a Regulation 33 classification",
    });
  }
  if (document.line_accounting_mode === "DOCUMENT_DEFAULT_FOR_ALL_LINES" &&
      document.tax_class !== "EXEMPT" && document.exempt_classification) {
    context.addIssue({ code: "custom", path: ["exempt_classification"], message: "only exempt tax accepts this field" });
  }
  if (document.line_accounting_mode === "PER_LINE") {
    for (const [index, line] of document.lines.entries()) {
      if (
        line.tax_class === "EXEMPT" && document.document_type.startsWith("CUSTOMER_") &&
        !line.exempt_classification
      ) {
        context.addIssue({
          code: "custom",
          path: ["lines", index, "exempt_classification"],
          message: "customer exempt lines require a Regulation 33 classification",
        });
      }
      if (line.tax_class !== "EXEMPT" && line.exempt_classification) {
        context.addIssue({
          code: "custom",
          path: ["lines", index, "exempt_classification"],
          message: "only exempt lines accept this field",
        });
      }
    }
  }
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

/**
 * Agent-facing prepare contract. It expresses ordinary business documents and
 * deliberately excludes tenant IDs, provider IDs, action IDs, account codes,
 * tax type IDs, canonical payloads, receipts and mutation identities.
 */
export const xeroAccountingCaseBusinessIntakeSchema = z.object({
  case_id: publicId.describe("Agent-chosen stable Case identity; it is not a provider or tenant ID."),
  expected_version: z.number().int().min(0).describe("Use 0 when creating the first Case version."),
  continuation_token: z.string().regex(/^(?:acc|acr)_[0-9a-f]{64}$/u).optional().describe(
    "Opaque server-issued continuation token. Never construct or modify it.",
  ),
  source_label: z.string().trim().min(1).max(256),
  source_set_complete: z.literal(true).describe(
    "True only when this submitted Case's bounded source set is complete. It never asserts the whole business, ledger, period, or real-world document population is complete.",
  ),
  documents: z.array(documentSchema).max(256),
  new_contacts: z.array(newContactSchema).max(100).optional().describe(
    "Omit for known existing counterparties. Include only genuinely new contacts that this exact submitted Case must create; the server resolves existing identities and same-Case dependencies.",
  ),
}).strict().superRefine((intake, context) => {
  if (intake.documents.length === 0 && (intake.new_contacts?.length ?? 0) === 0) {
    context.addIssue({
      code: "custom",
      path: ["documents"],
      message: "must include at least one business document or genuinely new contact",
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
    const derivedRoles = intake.documents.flatMap((document) =>
      samePublicContactIdentity(first.contact, document.contact) ? [role(document.document_type)] : []);
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

function role(documentType: typeof XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES[number]): "CUSTOMER" | "SUPPLIER" {
  return documentType.startsWith("CUSTOMER_") ? "CUSTOMER" : "SUPPLIER";
}

function documentKind(
  documentType: typeof XERO_ACCOUNTING_CASE_BUSINESS_DOCUMENT_TYPES[number],
): "INVOICE" | "CREDIT_NOTE" {
  return documentType.endsWith("CREDIT_NOTE") ? "CREDIT_NOTE" : "INVOICE";
}

function percentageToBasisPoints(value: string): number {
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
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
    const documentAccountingSummary = document.line_accounting_mode === "PER_LINE"
      ? (() => {
          const firstLine = document.lines[0]!;
          return {
          accountingCategory: firstLine.accounting_category,
          taxClass: firstLine.tax_class,
          ...(firstLine.exempt_classification
            ? { exemptClassification: firstLine.exempt_classification }
            : {}),
          effectiveTaxRateBps: percentageToBasisPoints(firstLine.effective_tax_rate_percent),
          };
        })()
      : {
          accountingCategory: document.accounting_category,
          taxClass: document.tax_class,
          ...(document.exempt_classification
            ? { exemptClassification: document.exempt_classification }
            : {}),
          effectiveTaxRateBps: percentageToBasisPoints(document.effective_tax_rate_percent),
        };
    const normalizedLines = document.line_accounting_mode === "PER_LINE"
      ? document.lines.map((line, lineIndex) => ({
          lineId: derivedId("line", { ...identity, lineIndex, description: line.description }),
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unit_amount_excluding_tax,
          sourceTax: line.source_tax_amount,
          accountingCategory: line.accounting_category,
          taxClass: line.tax_class,
          ...(line.exempt_classification ? { exemptClassification: line.exempt_classification } : {}),
          effectiveTaxRateBps: percentageToBasisPoints(line.effective_tax_rate_percent),
        }))
      : document.lines.map((line, lineIndex) => ({
          lineId: derivedId("line", { ...identity, lineIndex, description: line.description }),
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unit_amount_excluding_tax,
          sourceTax: line.source_tax_amount,
          accountingCategory: document.accounting_category,
          taxClass: document.tax_class,
          ...(document.exempt_classification ? { exemptClassification: document.exempt_classification } : {}),
          effectiveTaxRateBps: percentageToBasisPoints(document.effective_tax_rate_percent),
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
      ...documentAccountingSummary,
      taxPolicyBasis: document.transition_review_required
        ? "TRANSITION_REVIEW_REQUIRED"
        : kind === "CREDIT_NOTE" ? "ORIGINAL_TRANSACTION" : "DOCUMENT_DATE_NON_TRANSITION",
      lineAccountingMode: document.line_accounting_mode,
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
      lineAmountType: normalizedLines.every((line) => line.taxClass === "NO_TAX")
        ? "NO_TAX" as const
        : "EXCLUSIVE" as const,
      lines: normalizedLines,
      declaredNet: document.declared_net,
      declaredTax: document.declared_tax,
      declaredGross: document.declared_gross,
      documentValidity: document.document_validity,
    };
  });
  return prepareAccountingCasePublicSchema.parse({
    case_id: intake.case_id,
    expected_version: intake.expected_version,
    ...(intake.continuation_token ? { continuation_token: intake.continuation_token } : {}),
    sources: [...(documentUnits.length > 0 ? [{
      artifactId: documentArtifactId,
      label: intake.source_label,
      units: documentUnits,
    }] : []), ...(contactUnits.length > 0 ? [{
      artifactId: contactArtifactId,
      label: intake.source_label,
      units: contactUnits,
    }] : [])],
    facts: [...contactFacts, ...documentFacts],
  });
}
