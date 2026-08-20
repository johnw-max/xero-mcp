import type { AccountingCaseProviderBusinessHistoryLookup } from "../control-kernel/accountingCaseProviderContract.js";
import type { AccountingCaseOperation } from "../domain/accountingCase.js";
import type { ListCreditNotesInput, ListInvoicesInput } from "../domain/schemas.js";
import type {
  AccountingPrincipal,
  CreditNoteListResult,
  CreditNoteSnapshot,
  InvoiceListResult,
  InvoiceSnapshot,
  ReadPageEvidence,
} from "../providers/types.js";
import {
  XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION,
  xeroDocumentCoordinateAuthority,
  type XeroAuthoritativeDocumentProviderField,
} from "../policy/xeroBusinessCoordinateAuthority.js";
import { xeroExistingDocumentMismatchReasons } from "../policy/xeroAccountingCaseExistingDocumentEvidence.js";
import { isNativeDocumentRoute } from "../policy/xeroNativeRouteContract.js";

const PAGE_SIZE = 100;
const MAX_PROVIDER_ITEMS = 100_000;

export interface XeroBusinessCoordinateHistoryReadPort {
  listInvoices(principal: AccountingPrincipal, input: ListInvoicesInput): Promise<InvoiceListResult>;
  listCreditNotes(principal: AccountingPrincipal, input: ListCreditNotesInput): Promise<CreditNoteListResult>;
  getInvoice(
    principal: AccountingPrincipal,
    invoiceId: string,
    expectedType?: "ACCREC" | "ACCPAY",
  ): Promise<InvoiceSnapshot>;
  getCreditNote(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expectedType?: "ACCRECCREDIT" | "ACCPAYCREDIT",
  ): Promise<CreditNoteSnapshot>;
}

type ProviderSummary = InvoiceListResult["invoices"][number] | CreditNoteListResult["creditNotes"][number];
type ProviderSnapshot = InvoiceSnapshot | CreditNoteSnapshot;

export type XeroOriginalTransactionLookup =
  | Readonly<{ state: "NONE"; checkedObjectCount: number; complete: true }>
  | Readonly<{
      state: "EXACT_ONE";
      checkedObjectCount: number;
      complete: true;
      providerObjectId: string;
      exactReadback: InvoiceSnapshot;
    }>
  | Readonly<{
      state: "AMBIGUOUS";
      checkedObjectCount: number;
      complete: true;
      providerObjectIds: readonly string[];
    }>
  | Readonly<{
      state: "INCOMPLETE";
      checkedObjectCount: number;
      complete: false;
      reasonCodes: readonly string[];
    }>;

function normalizeReference(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function isCredit(operation: AccountingCaseOperation): boolean {
  return operation.nativeRoute === "CUSTOMER_CREDIT" || operation.nativeRoute === "SUPPLIER_CREDIT";
}

function objectId(value: ProviderSummary): string {
  return "invoiceId" in value ? value.invoiceId : value.creditNoteId;
}

function documentDate(value: ProviderSummary): string | undefined {
  return "invoiceId" in value ? value.invoiceDate : value.creditNoteDate;
}

function authoritativeReference(
  value: ProviderSummary | ProviderSnapshot,
  field: XeroAuthoritativeDocumentProviderField,
): string | undefined {
  if (field === "REFERENCE") return value.reference;
  if (field === "INVOICE_NUMBER") return "invoiceNumber" in value ? value.invoiceNumber : undefined;
  return "creditNoteNumber" in value ? value.creditNoteNumber : undefined;
}

function completePageProblems(
  evidence: ReadPageEvidence,
  requestedPage: number,
  rowCount: number,
  firstPageCount: number | undefined,
  firstItemCount: number | undefined,
): string[] {
  const problems: string[] = [];
  if (evidence.page !== requestedPage) problems.push("PROVIDER_PAGE_NUMBER_MISMATCH");
  if (!Number.isInteger(evidence.pageSize) || evidence.pageSize < 1 || evidence.pageSize > PAGE_SIZE) {
    problems.push("PROVIDER_PAGE_SIZE_INVALID");
  }
  if (evidence.returned !== rowCount) problems.push("PROVIDER_RETURNED_COUNT_MISMATCH");
  if (evidence.omittedInvalid !== 0) problems.push("PROVIDER_ROWS_OMITTED_INVALID");
  if ((evidence.omittedOverflow ?? 0) !== 0) problems.push("PROVIDER_ROWS_OMITTED_OVERFLOW");
  if (evidence.hasNextPageIsEstimated) problems.push("PROVIDER_PAGINATION_ESTIMATED");
  // Xero reports pageCount 0 / itemCount 0 for a filter that matches nothing
  // (e.g. the first bill ever for a supplier). That is a complete, exact
  // answer, not a broken one — only reject a page count that is missing or
  // that contradicts the page we asked for when rows actually came back.
  const emptyExactHistory = evidence.providerPageCount === 0 && evidence.providerItemCount === 0 &&
    requestedPage === 1 && rowCount === 0;
  if (!emptyExactHistory &&
      (!Number.isInteger(evidence.providerPageCount) || (evidence.providerPageCount ?? 0) < requestedPage)) {
    problems.push("PROVIDER_PAGE_COUNT_MISSING_OR_INVALID");
  }
  if (!Number.isInteger(evidence.providerItemCount) || (evidence.providerItemCount ?? -1) < 0) {
    problems.push("PROVIDER_ITEM_COUNT_MISSING_OR_INVALID");
  }
  if (firstPageCount !== undefined && evidence.providerPageCount !== firstPageCount) {
    problems.push("PROVIDER_PAGE_COUNT_DRIFT");
  }
  if (firstItemCount !== undefined && evidence.providerItemCount !== firstItemCount) {
    problems.push("PROVIDER_ITEM_COUNT_DRIFT");
  }
  if (evidence.providerPageCount !== undefined &&
      evidence.hasNextPage !== (requestedPage < evidence.providerPageCount)) {
    problems.push("PROVIDER_HAS_NEXT_PAGE_CONTRADICTION");
  }
  if ((evidence.providerItemCount ?? 0) > MAX_PROVIDER_ITEMS ||
      (evidence.providerPageCount ?? 0) * PAGE_SIZE > MAX_PROVIDER_ITEMS) {
    problems.push("PROVIDER_HISTORY_WINDOW_EXCEEDED");
  }
  return problems;
}

function incomplete(checkedObjectCount: number, reasonCodes: readonly string[]): AccountingCaseProviderBusinessHistoryLookup {
  return Object.freeze({
    state: "INCOMPLETE",
    checkedObjectCount,
    complete: false,
    reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()),
  });
}

