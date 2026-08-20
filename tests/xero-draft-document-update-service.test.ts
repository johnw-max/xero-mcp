import { describe, expect, it, vi } from "vitest";
import { buildQuoteDraftPrimitive } from "../src/domain/xeroQuotePurchaseOrderDraft.js";
import { XeroDraftDocumentUpdateService } from "../src/services/xeroDraftDocumentUpdateService.js";
import type { RequestContext } from "../src/security/requestContext.js";

const targetId = "44444444-4444-4444-8444-444444444444";
const expectedUpdatedAt = "2026-08-20T10:00:00+08:00";
const replacement = buildQuoteDraftPrimitive({
  source_ref: "case:case-update",
  source_unit_key: "operation-update",
  source_sha256: "a".repeat(64),
  contact_id: "11111111-1111-4111-8111-111111111111",
  quote_date: "2026-08-20",
  expiry_date: "2026-09-20",
  currency: "SGD",
  reference: "QUOTE-UPDATE-1",
  line_amount_type: "Exclusive",
  lines: [{
    description: "Complete replacement",
    quantity: 1,
    unit_amount: 10,
    account_code: "200",
    tax_type: "NONE",
  }],
}).canonicalPayload;
const envelope = { targetXeroObjectId: targetId, expectedUpdatedAt, replacement };
const context = {
  requestId: "request-update",
  actorId: "workspace:user:subject",
  workspaceId: "workspace",
  subjectType: "USER",
  subjectId: "subject",
  agentId: "accounting-agent",
  oauthInstallationId: "installation",
  bindingId: "binding",
  bindingRevision: 1,
  connectionId: "connection",
  targetSessionId: "target-session",
  targetSessionHash: "b".repeat(64),
  targetSessionExpiresAt: new Date("2026-08-21T00:00:00.000Z"),
  scopes: ["xero.read", "xero.draft.write"],
  roles: [],
  authn: { issuer: "issuer", subject: "subject", audience: "audience", tokenId: "token" },
  legacyDemo: false,
} as RequestContext;

function preparation() {
  return {
    preparationId: `xmp_${"1".repeat(32)}`,
    state: "PREPARED",
    objectType: "QUOTE",
    operation: "UPDATE",
    targetXeroObjectId: targetId,
    canonicalPayload: envelope,
    canonicalPayloadHash: "c".repeat(64),
    sourceRef: "case:case-update",
    sourceUnitKey: "operation-update",
    sourceSha256: "d".repeat(64),
    sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
    actorId: context.actorId,
    workspaceId: context.workspaceId,
    tenantId: "tenant",
    installationId: context.oauthInstallationId,
    bindingId: context.bindingId,
    bindingRevision: context.bindingRevision,
    connectionId: context.connectionId,
    targetSessionId: context.targetSessionId,
    confirmationSummaryHash: "e".repeat(64),
    confirmationPhraseHash: "f".repeat(64),
    expiresAt: new Date("2026-08-21T00:00:00.000Z"),
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
  } as const;
}

function request(state: "WRITE_IN_FLIGHT" | "WRITE_UNCERTAIN" | "READBACK_VERIFIED") {
  return {
    ...preparation(),
    mutationRequestId: "xmr_update",
    requestId: "caseop:update",
    state,
    authorizationReceipt: {},
    ...(state !== "WRITE_IN_FLIGHT" ? {
      xeroObjectId: targetId,
      writeReceipt: { operation: "UPDATE_QUOTE_DRAFT", quoteId: targetId },
      ...(state === "READBACK_VERIFIED" ? { readbackSnapshot: { status: "DRAFT" } } : {}),
    } : {}),
  } as never;
}

