import {
  originalTransactionEvidenceHash,
  type NativeDocumentFact,
  type OriginalTransactionEvidenceFact,
  type OriginalTransactionEvidenceLine,
} from "../domain/accountingCase.js";
import {
  formatAccountingFixedFour,
  parseAccountingFixedDecimal,
  quantizeAccountingLineNet,
  quantizeAccountingLineTax,
  type SupportedAccountingMonetaryRule,
} from "../control-kernel/accountingMonetary.js";
import type { InvoiceSnapshot } from "../providers/types.js";
import { hashObject } from "../security/hash.js";
import {
  XERO_ORIGINAL_TRANSACTION_BINDING_VERSION,
  xeroTaxSemanticsForTaxType,
  type XeroOriginalTransactionBinding,
} from "./xeroAccountingCaseProviderContract.js";
import type { AccountingPolicyEnforcementContract } from "../control-kernel/accountingPolicyEnforcementContract.js";
import type { XeroTenantCoaProfileBinding } from "./xeroTenantCoaProfile.js";

export class XeroOriginalTransactionEvidenceError extends Error {
  constructor(readonly reasonCodes: readonly string[]) {
    super("The exact Xero original transaction is not safe credit evidence.");
    this.name = "XeroOriginalTransactionEvidenceError";
  }
}

export function normalizeOriginalTransactionReference(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
}

function fail(...reasonCodes: string[]): never {
  throw new XeroOriginalTransactionEvidenceError(Object.freeze([...new Set(reasonCodes)].sort()));
}

function fixed(value: unknown, reasonCode: string): string {
  if (typeof value !== "string") fail(reasonCode);
  try {
    const parsed = parseAccountingFixedDecimal(value);
    if (parsed < 0n) fail(reasonCode);
    return formatAccountingFixedFour(parsed);
  } catch {
    return fail(reasonCode);
  }
}

function normalizedLineAmountType(value: unknown): "EXCLUSIVE" | "NO_TAX" {
  if (typeof value !== "string") fail("ORIGINAL_LINE_AMOUNT_TYPE_MISSING");
  const normalized = value.replace(/[^A-Za-z]/gu, "").toLocaleUpperCase("en");
  if (normalized === "EXCLUSIVE") return "EXCLUSIVE";
  if (normalized === "NOTAX") return "NO_TAX";
  return fail("ORIGINAL_LINE_AMOUNT_TYPE_UNSUPPORTED");
}

function exactProviderSemanticProjection(snapshot: InvoiceSnapshot): Readonly<Record<string, unknown>> {
  return Object.freeze({
    tenantId: snapshot.tenantId,
    invoiceId: snapshot.invoiceId,
    type: snapshot.type,
    status: snapshot.status,
    contactId: snapshot.contact.contactId,
    invoiceNumber: snapshot.invoiceNumber ?? null,
    reference: snapshot.reference ?? null,
    invoiceDate: snapshot.invoiceDate ?? null,
    currency: snapshot.currency ?? null,
    lineAmountType: snapshot.lineAmountType ?? null,
    subTotal: snapshot.subTotal ?? null,
    totalTax: snapshot.totalTax ?? null,
    total: snapshot.total ?? null,
    // Bound as drift evidence only. It is never treated as remaining-credit
    // authority and this flow creates an UNALLOCATED DRAFT credit note.
    amountDue: snapshot.amountDue ?? null,
    amountPaid: snapshot.amountPaid ?? null,
    amountCredited: snapshot.amountCredited ?? null,
    lineItemCount: snapshot.lineItemCount ?? null,
    linesTruncated: snapshot.linesTruncated ?? null,
    lines: snapshot.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      lineAmount: line.lineAmount ?? null,
      taxAmount: line.taxAmount ?? null,
      accountId: line.accountId ?? null,
      accountCode: line.accountCode,
      taxType: line.taxType,
    })),
  });
}

export function xeroOriginalTransactionProviderSnapshotSealHash(snapshot: InvoiceSnapshot): string {
  return hashObject(exactProviderSemanticProjection(snapshot));
}

