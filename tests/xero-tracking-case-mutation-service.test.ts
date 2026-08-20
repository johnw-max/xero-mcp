import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../src/security/requestContext.js";
import { hashObject } from "../src/security/hash.js";
import { XeroTrackingCaseMutationService } from "../src/services/xeroTrackingCaseMutationService.js";

const categoryId = "11111111-1111-4111-8111-111111111111";
const payload = {
  actionId: "tracking_category.update" as const,
  trackingCategoryId: categoryId,
  name: "Department 2",
};
const receipt = {
  receiptType: "XERO_TRACKING_PROVIDER_RECEIPT" as const,
  providerId: "xero" as const,
  actionId: payload.actionId,
  mutationRequestId: "xmr_tracking",
  idempotencyKey: "xmr_tracking",
  tenantId: "tenant",
  objectId: categoryId,
};
const context = {
  requestId: "request-tracking",
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
    objectType: "TRACKING_CATEGORY",
    operation: "UPDATE",
    targetXeroObjectId: categoryId,
    canonicalPayload: payload,
    canonicalPayloadHash: hashObject(payload),
    sourceRef: "case:tracking",
    sourceUnitKey: "operation-tracking",
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
    mutationRequestId: "xmr_tracking",
    requestId: "caseop:tracking",
    state,
    authorizationReceipt: {},
    ...(state !== "WRITE_IN_FLIGHT" ? {
      xeroObjectId: categoryId,
      writeReceipt: receipt,
      ...(state === "READBACK_VERIFIED" ? {
        readbackSnapshot: { objectId: categoryId, name: payload.name, status: "ACTIVE" },
      } : {}),
    } : {}),
  } as never;
}

function harness(recovery: boolean, exactReadOk = true) {
  const sequence: string[] = [];
  const permit = Object.freeze({}) as never;
  const mutations = {
    resumeAutonomousRecovery: vi.fn(async () => recovery ? {
      preparation: preparation(),
      claim: { request: request("WRITE_UNCERTAIN"), mode: "RECOVER_ONLY" },
    } : undefined),
    loadAutonomousPreparation: vi.fn(async () => preparation()),
    authoriseAutonomous: vi.fn(async (_context, _input, _shape, _receipt, validate) => {
      await validate();
      return { request: request("WRITE_IN_FLIGHT"), mode: "CALL_PROVIDER", providerWritePermit: permit };
    }),
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
      return { request: request("READBACK_VERIFIED"), outcome: "READBACK_VERIFIED" };
    }),
  };
  const provider = {
    validatePreflight: vi.fn(async () => undefined),
    updateCategory: vi.fn(async (_context, actualPayload, mutationId, actualPermit, recordEvidence) => {
      sequence.push("write");
      expect({ actualPayload, mutationId, actualPermit }).toEqual({
        actualPayload: payload,
        mutationId: "xmr_tracking",
        actualPermit: permit,
      });
      await recordEvidence({ objectId: categoryId, receipt });
      sequence.push("provider-inline-readback");
      return {
        actionId: payload.actionId,
        tenantId: "tenant",
        objectId: categoryId,
        name: payload.name,
        status: "ACTIVE",
        receipt,
        readback: { objectId: categoryId, name: payload.name, status: "ACTIVE" },
      };
    }),
    readAndVerify: vi.fn(async () => {
      sequence.push("exact-get");
      if (!exactReadOk) throw Object.assign(new Error("mismatch"), { code: "READBACK_MISMATCH" });
      return { objectId: categoryId, name: payload.name, status: "ACTIVE" as const };
    }),
  };
  return {
    service: new XeroTrackingCaseMutationService(provider as never, mutations as never),
    provider,
    mutations,
    sequence,
  };
}

describe("XeroTrackingCaseMutationService", () => {
  it("persists the provider receipt before any readback and then performs a separate exact GET", async () => {
    const { service, provider, mutations, sequence } = harness(false);
    const result = await service.execute(context, {
      preparation_id: `xmp_${"1".repeat(32)}`,
      request_id: "caseop:tracking",
      actionId: payload.actionId,
    });
    expect(result).toMatchObject({
      state: "READBACK_VERIFIED",
      action_id: payload.actionId,
      xero_object_id: categoryId,
      mutation_request_id: "xmr_tracking",
    });
    expect(sequence).toEqual(["write", "receipt", "provider-inline-readback", "exact-get", "complete"]);
    expect(provider.updateCategory).toHaveBeenCalledTimes(1);
    expect(mutations.recordWriteEvidence).toHaveBeenCalledWith(context, {
      mutationRequestId: "xmr_tracking",
      xeroObjectId: categoryId,
      writeReceipt: receipt,
    });
  });

  it("recovers by exact GET only and uses the durable recover transition", async () => {
    const { service, provider, mutations, sequence } = harness(true);
    const result = await service.execute(context, {
      preparation_id: `xmp_${"1".repeat(32)}`,
      request_id: "caseop:tracking",
      actionId: payload.actionId,
    });
    expect(provider.updateCategory).not.toHaveBeenCalled();
    expect(provider.readAndVerify).toHaveBeenCalledWith(context, payload, categoryId);
    expect(mutations.authoriseAutonomous).not.toHaveBeenCalled();
    expect(mutations.markReadbackVerified).not.toHaveBeenCalled();
    expect(mutations.recover).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual(["exact-get", "recover"]);
    expect(result.state).toBe("READBACK_VERIFIED");
  });

  it("marks a write-plus-exact-read mismatch uncertain with its target and receipt", async () => {
    const { service, provider, mutations } = harness(false, false);
    await expect(service.execute(context, {
      preparation_id: `xmp_${"1".repeat(32)}`,
      request_id: "caseop:tracking",
      actionId: payload.actionId,
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    expect(provider.updateCategory).toHaveBeenCalledTimes(1);
    expect(mutations.markUnknown).toHaveBeenCalledWith(context, {
      mutationRequestId: "xmr_tracking",
      xeroObjectId: categoryId,
      writeReceipt: receipt,
    });
  });
});