function incompleteOriginal(
  checkedObjectCount: number,
  reasonCodes: readonly string[],
): Extract<XeroOriginalTransactionLookup, { state: "INCOMPLETE" }> {
  return Object.freeze({
    state: "INCOMPLETE",
    checkedObjectCount,
    complete: false,
    reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()),
  });
}

/**
 * Exhaustively resolves an ordinary historical invoice/bill coordinate. This
 * is original-transaction evidence only: it must never be interpreted as the
 * NO_WRITE decision for the credit note's own business coordinate.
 */
export async function lookupXeroOriginalTransaction(input: {
  reader: XeroBusinessCoordinateHistoryReadPort;
  principal: AccountingPrincipal;
  originalRoute: "SALES_INVOICE" | "SUPPLIER_BILL";
  contactId: string;
  reference: string;
  referenceKind: "FORMAL_DOCUMENT_NUMBER";
  documentDate: string;
}): Promise<XeroOriginalTransactionLookup> {
  const authoritativeProviderField = "INVOICE_NUMBER" as const;
  const rows: InvoiceListResult["invoices"] = [];
  let requestedPage = 1;
  let pageCount: number | undefined;
  let itemCount: number | undefined;
  while (true) {
    const response = await input.reader.listInvoices(input.principal, {
      ...(input.originalRoute === "SUPPLIER_BILL" ? { contact_id: input.contactId } : {}),
      type: input.originalRoute === "SUPPLIER_BILL" ? "ACCPAY" : "ACCREC",
      statuses: ["DRAFT", "SUBMITTED", "DELETED", "AUTHORISED", "PAID", "VOIDED"],
      page: requestedPage,
      page_size: PAGE_SIZE,
      include_archived: true,
      order: "DATE_ASC",
    });
    const problems = completePageProblems(
      response.pagination,
      requestedPage,
      response.invoices.length,
      pageCount,
      itemCount,
    );
    if (problems.length > 0) return incompleteOriginal(rows.length + response.invoices.length, problems);
    pageCount ??= response.pagination.providerPageCount;
    itemCount ??= response.pagination.providerItemCount;
    rows.push(...response.invoices);
    if (!response.pagination.hasNextPage) break;
    requestedPage += 1;
    if (requestedPage > Math.ceil(MAX_PROVIDER_ITEMS / PAGE_SIZE)) {
      return incompleteOriginal(rows.length, ["PROVIDER_HISTORY_WINDOW_EXCEEDED"]);
    }
  }
  if (rows.length !== itemCount) return incompleteOriginal(rows.length, ["PROVIDER_ITEM_COUNT_MISMATCH"]);
  const seenIds = new Set<string>();
  for (const row of rows) {
    const id = row.invoiceId.toLowerCase();
    if (seenIds.has(id)) return incompleteOriginal(rows.length, ["DUPLICATE_PROVIDER_OBJECT_ACROSS_PAGES"]);
    seenIds.add(id);
  }
  const canonicalReference = normalizeReference(input.reference);
  const matches = rows.filter((row) =>
    typeof authoritativeReference(row, authoritativeProviderField) === "string" &&
    normalizeReference(authoritativeReference(row, authoritativeProviderField)!) === canonicalReference &&
    (input.originalRoute === "SALES_INVOICE" || (
      row.contact.contactId.toLowerCase() === input.contactId.toLowerCase() &&
      row.invoiceDate === input.documentDate
    )));
  if (matches.length === 0) {
    return Object.freeze({ state: "NONE", checkedObjectCount: rows.length, complete: true });
  }
  if (matches.length > 1) {
    return Object.freeze({
      state: "AMBIGUOUS",
      checkedObjectCount: rows.length,
      complete: true,
      providerObjectIds: Object.freeze(matches.map((row) => row.invoiceId).sort()),
    });
  }
  const matched = matches[0]!;
  let snapshot: InvoiceSnapshot;
  try {
    snapshot = await input.reader.getInvoice(input.principal, matched.invoiceId, matched.type);
  } catch {
    return incompleteOriginal(rows.length, ["EXACT_PROVIDER_GET_FAILED"]);
  }
  if (snapshot.invoiceId.toLowerCase() !== matched.invoiceId.toLowerCase()) {
    return incompleteOriginal(rows.length, ["EXACT_PROVIDER_GET_ID_MISMATCH"]);
  }
  const exactProblems: string[] = [];
  if (snapshot.type !== (input.originalRoute === "SALES_INVOICE" ? "ACCREC" : "ACCPAY")) {
    exactProblems.push("EXACT_PROVIDER_GET_ROUTE_MISMATCH");
  }
  const exactReference = authoritativeReference(snapshot, authoritativeProviderField);
  if (!exactReference || normalizeReference(exactReference) !== canonicalReference) {
    exactProblems.push("EXACT_PROVIDER_GET_REFERENCE_MISMATCH");
  }
  if (snapshot.contact.contactId.toLowerCase() !== input.contactId.toLowerCase()) {
    exactProblems.push("EXACT_PROVIDER_GET_CONTACT_MISMATCH");
  }
  if (snapshot.invoiceDate !== input.documentDate) {
    exactProblems.push("EXACT_PROVIDER_GET_DOCUMENT_DATE_MISMATCH");
  }
  if (exactProblems.length > 0) return incompleteOriginal(rows.length, exactProblems);
  return Object.freeze({
    state: "EXACT_ONE",
    checkedObjectCount: rows.length,
    complete: true,
    providerObjectId: snapshot.invoiceId,
    exactReadback: Object.freeze(structuredClone(snapshot)),
  });
}

