import type { AccountingCaseProviderBusinessHistoryLookup } from "../control-kernel/accountingCaseProviderContract.js";
import type { AccountingCaseOperation, CommercialDocumentRoute, NativeDocumentRoute } from "../domain/accountingCase.js";
import { hashObject, stableStringify } from "../security/hash.js";
import {
  XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION,
  xeroDocumentCoordinateAuthority,
  type XeroAuthoritativeDocumentProviderField,
} from "./xeroBusinessCoordinateAuthority.js";

export const XERO_ACCOUNTING_CASE_EXISTING_DOCUMENT_EVIDENCE_VERSION =
  "xero-accounting-case-existing-document-evidence:v1" as const;

type ExactProviderHistory = Extract<
  AccountingCaseProviderBusinessHistoryLookup,
  { state: "EXACT_ONE" }
>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}

function normalizedReference(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
}

function normalizedLineAmountType(value: string): string {
  return value.replace(/[^A-Za-z]/gu, "").toLocaleUpperCase("en");
}

function expectedProviderType(route: NativeDocumentRoute): string {
  return route === "SALES_INVOICE"
    ? "ACCREC"
    : route === "SUPPLIER_BILL"
      ? "ACCPAY"
      : route === "CUSTOMER_CREDIT"
        ? "ACCRECCREDIT"
        : "ACCPAYCREDIT";
}

function expectedAction(route: NativeDocumentRoute): AccountingCaseOperation["actionId"] {
  return route === "SALES_INVOICE"
    ? "customer_invoice.create_draft"
    : route === "SUPPLIER_BILL"
      ? "supplier_bill.create_draft"
      : "credit_note.create_draft";
}

function providerObjectId(route: NativeDocumentRoute, snapshot: Record<string, unknown>): string | undefined {
  return route === "SALES_INVOICE" || route === "SUPPLIER_BILL"
    ? nonEmptyString(snapshot.invoiceId)
    : nonEmptyString(snapshot.creditNoteId);
}

function providerDocumentDate(route: NativeDocumentRoute, snapshot: Record<string, unknown>): string | undefined {
  return route === "SALES_INVOICE" || route === "SUPPLIER_BILL"
    ? nonEmptyString(snapshot.invoiceDate)
    : nonEmptyString(snapshot.creditNoteDate);
}

function providerReference(
  snapshot: Record<string, unknown>,
  field: XeroAuthoritativeDocumentProviderField,
): string | undefined {
  return nonEmptyString(snapshot[field === "INVOICE_NUMBER"
    ? "invoiceNumber"
    : field === "CREDIT_NOTE_NUMBER"
      ? "creditNoteNumber"
      : "reference"]);
}

/**
 * Re-derive the exact provider-document decision from durable evidence.  This
 * deliberately does not trust a caller-supplied `canonicalEconomicMatch`
 * boolean: repositories use these reasons before persisting a no-write state.
 */
function isCommercialDocumentRoute(
  route: AccountingCaseOperation["nativeRoute"],
): route is CommercialDocumentRoute {
  return route === "QUOTE" || route === "PURCHASE_ORDER";
}

