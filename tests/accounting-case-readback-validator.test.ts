import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileTestXeroAccountingCase as compileAccountingCase } from "./helpers/xeroTenantCoaProfile.js";
import { validateXeroAccountingCaseReadbackEconomics as validateAccountingCaseReadbackEconomics } from "../src/policy/xeroAccountingCaseReadbackProjection.js";
import { mapCreditNoteDraftReadback } from "../src/providers/xeroCreditNoteManualJournalDraft.js";
import type { AccountingCaseOperation } from "../src/domain/accountingCase.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import type { XeroMutationRequest } from "../src/domain/xeroMutation.js";
import { hashObject } from "../src/security/hash.js";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

const compiled = compileAccountingCase(fixture);

function nativeOperation(route: AccountingCaseOperation["nativeRoute"]): AccountingCaseOperation {
  const operation = compiled.operations.find((candidate) => candidate.nativeRoute === route);
  if (!operation) throw new Error(`Fixture has no ${route} operation`);
  return operation;
}

function lines(operation: AccountingCaseOperation) {
  if (!Array.isArray(operation.canonicalPayload.lines)) throw new Error("Fixture operation has no lines");
  return operation.canonicalPayload.lines as Array<Record<string, unknown>>;
}

function baseRequest(
  operation: AccountingCaseOperation,
  evidence: Record<string, unknown>,
): XeroMutationRequest {
  const canonicalPayload = { providerProposalFor: operation.operationId };
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const xeroObjectId = "44444444-4444-4444-8444-444444444444";
  const readbackSnapshot = { xeroObjectId, status: "DRAFT", canonicalPayload, evidence };
  const now = new Date("2026-08-13T04:00:00.000Z");
  return {
    mutationRequestId: "xmr_readback_economics",
    preparationId: "xmp_readback_economics",
    requestId: "case-readback-economics",
    actorId: "actor",
    workspaceId: "workspace",
    tenantId: "tenant",
    installationId: "installation",
    bindingId: "binding",
    bindingRevision: 1,
    connectionId: "connection",
    targetSessionId: "target",
    objectType: operation.nativeRoute === "SALES_INVOICE"
      ? "SALES_INVOICE"
      : operation.nativeRoute === "SUPPLIER_BILL"
        ? "SUPPLIER_BILL"
        : operation.nativeRoute === "MANUAL_JOURNAL"
          ? "MANUAL_JOURNAL"
        : "CREDIT_NOTE",
    operation: "CREATE_DRAFT",
    canonicalPayload,
    canonicalPayloadHash,
    sourceRef: `case:${operation.caseId}`,
    sourceUnitKey: operation.operationId,
    sourceSha256: "a".repeat(64),
    sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
    confirmationSummaryHash: "b".repeat(64),
    authorizationReceipt: { receiptType: "TEST" },
    state: "READBACK_VERIFIED",
    xeroObjectId,
    writeReceipt: { providerRequestId: "provider-request" },
    readbackSnapshot,
    readbackSnapshotHash: hashObject(readbackSnapshot),
    readbackCanonicalPayload: canonicalPayload,
    readbackPayloadHash: canonicalPayloadHash,
    readbackStatus: "DRAFT",
    confirmedAt: now,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function invoiceRequest(operation: AccountingCaseOperation): XeroMutationRequest {
  const payload = operation.canonicalPayload;
  const xeroObjectId = "44444444-4444-4444-8444-444444444444";
  return baseRequest(operation, {
    providerDocumentReadback: {
      invoiceId: xeroObjectId,
      type: operation.nativeRoute === "SALES_INVOICE" ? "ACCREC" : "ACCPAY",
      status: "DRAFT",
      subTotal: payload.net,
      totalTax: payload.tax,
      total: payload.gross,
      lineItemCount: lines(operation).length,
      linesTruncated: false,
      lines: lines(operation).map((line) => ({
        lineAmount: line.net,
        taxAmount: line.tax,
        accountId: line.accountId,
        accountCode: line.accountCode,
        taxType: line.taxType,
      })),
    },
  });
}

function creditRequest(operation: AccountingCaseOperation): XeroMutationRequest {
  const payload = operation.canonicalPayload;
  return baseRequest(operation, {
    objectType: "CREDIT_NOTE",
    creditNoteId: "44444444-4444-4444-8444-444444444444",
    providerEconomicsEvidence: {
      lineAmounts: lines(operation).map((line) => line.net),
      taxAmounts: lines(operation).map((line) => line.tax),
      accountIds: lines(operation).map((line) => line.accountId),
      accountCodes: lines(operation).map((line) => line.accountCode),
      taxTypes: lines(operation).map((line) => line.taxType),
      subTotal: payload.net,
      totalTax: payload.tax,
      total: payload.gross,
      noDiscountsVerified: true,
    },
  });
}

function replaceEvidence(request: XeroMutationRequest, evidence: Record<string, unknown>): XeroMutationRequest {
  const canonicalPayload = request.readbackCanonicalPayload!;
  const readbackSnapshot = {
    xeroObjectId: request.xeroObjectId,
    status: "DRAFT",
    canonicalPayload,
    evidence,
  };
  return {
    ...request,
    readbackSnapshot,
    readbackSnapshotHash: hashObject(readbackSnapshot),
  };
}

describe("Accounting Case exact economic readback validator", () => {
  it("accepts a readback-verified Manual Journal Case without treating it as a credit note", () => {
    const journal = compileAccountingCase({
      ...fixture,
      caseId: "case-readback-manual-journal",
      sources: [
        ...fixture.sources,
        {
          artifactId: "manual-journal-artifact",
          label: "Manual journal",
          units: [{ unitId: "manual-journal-unit", expectedFactKinds: ["BALANCED_JOURNAL"] as const }],
        },
      ],
      facts: [
        ...fixture.facts,
        {
          factId: "manual-journal-readback-v1",
          lineageKey: "manual-journal-readback",
          eventKey: "manual-journal-readback-event",
          sourceUnitIds: ["manual-journal-unit"],
          origin: "MODEL_EXTRACTED" as const,
          revision: 1,
          kind: "BALANCED_JOURNAL" as const,
          narration: "Readback validator journal",
          date: "2026-08-13",
          lines: [
            {
              lineId: "debit",
              description: "Debit",
              accountCode: "453",
              taxType: "NONE",
              debit: "100.0000",
            },
            {
              lineId: "credit",
              description: "Credit",
              accountCode: "200",
              taxType: "NONE",
              credit: "100.0000",
            },
          ],
          documentValidity: "TEST_OR_NOT_VALID" as const,
        },
      ],
    }).operations.find((candidate) => candidate.nativeRoute === "MANUAL_JOURNAL");
    if (!journal) throw new Error("Fixture did not compile a Manual Journal operation");

    const request = baseRequest(journal, {
      objectType: "MANUAL_JOURNAL",
      manualJournalId: "44444444-4444-4444-8444-444444444444",
      providerTaxEvidence: {
        taxTypes: ["NONE", "NONE"],
        taxAmounts: ["0.0000", "0.0000"],
        allNoneAndZero: true,
      },
      balanceVerified: true,
    });
    expect(validateAccountingCaseReadbackEconomics(journal, request)).toEqual({
      ok: true,
      applicability: "NOT_A_NATIVE_DOCUMENT",
    });
  });

  it("accepts exact invoice and credit-note provider economics", () => {
    const invoice = nativeOperation("SALES_INVOICE");
    const credit = nativeOperation("CUSTOMER_CREDIT");
    expect(validateAccountingCaseReadbackEconomics(invoice, invoiceRequest(invoice))).toEqual({
      ok: true,
      applicability: "INVOICE_OR_BILL",
    });
    expect(validateAccountingCaseReadbackEconomics(credit, creditRequest(credit))).toEqual({
      ok: true,
      applicability: "CREDIT_NOTE",
    });
  });

  it("accepts real Xero credit mapping after policy rounding and rejects a sub-minor-unit drift", () => {
    const operation = nativeOperation("CUSTOMER_CREDIT");
    const payload = operation.canonicalPayload;
    const authoritativeProviderField = payload.authoritativeProviderField;
    if (authoritativeProviderField !== "CREDIT_NOTE_NUMBER" && authoritativeProviderField !== "REFERENCE") {
      throw new Error("Fixture credit operation has no sealed authoritative provider field");
    }
    const caseLines = lines(operation);
    const xeroObjectId = "44444444-4444-4444-8444-444444444444";
    const raw = {
      creditNoteID: xeroObjectId,
      contact: { contactID: payload.xeroContactId },
      date: payload.documentDate,
      currencyCode: payload.currency,
      ...(authoritativeProviderField === "CREDIT_NOTE_NUMBER"
        ? { creditNoteNumber: payload.reference }
        : { reference: payload.reference }),
      lineAmountTypes: "Exclusive",
      type: "ACCRECCREDIT",
      status: "DRAFT",
      lineItems: caseLines.map((line, index) => ({
        description: line.description,
        quantity: Number(line.quantity),
        unitAmount: Number(line.unitAmount),
        lineAmount: Number(line.net),
        taxAmount: Number(line.tax),
        accountID: line.accountId,
        accountCode: line.accountCode,
        taxType: line.taxType,
      })),
      subTotal: Number(payload.net),
      totalTax: Number(payload.tax),
      total: Number(payload.gross),
      appliedAmount: 0,
      remainingCredit: Number(payload.gross),
      sentToContact: false,
      allocations: [],
      payments: [],
      validationErrors: [],
      hasErrors: false,
    };
    const exact = mapCreditNoteDraftReadback(raw, authoritativeProviderField);
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error(exact.reason);
    expect(validateAccountingCaseReadbackEconomics(operation, baseRequest(operation, exact.snapshot)))
      .toEqual({ ok: true, applicability: "CREDIT_NOTE" });

    const driftedRaw = structuredClone(raw);
    driftedRaw.lineItems[0]!.lineAmount += 0.0001;
    driftedRaw.subTotal += 0.0001;
    driftedRaw.total += 0.0001;
    driftedRaw.remainingCredit += 0.0001;
    const drifted = mapCreditNoteDraftReadback(driftedRaw, authoritativeProviderField);
    expect(drifted.ok).toBe(true);
    if (!drifted.ok) throw new Error(drifted.reason);
    expect(validateAccountingCaseReadbackEconomics(operation, baseRequest(operation, drifted.snapshot)))
      .toMatchObject({
        ok: false,
        reasons: expect.arrayContaining([
          "PROVIDER_CREDIT_LINE_AMOUNT_MISMATCH",
          "PROVIDER_CREDIT_SUBTOTAL_MISMATCH",
          "PROVIDER_CREDIT_GROSS_TOTAL_MISMATCH",
        ]),
      });
  });

  it("rejects an invoice whose unchanged TaxType hides a self-consistent tax/total mutation", () => {
    const operation = nativeOperation("SALES_INVOICE");
    const request = invoiceRequest(operation);
    const evidence = structuredClone(
      (request.readbackSnapshot as Record<string, unknown>).evidence as Record<string, unknown>,
    );
    const provider = evidence.providerDocumentReadback as Record<string, unknown>;
    const providerLines = provider.lines as Array<Record<string, unknown>>;
    providerLines[0]!.taxAmount = "361.0000";
    provider.totalTax = "361.0000";
    provider.total = "4361.0000";

    expect(validateAccountingCaseReadbackEconomics(operation, replaceEvidence(request, evidence)))
      .toMatchObject({
        ok: false,
        reasons: expect.arrayContaining([
          "PROVIDER_DOCUMENT_LINE_TAX_MISMATCH",
          "PROVIDER_DOCUMENT_TAX_TOTAL_MISMATCH",
          "PROVIDER_DOCUMENT_GROSS_TOTAL_MISMATCH",
        ]),
      });
  });

  it("rejects an otherwise self-consistent provider readback that differs by exactly one currency minor unit", () => {
    const operation = nativeOperation("SALES_INVOICE");
    const request = invoiceRequest(operation);
    const evidence = structuredClone(
      (request.readbackSnapshot as Record<string, unknown>).evidence as Record<string, unknown>,
    );
    const provider = evidence.providerDocumentReadback as Record<string, unknown>;
    const providerLines = provider.lines as Array<Record<string, unknown>>;
    providerLines[0]!.taxAmount = "360.0100";
    provider.totalTax = "360.0100";
    provider.total = "4360.0100";

    expect(validateAccountingCaseReadbackEconomics(operation, replaceEvidence(request, evidence)))
      .toMatchObject({
        ok: false,
        reasons: expect.arrayContaining([
          "PROVIDER_DOCUMENT_LINE_TAX_MISMATCH",
          "PROVIDER_DOCUMENT_TAX_TOTAL_MISMATCH",
          "PROVIDER_DOCUMENT_GROSS_TOTAL_MISMATCH",
        ]),
      });
  });

  it.each([
    ["account code", "accountCode", "999", "PROVIDER_DOCUMENT_LINE_ACCOUNT_MISMATCH"],
    [
      "account ID",
      "accountId",
      "99999999-9999-4999-8999-999999999999",
      "PROVIDER_DOCUMENT_LINE_ACCOUNT_MISMATCH",
    ],
    ["tax semantics", "taxType", "NONE", "PROVIDER_DOCUMENT_LINE_TAX_SEMANTICS_MISMATCH"],
  ] as const)("rejects an exact-amount readback with a different line %s binding", (
    _label,
    field,
    replacement,
    reason,
  ) => {
    const operation = nativeOperation("SALES_INVOICE");
    const request = invoiceRequest(operation);
    const evidence = structuredClone(
      (request.readbackSnapshot as Record<string, unknown>).evidence as Record<string, unknown>,
    );
    const provider = evidence.providerDocumentReadback as Record<string, unknown>;
    const providerLines = provider.lines as Array<Record<string, unknown>>;
    providerLines[0]![field] = replacement;

    expect(validateAccountingCaseReadbackEconomics(operation, replaceEvidence(request, evidence)))
      .toMatchObject({ ok: false, reasons: expect.arrayContaining([reason]) });
  });

  it("rejects a credit note whose canonical fields match but economic evidence is self-consistently mutated", () => {
    const operation = nativeOperation("CUSTOMER_CREDIT");
    const request = creditRequest(operation);
    const evidence = structuredClone(
      (request.readbackSnapshot as Record<string, unknown>).evidence as Record<string, unknown>,
    );
    const provider = evidence.providerEconomicsEvidence as Record<string, unknown>;
    (provider.taxAmounts as unknown[])[0] = "37.0000";
    provider.totalTax = "37.0000";
    provider.total = "437.0000";

    expect(validateAccountingCaseReadbackEconomics(operation, replaceEvidence(request, evidence)))
      .toMatchObject({
        ok: false,
        reasons: expect.arrayContaining([
          "PROVIDER_CREDIT_LINE_TAX_MISMATCH",
          "PROVIDER_CREDIT_TAX_TOTAL_MISMATCH",
          "PROVIDER_CREDIT_GROSS_TOTAL_MISMATCH",
        ]),
      });
  });

  it("fails closed when invoice lines are truncated or economic fields are missing", () => {
    const operation = nativeOperation("SUPPLIER_BILL");
    const request = invoiceRequest(operation);
    const evidence = structuredClone(
      (request.readbackSnapshot as Record<string, unknown>).evidence as Record<string, unknown>,
    );
    const provider = evidence.providerDocumentReadback as Record<string, unknown>;
    provider.linesTruncated = true;
    delete (provider.lines as Array<Record<string, unknown>>)[0]!.taxAmount;

    expect(validateAccountingCaseReadbackEconomics(operation, replaceEvidence(request, evidence)))
      .toMatchObject({
        ok: false,
        reasons: expect.arrayContaining([
          "PROVIDER_DOCUMENT_LINES_TRUNCATED",
          "PROVIDER_DOCUMENT_LINE_ECONOMICS_MALFORMED",
        ]),
      });
  });

  it("rejects a malformed amount bridge and any declared credit rounding tolerance", () => {
    const invoice = structuredClone(nativeOperation("SALES_INVOICE"));
    if (!invoice.amountBridge) throw new Error("Fixture operation has no amount bridge");
    invoice.amountBridge.sourceGross = "9999.0000";
    expect(validateAccountingCaseReadbackEconomics(invoice, invoiceRequest(invoice))).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(["CASE_AMOUNT_BRIDGE_MISMATCH"]),
    });

    const lineTampered = structuredClone(nativeOperation("SALES_INVOICE"));
    if (!lineTampered.amountBridge) throw new Error("Fixture operation has no line amount bridge");
    lineTampered.amountBridge.lineBridges[0]!.sourceTax = "0.0000";
    expect(validateAccountingCaseReadbackEconomics(lineTampered, invoiceRequest(lineTampered))).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(["CASE_AMOUNT_BRIDGE_LINE_MISMATCH"]),
    });

    const credit = nativeOperation("CUSTOMER_CREDIT");
    const request = creditRequest(credit);
    const evidence = structuredClone(
      (request.readbackSnapshot as Record<string, unknown>).evidence as Record<string, unknown>,
    );
    (evidence.providerEconomicsEvidence as Record<string, unknown>).roundingTolerance = "0.0001";
    expect(validateAccountingCaseReadbackEconomics(credit, replaceEvidence(request, evidence))).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(["PROVIDER_CREDIT_ECONOMICS_MALFORMED"]),
    });
  });

  it("fails closed when the sealed Case claims an unsupported document-total tax aggregation", () => {
    const operation = structuredClone(nativeOperation("SALES_INVOICE"));
    const monetaryRule = operation.canonicalPayload.monetaryRule as Record<string, unknown>;
    monetaryRule.taxAggregation = "DOCUMENT_TOTAL";

    expect(validateAccountingCaseReadbackEconomics(operation, invoiceRequest(operation))).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(["CASE_MONETARY_ROUNDING_RULE_MALFORMED"]),
    });
  });
});