export async function lookupXeroProviderBusinessCoordinate(input: {
  reader: XeroBusinessCoordinateHistoryReadPort;
  principal: AccountingPrincipal;
  operation: AccountingCaseOperation;
}): Promise<AccountingCaseProviderBusinessHistoryLookup> {
  const { operation } = input;
  if (!isNativeDocumentRoute(operation.nativeRoute)) {
    return incomplete(0, ["NATIVE_DOCUMENT_ROUTE_REQUIRED"]);
  }
  const payloadReference = stringField(operation.canonicalPayload, "reference");
  const contactId = stringField(operation.canonicalPayload, "xeroContactId");
  const referenceKind = stringField(operation.canonicalPayload, "referenceKind");
  const payloadProviderField = stringField(operation.canonicalPayload, "authoritativeProviderField");
  const payloadUniquenessAuthority = stringField(operation.canonicalPayload, "uniquenessAuthority");
  const coordinate = operation.businessReservation.canonicalFields;
  const expectedAuthority = referenceKind === "FORMAL_DOCUMENT_NUMBER" ||
      referenceKind === "GENERIC_RECURRING_REFERENCE"
    ? xeroDocumentCoordinateAuthority(operation.nativeRoute, referenceKind)
    : undefined;
  const expectedCoordinateContact = expectedAuthority?.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER"
    ? contactId
    : undefined;
  if (!payloadReference || !contactId || !expectedAuthority ||
      payloadProviderField !== expectedAuthority.authoritativeProviderField ||
      payloadUniquenessAuthority !== expectedAuthority.uniquenessAuthority ||
      coordinate.referenceKind !== referenceKind ||
      coordinate.authoritativeProviderField !== expectedAuthority.authoritativeProviderField ||
      coordinate.uniquenessAuthority !== expectedAuthority.uniquenessAuthority ||
      coordinate.normalizationVersion !== XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION ||
      coordinate.route !== operation.nativeRoute ||
      coordinate.contactId !== expectedCoordinateContact ||
      coordinate.reference !== normalizeReference(payloadReference)) {
    return incomplete(0, ["BUSINESS_COORDINATE_AUTHORITY_PROJECTION_INVALID"]);
  }

  const expectedDate = stringField(operation.canonicalPayload, "documentDate");
  if (operation.businessReservation.scope === "DATED_OCCURRENCE" &&
      operation.businessReservation.occurrenceDate !== expectedDate) {
    return incomplete(0, ["BUSINESS_COORDINATE_OCCURRENCE_SCOPE_INVALID"]);
  }

  const rows: ProviderSummary[] = [];
  let requestedPage = 1;
  let pageCount: number | undefined;
  let itemCount: number | undefined;
  while (true) {
    const response = isCredit(operation)
      ? await input.reader.listCreditNotes(input.principal, {
          ...(expectedAuthority.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER"
            ? { contact_id: contactId }
            : {}),
          type: operation.nativeRoute === "SUPPLIER_CREDIT" ? "ACCPAYCREDIT" : "ACCRECCREDIT",
          page: requestedPage,
          page_size: PAGE_SIZE,
        })
      : await input.reader.listInvoices(input.principal, {
          ...(expectedAuthority.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER"
            ? { contact_id: contactId }
            : {}),
          type: operation.nativeRoute === "SUPPLIER_BILL" ? "ACCPAY" : "ACCREC",
          statuses: ["DRAFT", "SUBMITTED", "DELETED", "AUTHORISED", "PAID", "VOIDED"],
          page: requestedPage,
          page_size: PAGE_SIZE,
          include_archived: true,
          order: "DATE_ASC",
        });
    const pageRows: ProviderSummary[] = "invoices" in response ? response.invoices : response.creditNotes;
    const problems = completePageProblems(
      response.pagination,
      requestedPage,
      pageRows.length,
      pageCount,
      itemCount,
    );
    if (problems.length > 0) return incomplete(rows.length + pageRows.length, problems);
    pageCount ??= response.pagination.providerPageCount;
    itemCount ??= response.pagination.providerItemCount;
    rows.push(...pageRows);
    if (!response.pagination.hasNextPage) break;
    requestedPage += 1;
    if (requestedPage > Math.ceil(MAX_PROVIDER_ITEMS / PAGE_SIZE)) {
      return incomplete(rows.length, ["PROVIDER_HISTORY_WINDOW_EXCEEDED"]);
    }
  }
  if (rows.length !== itemCount) return incomplete(rows.length, ["PROVIDER_ITEM_COUNT_MISMATCH"]);
  const seenIds = new Set<string>();
  for (const row of rows) {
    const id = objectId(row).toLowerCase();
    if (seenIds.has(id)) return incomplete(rows.length, ["DUPLICATE_PROVIDER_OBJECT_ACROSS_PAGES"]);
    seenIds.add(id);
  }

  const canonicalReference = normalizeReference(payloadReference);
  const matches = rows.filter((row) =>
    typeof authoritativeReference(row, expectedAuthority.authoritativeProviderField) === "string" &&
    normalizeReference(authoritativeReference(row, expectedAuthority.authoritativeProviderField)!) ===
      canonicalReference &&
    (expectedAuthority.uniquenessAuthority === "PROVIDER_ENFORCED_UNIQUE" ||
      row.contact.contactId.toLowerCase() === contactId.toLowerCase()) &&
    (operation.businessReservation.scope === "ALL_OCCURRENCES" ||
      documentDate(row) === operation.businessReservation.occurrenceDate));
  if (matches.length === 0) {
    return Object.freeze({ state: "NONE", checkedObjectCount: rows.length, complete: true });
  }
  if (matches.length > 1) {
    return Object.freeze({
      state: "AMBIGUOUS",
      checkedObjectCount: rows.length,
      complete: true,
      providerObjectIds: Object.freeze(matches.map(objectId).sort()),
    });
  }

  const matched = matches[0]!;
  let snapshot: ProviderSnapshot;
  try {
    snapshot = "invoiceId" in matched
      ? await input.reader.getInvoice(input.principal, matched.invoiceId, matched.type)
      : await input.reader.getCreditNote(input.principal, matched.creditNoteId, matched.type);
  } catch {
    return incomplete(rows.length, ["EXACT_PROVIDER_GET_FAILED"]);
  }
  if (objectId(snapshot).toLowerCase() !== objectId(matched).toLowerCase()) {
    return incomplete(rows.length, ["EXACT_PROVIDER_GET_ID_MISMATCH"]);
  }
  const reasons = xeroExistingDocumentMismatchReasons(operation, snapshot, objectId(snapshot));
  return Object.freeze({
    state: "EXACT_ONE",
    checkedObjectCount: rows.length,
    complete: true,
    providerObjectId: objectId(snapshot),
    canonicalEconomicMatch: reasons.length === 0,
    mismatchReasons: Object.freeze(reasons),
    exactReadback: Object.freeze(structuredClone(snapshot)) as Readonly<Record<string, unknown>>,
  });
}
