import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileTestXeroAccountingCase as compileAccountingCase } from "./helpers/xeroTenantCoaProfile.js";
import type { AccountingCaseOperation } from "../src/domain/accountingCase.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import {
  createXeroExistingDocumentNoWriteEvidence,
  xeroExistingDocumentNoWriteEvidenceMatches,
} from "../src/policy/xeroAccountingCaseExistingDocumentEvidence.js";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

function salesInvoiceOperation(): AccountingCaseOperation {
  const compiled = compileAccountingCase(structuredClone(fixture));
  const operation = compiled.operations.find((candidate) => candidate.nativeRoute === "SALES_INVOICE");
  if (!operation) throw new Error("sales invoice operation missing");
  return operation;
}

function exactReadback(operation: AccountingCaseOperation, invoiceId: string): Record<string, unknown> {
  const payload = operation.canonicalPayload;
  const lines = Array.isArray(payload.lines)
    ? payload.lines as Array<Record<string, unknown>>
    : [];
  return {
    invoiceId,
    tenantId: operation.target.tenantId,
    type: "ACCREC",
    status: "DRAFT",
    contact: { contactId: payload.xeroContactId },
    invoiceDate: payload.documentDate,
    dueDate: payload.dueDate,
    currency: payload.currency,
    invoiceNumber: payload.reference,
    reference: payload.reference,
    subTotal: payload.net,
    totalTax: payload.tax,
    total: payload.gross,
    lineAmountType: "Exclusive",
    lines: lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      lineAmount: line.net,
      taxAmount: line.tax,
      accountId: line.accountId,
      accountCode: line.accountCode,
      taxType: line.taxType,
    })),
    lineItemCount: lines.length,
    linesTruncated: false,
  };
}

describe("Xero existing-document no-write evidence", () => {
  it("binds exact provider history to action, reservation, provider object and canonical economics", () => {
    const operation = salesInvoiceOperation();
    const invoiceId = "88888888-8888-4888-8888-888888888888";
    const evidence = createXeroExistingDocumentNoWriteEvidence(operation, {
      state: "EXACT_ONE",
      checkedObjectCount: 1,
      complete: true,
      providerObjectId: invoiceId,
      canonicalEconomicMatch: true,
      mismatchReasons: [],
      exactReadback: exactReadback(operation, invoiceId),
    });
    expect(xeroExistingDocumentNoWriteEvidenceMatches(operation, invoiceId, evidence)).toBe(true);

    const mutations: Array<(candidate: Record<string, unknown>) => void> = [
      (candidate) => { candidate.actionId = "contact.create_basic"; },
      (candidate) => {
        const reservation = candidate.businessReservation as Record<string, unknown>;
        reservation.scope = "DATED_OCCURRENCE";
        reservation.occurrenceDate = String(operation.canonicalPayload.documentDate);
      },
      (candidate) => {
        const history = candidate.providerHistory as Record<string, unknown>;
        history.complete = false;
      },
      (candidate) => {
        const readback = candidate.exactReadback as Record<string, unknown>;
        readback.total = "999.0000";
      },
      (candidate) => {
        const readback = candidate.exactReadback as Record<string, unknown>;
        readback.invoiceId = "99999999-9999-4999-8999-999999999999";
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(evidence);
      mutate(candidate);
      expect(xeroExistingDocumentNoWriteEvidenceMatches(operation, invoiceId, candidate)).toBe(false);
    }
  });
});
