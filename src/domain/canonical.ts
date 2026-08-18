import type { CreateDraftSalesInvoiceInput, CreateDraftSupplierBillInput } from "./schemas.js";
import type { InvoiceSnapshot, SupplierBillSnapshot } from "../providers/types.js";

function fixedFour(value: number): string {
  return value.toFixed(4);
}

type DraftFingerprintInput = Pick<
  CreateDraftSupplierBillInput,
  | "source_ref"
  | "contact_id"
  | "invoice_date"
  | "due_date"
  | "currency"
  | "currency_rate"
  | "reference"
  | "authoritative_provider_field"
  | "line_amount_type"
  | "lines"
>;

export function canonicalDraftExtractionFingerprint(
  input: DraftFingerprintInput,
): Record<string, unknown> {
  return {
    sourceRef: input.source_ref,
    contactId: input.contact_id,
    invoiceDate: input.invoice_date,
    dueDate: input.due_date,
    currency: input.currency,
    ...(input.currency_rate !== undefined ? { currencyRate: fixedFour(input.currency_rate) } : {}),
    reference: input.reference,
    authoritativeProviderField: input.authoritative_provider_field,
    lineAmountType: input.line_amount_type,
    lines: input.lines.map((line) => ({
      description: line.description,
      quantity: fixedFour(line.quantity),
      unitAmount: fixedFour(line.unit_amount),
      ...(line.account_id ? { accountId: line.account_id } : {}),
      accountCode: line.account_code,
      taxType: line.tax_type,
    })),
  };
}

export function canonicalDraftRequest(
  tenantId: string,
  input: CreateDraftSupplierBillInput,
): Record<string, unknown> {
  return {
    tenantId,
    ...canonicalDraftExtractionFingerprint(input),
    sourceSha256: input.source_sha256,
    sourceEvidenceType: input.source_evidence_type,
    userConfirmation: input.user_confirmation,
  };
}

export function canonicalSalesInvoiceDraftExtractionFingerprint(
  input: CreateDraftSalesInvoiceInput,
): Record<string, unknown> {
  // Source identity is deliberately document-type agnostic. The same extracted
  // material must not be interpreted once as AP and once as AR; operation type
  // belongs to the full request/idempotency identity below instead.
  return canonicalDraftExtractionFingerprint(input);
}

export function canonicalSalesInvoiceDraftRequest(
  tenantId: string,
  input: CreateDraftSalesInvoiceInput,
): Record<string, unknown> {
  return {
    tenantId,
    invoiceType: "ACCREC",
    ...canonicalSalesInvoiceDraftExtractionFingerprint(input),
    sourceSha256: input.source_sha256,
    sourceEvidenceType: input.source_evidence_type,
    userConfirmation: input.user_confirmation,
  };
}

export function canonicalInvoiceForApproval(invoice: InvoiceSnapshot): Record<string, unknown> {
  return {
    tenantId: invoice.tenantId,
    invoiceId: invoice.invoiceId,
    type: invoice.type,
    contact: {
      contactId: invoice.contact.contactId,
      name: invoice.contact.name,
    },
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    currencyRate: invoice.currencyRate,
    reference: invoice.reference,
    invoiceNumber: invoice.invoiceNumber,
    lineAmountType: invoice.lineAmountType,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      lineAmount: line.lineAmount,
      taxAmount: line.taxAmount,
      ...(line.accountId ? { accountId: line.accountId } : {}),
      accountCode: line.accountCode,
      taxType: line.taxType,
    })),
    subTotal: invoice.subTotal,
    totalTax: invoice.totalTax,
    total: invoice.total,
  };
}

export function canonicalBillForApproval(bill: SupplierBillSnapshot): Record<string, unknown> {
  return canonicalInvoiceForApproval(bill);
}