export function xeroExistingDocumentMismatchReasons(
  operation: AccountingCaseOperation,
  rawSnapshot: unknown,
  expectedObjectId?: string,
): string[] {
  if (operation.nativeRoute === "CONTACT_CREATE") return ["NATIVE_DOCUMENT_ROUTE_REQUIRED"];
  // Quotes/purchase orders are not ledger events (see CommercialDocumentRoute
  // in accountingCase.ts) and have no pre-write existing-document check at
  // all -- xeroBusinessCoordinateHistory only knows how to list/get invoices
  // and credit notes. Said explicitly rather than left to fall through
  // expectedProviderType()/expectedAction() below, which are typed to
  // NativeDocumentRoute and would not accept this value anyway.
  if (isCommercialDocumentRoute(operation.nativeRoute)) {
    return ["EXISTING_DOCUMENT_CHECK_UNAVAILABLE_FOR_ROUTE"];
  }
  const route = operation.nativeRoute;
  const payload = operation.canonicalPayload;
  const snapshot = record(rawSnapshot);
  if (!snapshot) return ["EXACT_READBACK_INVALID"];
  const reasons: string[] = [];
  if (operation.actionId !== expectedAction(route)) reasons.push("ACTION_ROUTE_MISMATCH");
  if (operation.canonicalPayloadHash !== hashObject(payload)) reasons.push("CANONICAL_PAYLOAD_HASH_MISMATCH");

  const actualObjectId = providerObjectId(route, snapshot);
  if (!actualObjectId) reasons.push("PROVIDER_OBJECT_ID_MISSING");
  if (expectedObjectId && actualObjectId?.toLowerCase() !== expectedObjectId.toLowerCase()) {
    reasons.push("PROVIDER_OBJECT_ID_MISMATCH");
  }
  if (snapshot.tenantId !== operation.target.tenantId) reasons.push("TENANT_ID_MISMATCH");
  if (snapshot.type !== expectedProviderType(route)) reasons.push("ROUTE_TYPE_MISMATCH");
  if (!nonEmptyString(snapshot.status)) reasons.push("PROVIDER_STATUS_MISSING");

  const expectedReference = nonEmptyString(payload.reference);
  const referenceKind = nonEmptyString(payload.referenceKind);
  const payloadProviderField = nonEmptyString(payload.authoritativeProviderField);
  const payloadUniquenessAuthority = nonEmptyString(payload.uniquenessAuthority);
  const expectedContactId = nonEmptyString(payload.xeroContactId);
  const expectedDate = nonEmptyString(payload.documentDate);
  const expectedCurrency = nonEmptyString(payload.currency);
  const coordinate = operation.businessReservation.canonicalFields;
  const contact = record(snapshot.contact);
  const actualContactId = nonEmptyString(contact?.contactId);
  const expectedAuthority = referenceKind === "FORMAL_DOCUMENT_NUMBER" ||
      referenceKind === "GENERIC_RECURRING_REFERENCE"
    ? xeroDocumentCoordinateAuthority(route, referenceKind)
    : undefined;
  const actualReference = expectedAuthority
    ? providerReference(snapshot, expectedAuthority.authoritativeProviderField)
    : undefined;
  const expectedCoordinateContact = expectedAuthority?.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER"
    ? expectedContactId
    : undefined;
  if (
    !expectedAuthority ||
    payloadProviderField !== expectedAuthority.authoritativeProviderField ||
    payloadUniquenessAuthority !== expectedAuthority.uniquenessAuthority ||
    coordinate.referenceKind !== referenceKind ||
    coordinate.authoritativeProviderField !== expectedAuthority.authoritativeProviderField ||
    coordinate.uniquenessAuthority !== expectedAuthority.uniquenessAuthority ||
    coordinate.normalizationVersion !== XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION ||
    coordinate.route !== route ||
    coordinate.contactId !== expectedCoordinateContact ||
    typeof coordinate.reference !== "string" ||
    !expectedReference ||
    coordinate.reference !== normalizedReference(expectedReference)
  ) reasons.push("BUSINESS_COORDINATE_PROJECTION_MISMATCH");
  if (!expectedContactId || actualContactId?.toLowerCase() !== expectedContactId.toLowerCase()) {
    reasons.push("CONTACT_ID_MISMATCH");
  }
  if (!expectedReference || !actualReference ||
      normalizedReference(actualReference) !== normalizedReference(expectedReference)) {
    reasons.push("AUTHORITATIVE_PROVIDER_FIELD_NOT_EXACT");
  }
  if (providerDocumentDate(route, snapshot) !== expectedDate) reasons.push("DOCUMENT_DATE_MISMATCH");
  if (snapshot.currency !== expectedCurrency) reasons.push("CURRENCY_MISMATCH");
  if ((route === "SALES_INVOICE" || route === "SUPPLIER_BILL") &&
      snapshot.dueDate !== payload.dueDate) reasons.push("DUE_DATE_MISMATCH");
  if (payload.invoiceRate !== undefined && snapshot.currencyRate !== payload.invoiceRate) {
    reasons.push("CURRENCY_RATE_MISMATCH");
  }
  if (snapshot.subTotal !== payload.net) reasons.push("SUBTOTAL_MISMATCH");
  if (snapshot.totalTax !== payload.tax) reasons.push("TOTAL_TAX_MISMATCH");
  if (snapshot.total !== payload.gross) reasons.push("TOTAL_MISMATCH");
  const expectedLineAmountType = nonEmptyString(payload.lineAmountType);
  const actualLineAmountType = nonEmptyString(snapshot.lineAmountType);
  if (!expectedLineAmountType || !actualLineAmountType ||
      normalizedLineAmountType(actualLineAmountType) !== normalizedLineAmountType(expectedLineAmountType)) {
    reasons.push("LINE_AMOUNT_TYPE_MISMATCH");
  }

  const expectedLines = Array.isArray(payload.lines) ? payload.lines.map(record) : [];
  const actualLines = Array.isArray(snapshot.lines) ? snapshot.lines.map(record) : [];
  if (!Array.isArray(payload.lines) || expectedLines.some((line) => line === undefined)) {
    reasons.push("SEALED_LINES_INVALID");
  }
  if (!Array.isArray(snapshot.lines) || actualLines.some((line) => line === undefined) ||
      snapshot.linesTruncated !== false || snapshot.lineItemCount !== actualLines.length) {
    reasons.push("PROVIDER_LINES_INCOMPLETE");
  }
  if (actualLines.length !== expectedLines.length) reasons.push("LINE_COUNT_MISMATCH");
  for (let index = 0; index < Math.max(actualLines.length, expectedLines.length); index += 1) {
    const expected = expectedLines[index];
    const actual = actualLines[index];
    if (!expected || !actual) continue;
    const fields: Array<[string, unknown, unknown]> = [
      ["DESCRIPTION", expected.description, actual.description],
      ["QUANTITY", expected.quantity, actual.quantity],
      ["UNIT_AMOUNT", expected.unitAmount, actual.unitAmount],
      ["LINE_AMOUNT", expected.net, actual.lineAmount],
      ["LINE_TAX", expected.tax, actual.taxAmount],
      ["ACCOUNT_ID", expected.accountId, actual.accountId],
      ["ACCOUNT_CODE", expected.accountCode, actual.accountCode],
      ["TAX_TYPE", expected.taxType, actual.taxType],
    ];
    for (const [field, expectedValue, actualValue] of fields) {
      if (expectedValue !== actualValue) reasons.push(`LINE_${index + 1}_${field}_MISMATCH`);
    }
  }
  return [...new Set(reasons)].sort();
}

