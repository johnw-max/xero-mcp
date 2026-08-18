import {
  validateAccountingCaseReadbackEconomics,
  type AccountingCaseReadbackExpectation,
  type LedgerDurableReadbackProjection,
} from "../control-kernel/accountingCaseReadbackValidator.js";
import type { AccountingCaseOperation } from "../domain/accountingCase.js";
import type { XeroMutationRequest } from "../domain/xeroMutation.js";
import { hashObject } from "../security/hash.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function actualAccountBinding(
  expectedLine: Record<string, unknown> | undefined,
  accountId: unknown,
  accountCode: unknown,
): Record<string, unknown> {
  const expected = record(expectedLine?.providerAccountBinding) ?? {};
  return {
    ...expected,
    accountId,
    accountCode,
  };
}

function actualPolicyBinding(
  expectedLine: Record<string, unknown> | undefined,
  providerAccountBinding: Record<string, unknown>,
): Record<string, unknown> {
  const expectedProviderBinding = record(expectedLine?.providerAccountBinding) ?? {};
  return {
    accountingCategory: expectedLine?.accountingCategory,
    taxClass: expectedLine?.taxClass,
    ...(expectedLine?.exemptClassification
      ? { exemptClassification: expectedLine.exemptClassification }
      : {}),
    effectiveTaxRateBps: expectedLine?.effectiveTaxRateBps,
    taxSemantics: expectedLine?.taxSemantics,
    ...(expectedLine?.taxPolicyPeriodId ? { taxPolicyPeriodId: expectedLine.taxPolicyPeriodId } : {}),
    policyFields: {},
    providerAccountBinding: {
      ...expectedProviderBinding,
      accountId: providerAccountBinding.accountId,
      accountCode: providerAccountBinding.accountCode,
    },
  };
}

function xeroEvidenceProjection(raw: unknown, operation: AccountingCaseOperation): unknown {
  const evidence = record(raw);
  if (!evidence) return raw;
  const expectedLines = Array.isArray(operation.canonicalPayload.lines)
    ? operation.canonicalPayload.lines.map(record)
    : [];
  const invoice = record(evidence.providerDocumentReadback);
  const invoiceLines = Array.isArray(invoice?.lines)
    ? invoice.lines.map((rawLine, index) => {
        const line = record(rawLine);
        const expectedLine = expectedLines[index];
        const accountBinding = actualAccountBinding(expectedLine, line?.accountId, line?.accountCode);
        return line ? {
          ...line,
          accountingPolicyBindingHash: hashObject(actualPolicyBinding(expectedLine, accountBinding)),
          providerAccountBindingHash: hashObject(accountBinding),
          providerTaxBindingHash: hashObject({ taxType: line.taxType }),
        } : rawLine;
      })
    : undefined;
  const creditEconomics = record(evidence.providerEconomicsEvidence);
  const accountCodes = Array.isArray(creditEconomics?.accountCodes)
    ? creditEconomics.accountCodes
    : undefined;
  const accountIds = Array.isArray(creditEconomics?.accountIds)
    ? creditEconomics.accountIds
    : undefined;
  const taxTypes = Array.isArray(creditEconomics?.taxTypes)
    ? creditEconomics.taxTypes
    : undefined;
  return {
    ...evidence,
    ...(invoice ? {
      providerDocumentReadback: {
        ...invoice,
        documentId: invoice.invoiceId,
        ...(invoiceLines ? { lines: invoiceLines } : {}),
      },
    } : {}),
    ...(creditEconomics ? {
      providerEconomicsEvidence: {
        ...creditEconomics,
        ...(accountCodes && accountIds ? {
          accountingPolicyBindingHashes: accountCodes.map((accountCode, index) => {
            const expectedLine = expectedLines[index];
            const accountBinding = actualAccountBinding(expectedLine, accountIds[index], accountCode);
            return hashObject(actualPolicyBinding(expectedLine, accountBinding));
          }),
          providerAccountBindingHashes: accountCodes.map((accountCode, index) =>
            hashObject(actualAccountBinding(expectedLines[index], accountIds[index], accountCode))),
        } : {}),
        ...(taxTypes ? {
          providerTaxBindingHashes: taxTypes.map((taxType) => hashObject({ taxType })),
        } : {}),
      },
    } : {}),
    ...(evidence.creditNoteId ? { creditDocumentId: evidence.creditNoteId } : {}),
  };
}

/** Translate the Xero durable domain once, outside the shared validator. */
export function projectXeroMutationReadback(
  request: XeroMutationRequest,
  operation: AccountingCaseOperation,
): LedgerDurableReadbackProjection {
  const snapshot = record(request.readbackSnapshot);
  const projectedSnapshot = snapshot ? {
    ...snapshot,
    providerObjectId: snapshot.xeroObjectId,
    evidence: xeroEvidenceProjection(snapshot.evidence, operation),
  } : request.readbackSnapshot;
  const originalSnapshotHashValid = request.readbackSnapshot !== undefined &&
    request.readbackSnapshotHash === hashObject(request.readbackSnapshot);
  return {
    state: request.state,
    ...(request.xeroObjectId ? { providerObjectId: request.xeroObjectId } : {}),
    ...(request.writeReceipt ? { writeReceipt: request.writeReceipt } : {}),
    ...(projectedSnapshot !== undefined ? {
      readbackSnapshot: projectedSnapshot,
      ...(request.readbackSnapshotHash ? {
        readbackSnapshotHash: originalSnapshotHashValid
          ? hashObject(projectedSnapshot)
          : request.readbackSnapshotHash,
      } : {}),
    } : {}),
    ...(request.readbackCanonicalPayload !== undefined
      ? { readbackCanonicalPayload: request.readbackCanonicalPayload }
      : {}),
    ...(request.readbackPayloadHash ? { readbackPayloadHash: request.readbackPayloadHash } : {}),
    canonicalPayload: request.canonicalPayload,
    canonicalPayloadHash: request.canonicalPayloadHash,
    ...(request.readbackStatus ? { readbackStatus: request.readbackStatus } : {}),
  };
}

export function validateXeroAccountingCaseReadbackEconomics(
  operation: AccountingCaseOperation,
  request: XeroMutationRequest,
) {
  const expectation: AccountingCaseReadbackExpectation = operation.nativeRoute === "CONTACT_CREATE"
    ? { applicability: "NOT_A_NATIVE_DOCUMENT" }
    : operation.nativeRoute === "SALES_INVOICE"
      ? { applicability: "INVOICE_OR_BILL", providerStatus: "DRAFT", providerDocumentType: "ACCREC" }
      : operation.nativeRoute === "SUPPLIER_BILL"
        ? { applicability: "INVOICE_OR_BILL", providerStatus: "DRAFT", providerDocumentType: "ACCPAY" }
        : { applicability: "CREDIT_NOTE", providerStatus: "DRAFT", providerEvidenceObjectType: "CREDIT_NOTE" };
  return validateAccountingCaseReadbackEconomics(
    operation,
    projectXeroMutationReadback(request, operation),
    expectation,
  );
}
