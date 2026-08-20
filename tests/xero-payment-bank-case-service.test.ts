import { describe, expect, it, vi } from "vitest";
import { hashObject } from "../src/security/hash.js";
import type { RequestContext } from "../src/security/requestContext.js";
import { XeroPaymentBankCaseService } from "../src/services/xeroPaymentBankCaseService.js";

const paymentId = "11111111-1111-4111-8111-111111111111";
const invoiceId = "22222222-2222-4222-8222-222222222222";
const bankId = "33333333-3333-4333-8333-333333333333";
const payload = { schemaVersion: "xero-payment-bank-transaction:v1" as const, objectType: "PAYMENT" as const,
  operation: "CREATE" as const, invoiceId, invoiceType: "ACCREC" as const, bankAccountId: bankId,
  paymentDate: "2026-08-20", amount: "10.0000", reference: "PAY-1" };
const receipt = { operation: "CREATE_PAYMENT_RECORD" as const, objectId: paymentId };
const context = { requestId: "request-payment", actorId: "workspace:user:subject", workspaceId: "workspace",
  subjectType: "USER", subjectId: "subject", agentId: "accounting-agent", oauthInstallationId: "installation",
  bindingId: "binding", bindingRevision: 1, connectionId: "connection", targetSessionId: "target-session",
  targetSessionHash: "b".repeat(64), targetSessionExpiresAt: new Date("2026-08-21T00:00:00Z"), scopes: [], roles: [],
  authn: { issuer: "issuer", subject: "subject", audience: "audience", tokenId: "token" }, legacyDemo: false } as RequestContext;

function preparation() { return { preparationId: `xmp_${"1".repeat(32)}`, state: "PREPARED", objectType: "PAYMENT", operation: "CREATE",
  canonicalPayload: payload, canonicalPayloadHash: hashObject(payload), sourceRef: "case:payment", sourceUnitKey: "op-payment",
  sourceSha256: "d".repeat(64), sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED", actorId: context.actorId,
  workspaceId: context.workspaceId, tenantId: "tenant", installationId: context.oauthInstallationId, bindingId: context.bindingId,
  bindingRevision: 1, connectionId: context.connectionId, targetSessionId: context.targetSessionId,
  confirmationSummaryHash: "e".repeat(64), confirmationPhraseHash: "f".repeat(64), expiresAt: new Date("2026-08-21T00:00:00Z"),
  createdAt: new Date(), updatedAt: new Date() } as const; }
function request(state: "WRITE_IN_FLIGHT" | "WRITE_UNCERTAIN" | "READBACK_VERIFIED") { return { ...preparation(), mutationRequestId: "xmr_payment",
  requestId: "caseop:payment", state, authorizationReceipt: {}, ...(state !== "WRITE_IN_FLIGHT" ? { xeroObjectId: paymentId,
    writeReceipt: receipt, ...(state === "READBACK_VERIFIED" ? { readbackSnapshot: { paymentId, status: "AUTHORISED" }, readbackStatus: "AUTHORISED" } : {}) } : {}) } as never; }

function harness(recovery: boolean, readOk = true) {
  const sequence: string[] = [];
  const mutations = { resumeAutonomousRecovery: vi.fn(async () => recovery ? { preparation: preparation(),
    claim: { request: request("WRITE_UNCERTAIN"), mode: "RECOVER_ONLY" } } : undefined),
    loadAutonomousPreparation: vi.fn(async () => preparation()), authoriseAutonomous: vi.fn(async (_c, _i, _s, _r, validate) => {
      await validate(); return { request: request("WRITE_IN_FLIGHT"), mode: "CALL_PROVIDER", providerWritePermit: {} }; }),
    recordWriteEvidence: vi.fn(async () => { sequence.push("receipt"); return request("WRITE_UNCERTAIN"); }),
    rejectProvider: vi.fn(), markUnknown: vi.fn(), markReadbackVerified: vi.fn(async () => { sequence.push("complete"); return request("READBACK_VERIFIED"); }),
    recover: vi.fn(async () => { sequence.push("recover"); return { request: request("READBACK_VERIFIED"), outcome: "READBACK_VERIFIED" }; }) };
  const reads = { getInvoice: vi.fn(async () => ({ invoiceId, type: "ACCREC", status: "AUTHORISED" })), listAccounts: vi.fn(async () => []) };
  const provider = { createPayment: vi.fn(async () => { sequence.push("write"); return { objectId: paymentId, receipt }; }),
    readAndVerifyPayment: vi.fn(async () => { sequence.push("exact-get"); if (!readOk) throw new Error("mismatch");
      return { paymentId, status: "AUTHORISED", type: "ACCRECPAYMENT", invoiceId, accountId: bankId, paymentDate: "2026-08-20", amount: "10.0000", reference: "PAY-1" }; }) };
  return { service: new XeroPaymentBankCaseService(reads as never, provider as never, mutations as never), mutations, provider, sequence };
}

describe("XeroPaymentBankCaseService", () => {
  it("persists a payment receipt before separate exact GET", async () => {
    const { service, sequence, mutations } = harness(false);
    await service.execute(context, { preparation_id: `xmp_${"1".repeat(32)}`, request_id: "caseop:payment", actionId: "payment.create" });
    expect(sequence).toEqual(["write", "receipt", "exact-get", "complete"]);
    expect(mutations.recordWriteEvidence).toHaveBeenCalledWith(context, { mutationRequestId: "xmr_payment", xeroObjectId: paymentId, writeReceipt: receipt });
  });
  it("recovers by exact GET only and uses mutations.recover", async () => {
    const { service, sequence, provider, mutations } = harness(true);
    await service.execute(context, { preparation_id: `xmp_${"1".repeat(32)}`, request_id: "caseop:payment", actionId: "payment.create" });
    expect(provider.createPayment).not.toHaveBeenCalled(); expect(sequence).toEqual(["exact-get", "recover"]);
    expect(mutations.markReadbackVerified).not.toHaveBeenCalled(); expect(mutations.recover).toHaveBeenCalledTimes(1);
  });
  it("marks exact-read mismatch uncertain with target and receipt", async () => {
    const { service, mutations } = harness(false, false);
    await expect(service.execute(context, { preparation_id: `xmp_${"1".repeat(32)}`, request_id: "caseop:payment", actionId: "payment.create" }))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(mutations.markUnknown).toHaveBeenCalledWith(context, { mutationRequestId: "xmr_payment", xeroObjectId: paymentId, writeReceipt: receipt });
  });
});