export function createXeroExistingDocumentNoWriteEvidence(
  operation: AccountingCaseOperation,
  history: ExactProviderHistory,
): Record<string, unknown> {
  if (
    operation.nativeRoute === "CONTACT_CREATE" ||
    history.complete !== true ||
    history.canonicalEconomicMatch !== true ||
    history.mismatchReasons.length !== 0 ||
    !Number.isSafeInteger(history.checkedObjectCount) ||
    history.checkedObjectCount < 1 ||
    xeroExistingDocumentMismatchReasons(
      operation,
      history.exactReadback,
      history.providerObjectId,
    ).length !== 0
  ) {
    throw new Error("Cannot seal invalid exact existing-document provider history evidence");
  }
  return {
    schemaVersion: XERO_ACCOUNTING_CASE_EXISTING_DOCUMENT_EVIDENCE_VERSION,
    decision: "NO_WRITE_REQUIRED_EXISTING",
    actionId: operation.actionId,
    nativeRoute: operation.nativeRoute,
    operationCanonicalPayloadHash: operation.canonicalPayloadHash,
    businessReservation: structuredClone(operation.businessReservation),
    providerHistory: {
      state: history.state,
      complete: history.complete,
      checkedObjectCount: history.checkedObjectCount,
      canonicalEconomicMatch: history.canonicalEconomicMatch,
      mismatchReasons: [...history.mismatchReasons],
    },
    providerObjectId: history.providerObjectId,
    exactReadback: structuredClone(history.exactReadback),
  };
}

export function xeroExistingDocumentNoWriteEvidenceMatches(
  operation: AccountingCaseOperation,
  xeroObjectId: string,
  rawEvidence: Record<string, unknown>,
): boolean {
  if (operation.nativeRoute === "CONTACT_CREATE") return false;
  const history = record(rawEvidence.providerHistory);
  const exactReadback = record(rawEvidence.exactReadback);
  if (
    rawEvidence.schemaVersion !== XERO_ACCOUNTING_CASE_EXISTING_DOCUMENT_EVIDENCE_VERSION ||
    rawEvidence.decision !== "NO_WRITE_REQUIRED_EXISTING" ||
    rawEvidence.actionId !== operation.actionId ||
    rawEvidence.nativeRoute !== operation.nativeRoute ||
    rawEvidence.operationCanonicalPayloadHash !== operation.canonicalPayloadHash ||
    stableStringify(rawEvidence.businessReservation) !== stableStringify(operation.businessReservation) ||
    rawEvidence.providerObjectId !== xeroObjectId ||
    !history ||
    history.state !== "EXACT_ONE" ||
    history.complete !== true ||
    !Number.isSafeInteger(history.checkedObjectCount) ||
    (history.checkedObjectCount as number) < 1 ||
    history.canonicalEconomicMatch !== true ||
    !Array.isArray(history.mismatchReasons) ||
    history.mismatchReasons.length !== 0 ||
    !exactReadback
  ) return false;
  return xeroExistingDocumentMismatchReasons(operation, exactReadback, xeroObjectId).length === 0;
}