export function createXeroOriginalTransactionEvidence(input: {
  credit: NativeDocumentFact;
  snapshot: InvoiceSnapshot;
  expectedTenantId: string;
  expectedContactId: string;
  checkedObjectCount: number;
  tenantCoaProfile: XeroTenantCoaProfileBinding;
  monetaryRule: SupportedAccountingMonetaryRule;
  accountingPolicy: AccountingPolicyEnforcementContract;
}): Readonly<{
  evidence: OriginalTransactionEvidenceFact;
  binding: XeroOriginalTransactionBinding;
}> {
  const { credit, snapshot } = input;
  if (credit.documentKind !== "CREDIT_NOTE") fail("CREDIT_DOCUMENT_REQUIRED");
  if (!credit.originalDocumentReference || !credit.originalDocumentReferenceKind || !credit.originalDocumentDate) {
    fail("ORIGINAL_TRANSACTION_COORDINATE_INCOMPLETE");
  }
  if (credit.originalDocumentReferenceKind !== "FORMAL_DOCUMENT_NUMBER") {
    fail("ORIGINAL_TRANSACTION_REFERENCE_KIND_UNSUPPORTED");
  }
  const originalRoute = credit.counterpartyRole === "CUSTOMER" ? "SALES_INVOICE" : "SUPPLIER_BILL";
  const authoritativeProviderField = "INVOICE_NUMBER" as const;
  const providerReference = snapshot.invoiceNumber;
  const expectedType = originalRoute === "SALES_INVOICE" ? "ACCREC" : "ACCPAY";
  const reasons: string[] = [];
  if (snapshot.tenantId !== input.expectedTenantId) reasons.push("ORIGINAL_TENANT_MISMATCH");
  if (snapshot.type !== expectedType) reasons.push("ORIGINAL_ROUTE_TYPE_MISMATCH");
  if (snapshot.status !== "AUTHORISED" && snapshot.status !== "PAID") {
    reasons.push("ORIGINAL_NOT_CREDITABLE_POSTED_TRANSACTION");
  }
  if (snapshot.contact.contactId.toLowerCase() !== input.expectedContactId.toLowerCase()) {
    reasons.push("ORIGINAL_CONTACT_MISMATCH");
  }
  if (!providerReference ||
      normalizeOriginalTransactionReference(providerReference) !==
        normalizeOriginalTransactionReference(credit.originalDocumentReference)) {
    reasons.push("ORIGINAL_REFERENCE_MISMATCH");
  }
  if (snapshot.invoiceDate !== credit.originalDocumentDate) reasons.push("ORIGINAL_DOCUMENT_DATE_MISMATCH");
  if (snapshot.currency !== credit.currency) reasons.push("ORIGINAL_CURRENCY_MISMATCH");
  if (snapshot.linesTruncated !== false || snapshot.lineItemCount !== snapshot.lines.length) {
    reasons.push("ORIGINAL_LINES_INCOMPLETE");
  }
  if (snapshot.lines.length < 1 || snapshot.lines.length > 100) reasons.push("ORIGINAL_LINE_COUNT_INVALID");
  if (reasons.length > 0) fail(...reasons);

  const lineAmountType = normalizedLineAmountType(snapshot.lineAmountType);
  const policyProjection = input.accountingPolicy.planProjection;
  const rawPeriods = Array.isArray(policyProjection.periods) ? policyProjection.periods : [];
  const periods = rawPeriods.flatMap((value) =>
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).policyPeriodId === "string" &&
    typeof (value as Record<string, unknown>).startsOn === "string" &&
    typeof (value as Record<string, unknown>).endsOn === "string" &&
    typeof (value as Record<string, unknown>).rateBps === "number"
      ? [value as { policyPeriodId: string; startsOn: string; endsOn: string; rateBps: number }]
      : []);
  const originalPeriod = periods.filter((period) =>
    credit.originalDocumentDate! >= period.startsOn && credit.originalDocumentDate! <= period.endsOn);
  if (originalPeriod.length !== 1) fail("ORIGINAL_TAX_POLICY_PERIOD_UNSUPPORTED");
  const categoryEntries = Object.entries(input.tenantCoaProfile.categories);
  const lines: OriginalTransactionEvidenceLine[] = snapshot.lines.map((line, index) => {
    const accountMatches = categoryEntries.filter(([, category]) =>
      category.accountId === line.accountId && category.accountCode === line.accountCode);
    if (accountMatches.length !== 1) fail("ORIGINAL_ACCOUNT_SEMANTIC_BINDING_MISMATCH");
    const accountingCategory = accountMatches[0]![0];
    const taxSemantics = xeroTaxSemanticsForTaxType(line.taxType, originalRoute);
    if (!taxSemantics) fail("ORIGINAL_TAX_SEMANTIC_BINDING_MISMATCH");
    const taxClass = taxSemantics.startsWith("STANDARD_")
      ? "SG_STANDARD_RATED"
      : taxSemantics === "NO_TAX"
        ? "NO_TAX"
        : taxSemantics.startsWith("ZERO_RATED_")
          ? "ZERO_RATED"
          : taxSemantics.startsWith("OUT_OF_SCOPE_")
            ? "OUT_OF_SCOPE"
            : taxSemantics.startsWith("EXEMPT_")
              ? "EXEMPT"
              : fail("ORIGINAL_TAX_CLASS_UNRESOLVED");
    const effectiveTaxRateBps = taxClass === "SG_STANDARD_RATED" ? originalPeriod[0]!.rateBps : 0;
    const quantity = fixed(line.quantity, "ORIGINAL_LINE_QUANTITY_INVALID");
    const unitAmount = fixed(line.unitAmount, "ORIGINAL_LINE_UNIT_AMOUNT_INVALID");
    const expectedNet = formatAccountingFixedFour(quantizeAccountingLineNet(
      parseAccountingFixedDecimal(quantity),
      parseAccountingFixedDecimal(unitAmount),
      input.monetaryRule,
    ));
    const net = fixed(line.lineAmount, "ORIGINAL_LINE_NET_MISSING_OR_INVALID");
    const tax = fixed(line.taxAmount, "ORIGINAL_LINE_TAX_MISSING_OR_INVALID");
    if (net !== expectedNet) fail("ORIGINAL_LINE_NET_MISMATCH");
    const expectedTax = formatAccountingFixedFour(quantizeAccountingLineTax(
      parseAccountingFixedDecimal(net),
      effectiveTaxRateBps,
      input.monetaryRule,
    ));
    if (tax !== expectedTax) fail("ORIGINAL_LINE_TAX_MISMATCH");
    if (lineAmountType === "NO_TAX" && (tax !== "0.0000" || taxSemantics !== "NO_TAX")) {
      fail("ORIGINAL_NO_TAX_LINE_MISMATCH");
    }
    const semanticProjection = {
      index,
      description: line.description,
      quantity,
      unitAmount,
      net,
      tax,
      accountingCategory,
      taxClass,
      effectiveTaxRateBps,
      taxSemantics,
      taxPolicyPeriodId: originalPeriod[0]!.policyPeriodId,
    };
    return Object.freeze({
      evidenceLineKey: `original-line-${hashObject(semanticProjection).slice(0, 32)}`,
      description: line.description,
      quantity,
      unitAmount,
      net,
      tax,
      accountingCategory,
      taxClass,
      effectiveTaxRateBps,
      taxSemantics,
      taxPolicyPeriodId: originalPeriod[0]!.policyPeriodId,
    });
  });
  if (new Set(lines.map((line) => line.evidenceLineKey)).size !== lines.length) {
    fail("ORIGINAL_EVIDENCE_LINE_KEY_COLLISION");
  }
  const net = fixed(snapshot.subTotal, "ORIGINAL_SUBTOTAL_MISSING_OR_INVALID");
  const tax = fixed(snapshot.totalTax, "ORIGINAL_TOTAL_TAX_MISSING_OR_INVALID");
  const gross = fixed(snapshot.total, "ORIGINAL_TOTAL_MISSING_OR_INVALID");
  const lineNet = lines.reduce((sum, line) => sum + parseAccountingFixedDecimal(line.net), 0n);
  const lineTax = lines.reduce((sum, line) => sum + parseAccountingFixedDecimal(line.tax), 0n);
  if (
    lineNet !== parseAccountingFixedDecimal(net) ||
    lineTax !== parseAccountingFixedDecimal(tax) ||
    lineNet + lineTax !== parseAccountingFixedDecimal(gross)
  ) fail("ORIGINAL_DOCUMENT_TOTALS_MISMATCH");

  const sourceSnapshotSealHash = xeroOriginalTransactionProviderSnapshotSealHash(snapshot);
  const withoutHash: Omit<OriginalTransactionEvidenceFact, "evidenceHash"> = {
    factId: `original-evidence-${hashObject({ creditFactId: credit.factId, sourceSnapshotSealHash }).slice(0, 32)}`,
    lineageKey: `original-evidence-${hashObject({ creditLineageKey: credit.lineageKey }).slice(0, 32)}`,
    eventKey: `original-evidence-${hashObject({ creditEventKey: credit.eventKey }).slice(0, 32)}`,
    sourceUnitIds: [...credit.sourceUnitIds],
    origin: "SERVER_RESOLVED_PROVIDER_EVIDENCE",
    revision: 1,
    kind: "ORIGINAL_TRANSACTION_EVIDENCE",
    creditEventKey: credit.eventKey,
    originalRoute,
    authoritativeProviderField,
    reference: normalizeOriginalTransactionReference(credit.originalDocumentReference),
    referenceKind: credit.originalDocumentReferenceKind,
    documentDate: credit.originalDocumentDate,
    currency: credit.currency,
    contactName: credit.contactName,
    ...(credit.contactDurableIdentity ? { contactDurableIdentity: credit.contactDurableIdentity } : {}),
    creditEligibility: "CREDITABLE_POSTED_TRANSACTION",
    lineAmountType,
    lines,
    net,
    tax,
    gross,
    sourceSnapshotSealHash,
  };
  const evidence: OriginalTransactionEvidenceFact = Object.freeze({
    ...withoutHash,
    evidenceHash: originalTransactionEvidenceHash(withoutHash),
  });
  const lookupReceiptHash = hashObject({
    schemaVersion: XERO_ORIGINAL_TRANSACTION_BINDING_VERSION,
    evidenceHash: evidence.evidenceHash,
    providerObjectId: snapshot.invoiceId,
    originalRoute,
    sourceSnapshotSealHash,
    checkedObjectCount: input.checkedObjectCount,
  });
  const binding: XeroOriginalTransactionBinding = Object.freeze({
    schemaVersion: XERO_ORIGINAL_TRANSACTION_BINDING_VERSION,
    evidenceHash: evidence.evidenceHash,
    providerObjectId: snapshot.invoiceId,
    originalRoute,
    sourceSnapshotSealHash,
    lookupReceiptHash,
    checkedObjectCount: input.checkedObjectCount,
  });
  return Object.freeze({ evidence, binding });
}