function harness(recovery: boolean, readbackOk = true) {
  const sequence: string[] = [];
  const writeReceipt = { operation: "UPDATE_QUOTE_DRAFT", quoteId: targetId };
  const permit = Object.freeze({}) as never;
  const mutations = {
    prepare: vi.fn(),
    resumeAutonomousRecovery: vi.fn(async () => recovery ? {
      preparation: preparation(),
      claim: { request: request("WRITE_UNCERTAIN"), mode: "RECOVER_ONLY" },
    } : undefined),
    loadAutonomousPreparation: vi.fn(async () => preparation()),
    authoriseAutonomous: vi.fn(async () => ({
      request: request("WRITE_IN_FLIGHT"),
      mode: "CALL_PROVIDER",
      providerWritePermit: permit,
    })),
    recordWriteEvidence: vi.fn(async () => {
      sequence.push("receipt");
      return request("WRITE_UNCERTAIN");
    }),
    rejectProvider: vi.fn(),
    markUnknown: vi.fn(),
    markReadbackVerified: vi.fn(async () => {
      sequence.push("complete");
      return request("READBACK_VERIFIED");
    }),
    recover: vi.fn(async () => {
      sequence.push("recover");
      return { request: request("READBACK_VERIFIED"), outcome: "RECOVERED_VERIFIED" };
    }),
  };
  const accountingProvider = {
    connectionStatus: vi.fn(async () => ({
      connected: true,
      tenant: { id: "tenant", name: "Tenant" },
      scopes: ["accounting.invoices"],
    })),
    resolveContext: vi.fn(async () => ({ actorId: context.actorId, tenantId: "tenant", tenantName: "Tenant" })),
  };
  const commercialProvider = {
    updateQuoteDraft: vi.fn(async (_context, id, updatedAt, payload, mutationId, actualPermit) => {
      sequence.push("write");
      expect({ id, updatedAt, payload, mutationId, actualPermit }).toEqual({
        id: targetId,
        updatedAt: expectedUpdatedAt,
        payload: replacement,
        mutationId: "xmr_update",
        actualPermit: permit,
      });
      return { objectId: targetId, receipt: writeReceipt };
    }),
    readAndVerifyQuoteDraft: vi.fn(async () => {
      sequence.push("readback");
      return readbackOk ? {
        ok: true,
        snapshot: { quoteId: targetId, status: "DRAFT" },
        readbackCanonicalPayload: replacement,
        readbackCanonicalPayloadHash: "0".repeat(64),
      } : {
        ok: false,
        snapshot: { quoteId: targetId, status: "DRAFT" },
        readbackCanonicalPayload: { ...replacement, reference: "DIFFERENT" },
        readbackCanonicalPayloadHash: "9".repeat(64),
        mismatchFields: ["reference"],
      };
    }),
  };
  const service = new XeroDraftDocumentUpdateService(
    accountingProvider as never,
    commercialProvider as never,
    {} as never,
    mutations as never,
    { xeroWriteEnabled: true, xeroAllowedTenantId: "tenant" },
  );
  return { service, mutations, commercialProvider, sequence };
}

describe("XeroDraftDocumentUpdateService", () => {
  it("persists the exact same-ID Quote receipt before canonical readback", async () => {
    const { service, mutations, commercialProvider, sequence } = harness(false);
    const result = await service.execute(context, {
      preparation_id: `xmp_${"1".repeat(32)}`,
      request_id: "caseop:update",
      actionId: "quote.update_draft",
    }, async (actual) => expect(actual).toEqual(envelope));
    expect(result).toMatchObject({
      state: "DRAFT_READBACK_VERIFIED",
      object_type: "QUOTE",
      xero_object_id: targetId,
      mutation_request_id: "xmr_update",
    });
    expect(sequence).toEqual(["write", "receipt", "readback", "complete"]);
    expect(commercialProvider.updateQuoteDraft).toHaveBeenCalledTimes(1);
    expect(mutations.recordWriteEvidence).toHaveBeenCalledWith(context, {
      mutationRequestId: "xmr_update",
      xeroObjectId: targetId,
      writeReceipt: { operation: "UPDATE_QUOTE_DRAFT", quoteId: targetId },
    });
  });

  it("recovers an uncertain update by exact same-ID GET without replaying the provider update", async () => {
    const { service, mutations, commercialProvider, sequence } = harness(true);
    const result = await service.execute(context, {
      preparation_id: `xmp_${"1".repeat(32)}`,
      request_id: "caseop:update",
      actionId: "quote.update_draft",
    }, async () => {
      throw new Error("recovery must not rerun write-time validation");
    });
    expect(commercialProvider.updateQuoteDraft).not.toHaveBeenCalled();
    expect(commercialProvider.readAndVerifyQuoteDraft).toHaveBeenCalledTimes(1);
    expect(commercialProvider.readAndVerifyQuoteDraft).toHaveBeenCalledWith(context, targetId, replacement);
    expect(mutations.authoriseAutonomous).not.toHaveBeenCalled();
    expect(mutations.markReadbackVerified).not.toHaveBeenCalled();
    expect(mutations.recover).toHaveBeenCalledWith(context, {
      mutationRequestId: "xmr_update",
      writeReceipt: { operation: "UPDATE_QUOTE_DRAFT", quoteId: targetId },
      verifiedReadback: {
        xeroObjectId: targetId,
        status: "DRAFT",
        canonicalPayload: envelope,
        evidence: { quoteId: targetId, status: "DRAFT" },
      },
    });
    expect(result).toMatchObject({
      state: "DRAFT_READBACK_VERIFIED",
      xero_object_id: targetId,
      mutation_request_id: "xmr_update",
    });
    expect(sequence).toEqual(["readback", "recover"]);
  });

  it("persists a write-plus-readback mismatch as exact-target uncertain and never classifies it as a fresh retry", async () => {
    const { service, mutations, commercialProvider } = harness(false, false);
    await expect(service.execute(context, {
      preparation_id: `xmp_${"1".repeat(32)}`,
      request_id: "caseop:update",
      actionId: "quote.update_draft",
    }, async () => undefined)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      details: { xeroObjectId: targetId },
    });
    expect(commercialProvider.updateQuoteDraft).toHaveBeenCalledTimes(1);
    expect(mutations.markUnknown).toHaveBeenCalledWith(context, {
      mutationRequestId: "xmr_update",
      xeroObjectId: targetId,
      writeReceipt: { operation: "UPDATE_QUOTE_DRAFT", quoteId: targetId },
    });
    // The separate recovery test above starts from this exact persisted shape
    // and proves only readAndVerifyQuoteDraft is called on resume.
  });
});
