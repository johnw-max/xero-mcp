import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../db/inMemoryRepository.js";
import type { PrepareXeroMutationInput } from "../domain/xeroMutationSchemas.js";
import { hashObject } from "../security/hash.js";
import { createLegacySharedBearerRequestContext } from "../security/requestContext.js";
import { XeroMutationService } from "./xeroMutationService.js";

const now = new Date("2026-08-07T08:00:00.000Z");
const canonicalPayload = {
  status: "DRAFT",
  contactId: "11111111-1111-4111-8111-111111111111",
  reference: "QUOTE-001",
};

function quoteInput(
  sourceSha256: string,
  overrides: Partial<PrepareXeroMutationInput> = {},
): PrepareXeroMutationInput {
  return {
    objectType: "QUOTE",
    operation: "CREATE_DRAFT",
    canonicalPayload,
    sourceUnitKey: "row:quote-001",
    sourceSha256,
    sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
    confirmationDetails: { reference: "QUOTE-001", total: "100.00" },
    ...overrides,
  };
}

function harness(options: { currentTime?: { value: Date }; connectionId?: string } = {}) {
  const repository = new InMemoryAccountingRepository();
  const context = createLegacySharedBearerRequestContext({
    actorId: "workspace-test:user:user-test",
    audience: "https://mcp.example.test/mcp",
  });
  const currentTime = options.currentTime ?? { value: now };
  const service = new XeroMutationService(repository, {
    confirmationSecret: "test-confirmation-secret-that-is-at-least-32-bytes",
    now: () => currentTime.value,
    unsafeAllowLegacyContextForTests: true,
    legacyBindingForTests: {
      actorId: context.actorId,
      workspaceId: "workspace-test",
      tenantId: "tenant-test",
      installationId: "installation-test",
      bindingId: "binding-test",
      connectionId: options.connectionId ?? "connection-test",
    },
  });
  return { repository, context, currentTime, service };
}

describe("XeroMutationService controlled mutation foundation", () => {
  it("prepares, explicitly confirms, and starts one draft mutation without storing confirmation plaintext", async () => {
    const { repository, context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("a".repeat(64)));

    expect(prepared).toMatchObject({ state: "PREPARED", objectType: "QUOTE", operation: "CREATE_DRAFT" });
    expect(prepared.confirmationPhrase).toMatch(
      /^CONFIRM-QUOTE｜账套 tenant-test｜挑战 [A-F0-9]{20}｜来源指纹 [A-F0-9]{12}$/,
    );
    expect(JSON.stringify(await repository.getXeroMutationPreparation(prepared.preparationId)))
      .not.toContain(prepared.confirmationPhrase);

    const confirmed = await service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-create-request-001",
      confirmationPhrase: prepared.confirmationPhrase,
    });
    expect(confirmed).toMatchObject({ state: "CONFIRMED", objectType: "QUOTE", operation: "CREATE_DRAFT" });

    const started = await service.start(context, {
      mutationRequestId: confirmed.mutationRequestId,
    });
    expect(started).toMatchObject({ mode: "CALL_PROVIDER", request: { state: "WRITE_IN_FLIGHT" } });
  });

  it("fails closed for a wrong phrase or changed payload, then accepts the untouched preparation once", async () => {
    const { context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("b".repeat(64), {
      confirmationDetails: { reference: "QUOTE-001" },
    }));
    const confirmation = {
      preparationId: prepared.preparationId,
      requestId: "quote-create-request-002",
      confirmationPhrase: prepared.confirmationPhrase,
    };

    await expect(service.confirm(context, {
      ...confirmation,
      confirmationPhrase: `${prepared.confirmationPhrase}-WRONG`,
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(service.confirm(context, {
      ...confirmation,
      canonicalPayload: { ...canonicalPayload, reference: "CHANGED" },
    } as never)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.confirm(context, confirmation, {
      objectType: "PURCHASE_ORDER",
      operation: "CREATE_DRAFT",
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(service.confirm(context, confirmation)).resolves.toMatchObject({ state: "CONFIRMED" });
    await expect(service.confirm(context, confirmation)).resolves.toMatchObject({ state: "CONFIRMED" });
  });

  it("returns one caller-built confirmation phrase, rejects control characters, and never persists plaintext", async () => {
    const { repository, context, service } = harness();
    const payloadHash = hashObject(canonicalPayload);
    const primitivePhrase = `确认创建报价草稿｜金额 USD 100.00｜校验 ${payloadHash.slice(0, 10).toUpperCase()}`;
    const prepared = await service.prepare(context, quoteInput("c".repeat(64), {
      sourceRef: "upload-receipt:quote-003",
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      sourceSha256: undefined,
      confirmationPhrase: primitivePhrase,
    }));

    expect(prepared.confirmationPhrase).toMatch(
      new RegExp(`^${primitivePhrase}｜账套 tenant-test｜挑战 [A-F0-9]{20}｜来源指纹 [A-F0-9]{12}$`),
    );
    expect(prepared.confirmationSummary).toMatchObject({
      sourceRef: "upload-receipt:quote-003",
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      sourceHashSemantics: "CANONICAL_EXTRACTION_FINGERPRINT_NOT_FILE_HASH",
    });
    expect(JSON.stringify(await repository.getXeroMutationPreparation(prepared.preparationId)))
      .not.toContain(primitivePhrase);

    await expect(service.prepare(context, quoteInput("d".repeat(64), {
      confirmationPhrase: "CONFIRM-QUOTE\nINJECTED",
    }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.prepare(context, quoteInput("e".repeat(64), {
      sourceEvidenceType: "HOST_ATTESTED_FILE_RECEIPT",
    }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.prepare(context, quoteInput("f".repeat(64), {
      sourceRef: "https://files.example.test/document?token=secret",
    }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("derives server fingerprints from source ref, row selector, and canonical payload and adds a unique challenge", async () => {
    const { context, service } = harness();
    const customPhrase = "确认创建报价草稿";
    const serverInput = quoteInput("a".repeat(64), {
      sourceRef: "work-material:quote-batch-001",
      sourceUnitKey: "row:7",
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      sourceSha256: undefined,
      confirmationPhrase: customPhrase,
    });
    const first = await service.prepare(context, serverInput);
    const second = await service.prepare(context, serverInput);
    expect(first.sourceSha256).toBe(hashObject({
      semantics: "xero-server-source-fingerprint:v1",
      sourceRef: "work-material:quote-batch-001",
      sourceUnitKey: "row:7",
      canonicalPayload,
    }));
    expect(second.sourceSha256).toBe(first.sourceSha256);
    expect(second.confirmationPhrase).not.toBe(first.confirmationPhrase);
    expect(first.confirmationPhrase).toMatch(
      /^确认创建报价草稿｜账套 tenant-test｜挑战 [A-F0-9]{20}｜来源指纹 [A-F0-9]{12}$/,
    );

    const otherRow = await service.prepare(context, { ...serverInput, sourceUnitKey: "row:8" });
    expect(otherRow.sourceSha256).not.toBe(first.sourceSha256);
    await expect(service.prepare(context, {
      ...serverInput,
      sourceSha256: "f".repeat(64),
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("does not let changed payload content bypass the active opaque source-row guard", async () => {
    const { context, service } = harness();
    const source = {
      sourceRef: "work-material:immutable-row-001",
      sourceUnitKey: "row:12",
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION" as const,
      sourceSha256: undefined,
    };
    const first = await service.prepare(context, quoteInput("a".repeat(64), {
      ...source,
      canonicalPayload: { ...canonicalPayload, reference: "ORIGINAL" },
    }));
    await service.confirm(context, {
      preparationId: first.preparationId,
      requestId: "immutable-source-row-original",
      confirmationPhrase: first.confirmationPhrase,
    });

    const altered = await service.prepare(context, quoteInput("b".repeat(64), {
      ...source,
      canonicalPayload: { ...canonicalPayload, reference: "ALTERED" },
    }));
    expect(altered.sourceSha256).not.toBe(first.sourceSha256);
    await expect(service.confirm(context, {
      preparationId: altered.preparationId,
      requestId: "immutable-source-row-altered",
      confirmationPhrase: altered.confirmationPhrase,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("persists a mismatched readback before reporting it, reserves the source, and recovers without a second write", async () => {
    const { repository, context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("1".repeat(64)));
    const confirmed = await service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-state-machine-001",
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await expect(service.start(context, { mutationRequestId: confirmed.mutationRequestId }))
      .resolves.toMatchObject({ mode: "CALL_PROVIDER", request: { state: "WRITE_IN_FLIGHT" } });
    await expect(service.start(context, { mutationRequestId: confirmed.mutationRequestId }))
      .resolves.toMatchObject({ mode: "RECOVER_ONLY", request: { state: "WRITE_IN_FLIGHT" } });

    const writeReceipt = { providerRequestId: "provider-request-quote-001" };
    await expect(service.markUnknown(context, {
      mutationRequestId: confirmed.mutationRequestId,
      xeroObjectId: "xero-quote-001",
      writeReceipt,
    })).resolves.toMatchObject({ state: "WRITE_UNCERTAIN", xeroObjectId: "xero-quote-001" });

    const mismatchedPayload = { ...canonicalPayload, reference: "WRONG-READBACK" };
    await expect(service.markReadbackVerified(context, {
      mutationRequestId: confirmed.mutationRequestId,
      writeReceipt,
      verifiedReadback: {
        xeroObjectId: "xero-quote-001",
        status: "DRAFT",
        canonicalPayload: mismatchedPayload,
        evidence: { providerProjection: "exact" },
      },
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    await expect(repository.getXeroMutationRequest(confirmed.mutationRequestId))
      .resolves.toMatchObject({ state: "READBACK_MISMATCH", xeroObjectId: "xero-quote-001" });

    const duplicate = await service.prepare(context, quoteInput("1".repeat(64)));
    await expect(service.confirm(context, {
      preparationId: duplicate.preparationId,
      requestId: "quote-state-machine-duplicate",
      confirmationPhrase: duplicate.confirmationPhrase,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(service.start(context, { mutationRequestId: confirmed.mutationRequestId }))
      .resolves.toMatchObject({ mode: "RECOVER_ONLY", request: { state: "READBACK_MISMATCH" } });
    const recovered = await service.recover(context, {
      mutationRequestId: confirmed.mutationRequestId,
      writeReceipt,
      verifiedReadback: {
        xeroObjectId: "xero-quote-001",
        status: "DRAFT",
        canonicalPayload,
        evidence: { providerProjection: "exact" },
      },
    });
    expect(recovered).toMatchObject({
      outcome: "READBACK_VERIFIED",
      request: {
        state: "READBACK_VERIFIED",
        xeroObjectId: "xero-quote-001",
        readbackStatus: "DRAFT",
        readbackCanonicalPayload: canonicalPayload,
        readbackPayloadHash: hashObject(canonicalPayload),
      },
    });
    expect(recovered.request.readbackSnapshotHash).toBe(hashObject(recovered.request.readbackSnapshot));
    expect(recovered.request.readbackSnapshot).toEqual({
      xeroObjectId: "xero-quote-001",
      status: "DRAFT",
      canonicalPayload,
      evidence: { providerProjection: "exact" },
    });
    await expect(service.markReadbackVerified(context, {
      mutationRequestId: confirmed.mutationRequestId,
      writeReceipt: {},
      verifiedReadback: {
        xeroObjectId: "xero-quote-001",
        status: "DRAFT",
        canonicalPayload,
      },
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("durably records exact provider evidence before readback while keeping the mutation recover-only", async () => {
    const { repository, context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("0".repeat(64), {
      sourceUnitKey: "row:quote-write-evidence",
    }));
    const confirmed = await service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-write-evidence-001",
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await service.start(context, { mutationRequestId: confirmed.mutationRequestId });

    const writeReceipt = { providerRequestId: "provider-write-evidence-001" };
    await expect(service.recordWriteEvidence(context, {
      mutationRequestId: confirmed.mutationRequestId,
      xeroObjectId: "xero-quote-write-evidence-001",
      writeReceipt,
    })).resolves.toMatchObject({
      state: "WRITE_IN_FLIGHT",
      xeroObjectId: "xero-quote-write-evidence-001",
      writeReceipt,
    });
    await expect(repository.getXeroMutationRequest(confirmed.mutationRequestId)).resolves.toMatchObject({
      state: "WRITE_IN_FLIGHT",
      xeroObjectId: "xero-quote-write-evidence-001",
      writeReceipt,
    });
    await expect(service.start(context, { mutationRequestId: confirmed.mutationRequestId })).resolves.toMatchObject({
      mode: "RECOVER_ONLY",
      request: { xeroObjectId: "xero-quote-write-evidence-001", writeReceipt },
    });
    await expect(service.recordWriteEvidence(context, {
      mutationRequestId: confirmed.mutationRequestId,
      xeroObjectId: "different-xero-object",
      writeReceipt,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("forbids readback completion from becoming the first durable write-evidence record", async () => {
    const { repository, context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("6".repeat(64), {
      sourceUnitKey: "row:quote-direct-completion-bypass",
    }));
    const confirmed = await service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-direct-completion-bypass",
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await service.start(context, { mutationRequestId: confirmed.mutationRequestId });
    await expect(service.markReadbackVerified(context, {
      mutationRequestId: confirmed.mutationRequestId,
      writeReceipt: { providerRequestId: "must-not-be-first" },
      verifiedReadback: {
        xeroObjectId: "xero-quote-direct-completion",
        status: "DRAFT",
        canonicalPayload,
      },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.getXeroMutationRequest(confirmed.mutationRequestId)).resolves.toMatchObject({
      state: "WRITE_IN_FLIGHT",
    });
    expect(await repository.getXeroMutationRequest(confirmed.mutationRequestId)).not.toHaveProperty("writeReceipt");
  });

  it("persists an unexpected business status as a mismatch instead of reporting a verified draft", async () => {
    const { repository, context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("7".repeat(64), {
      sourceUnitKey: "row:quote-status-mismatch",
    }));
    const confirmed = await service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-status-mismatch-001",
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await service.start(context, { mutationRequestId: confirmed.mutationRequestId });
    const writeReceipt = { providerRequestId: "provider-status-mismatch-001" };
    await service.recordWriteEvidence(context, {
      mutationRequestId: confirmed.mutationRequestId,
      xeroObjectId: "xero-quote-status-mismatch",
      writeReceipt,
    });
    await expect(service.markReadbackVerified(context, {
      mutationRequestId: confirmed.mutationRequestId,
      writeReceipt,
      verifiedReadback: {
        xeroObjectId: "xero-quote-status-mismatch",
        status: "AUTHORISED",
        canonicalPayload,
      },
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    await expect(repository.getXeroMutationRequest(confirmed.mutationRequestId)).resolves.toMatchObject({
      state: "READBACK_MISMATCH",
      readbackStatus: "AUTHORISED",
      readbackPayloadHash: hashObject(canonicalPayload),
    });
  });

  it("binds UPDATE target identity during preparation and never accepts a target at start", async () => {
    const { context, service } = harness();
    const updatePayload = { itemId: "xero-item-001", name: "Updated item" };
    const prepared = await service.prepare(context, {
      objectType: "ITEM",
      operation: "UPDATE",
      targetXeroObjectId: "xero-item-001",
      canonicalPayload: updatePayload,
      sourceUnitKey: "row:item-update-001",
      sourceSha256: "2".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { itemId: "xero-item-001", changedFields: ["name"] },
    });
    const confirmed = await service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "item-update-request-001",
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await expect(service.start(context, {
      mutationRequestId: confirmed.mutationRequestId,
      xeroObjectId: "attacker-selected-item",
    } as never)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.start(context, { mutationRequestId: confirmed.mutationRequestId }))
      .resolves.toMatchObject({
        mode: "CALL_PROVIDER",
        request: { targetXeroObjectId: "xero-item-001", xeroObjectId: "xero-item-001" },
      });
    await expect(service.markUnknown(context, {
      mutationRequestId: confirmed.mutationRequestId,
      xeroObjectId: "different-item",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stores local validation evidence separately and releases the source guard for a corrected request", async () => {
    const { repository, context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("3".repeat(64)));
    const confirmed = await service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-validation-failure-001",
      confirmationPhrase: prepared.confirmationPhrase,
    });
    const failed = await service.failValidation(context, {
      mutationRequestId: confirmed.mutationRequestId,
      validationReceipt: { reasonCode: "ACCOUNT_CODE_INACTIVE" },
    });
    expect(failed).toMatchObject({
      state: "FAILED_VALIDATION",
      validationReceipt: { reasonCode: "ACCOUNT_CODE_INACTIVE" },
    });
    expect(failed).not.toHaveProperty("writeReceipt");
    const persistedFailed = await repository.getXeroMutationRequest(confirmed.mutationRequestId);
    expect(persistedFailed).toMatchObject({ state: "FAILED_VALIDATION" });
    expect(persistedFailed).not.toHaveProperty("writeReceipt");
    await expect(service.failValidation(context, {
      mutationRequestId: confirmed.mutationRequestId,
      validationReceipt: { reasonCode: "ACCOUNT_CODE_INACTIVE" },
    })).resolves.toMatchObject({ state: "FAILED_VALIDATION" });
    await expect(service.failValidation(context, {
      mutationRequestId: confirmed.mutationRequestId,
      validationReceipt: { reasonCode: "DIFFERENT_REASON" },
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const corrected = await service.prepare(context, quoteInput("3".repeat(64), {
      canonicalPayload: { ...canonicalPayload, reference: "QUOTE-001-CORRECTED" },
    }));
    await expect(service.confirm(context, {
      preparationId: corrected.preparationId,
      requestId: "quote-validation-corrected-001",
      confirmationPhrase: corrected.confirmationPhrase,
    })).resolves.toMatchObject({ state: "CONFIRMED" });
  });

  it("records an explicit no-write provider rejection as terminal and releases the row-scoped source guard", async () => {
    const { context, service } = harness();
    const sourceHash = "9".repeat(64);
    const prepared = await service.prepare(context, quoteInput(sourceHash, {
      sourceUnitKey: "row:provider-rejected",
    }));
    const confirmed = await service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-provider-rejected-001",
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await service.start(context, { mutationRequestId: confirmed.mutationRequestId });
    const receipt = { httpStatus: 400, validationCode: "CONTACT_INVALID", noWriteConfirmed: true };
    await expect(service.rejectProvider(context, {
      mutationRequestId: confirmed.mutationRequestId,
      providerRejectionReceipt: receipt,
    })).resolves.toMatchObject({
      state: "PROVIDER_REJECTED",
      providerRejectionReceipt: receipt,
    });
    await expect(service.rejectProvider(context, {
      mutationRequestId: confirmed.mutationRequestId,
      providerRejectionReceipt: receipt,
    })).resolves.toMatchObject({ state: "PROVIDER_REJECTED" });
    await expect(service.rejectProvider(context, {
      mutationRequestId: confirmed.mutationRequestId,
      providerRejectionReceipt: { ...receipt, validationCode: "OTHER" },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.start(context, { mutationRequestId: confirmed.mutationRequestId }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    const corrected = await service.prepare(context, quoteInput(sourceHash, {
      sourceUnitKey: "row:provider-rejected",
      canonicalPayload: { ...canonicalPayload, reference: "QUOTE-001-CORRECTED-AFTER-400" },
    }));
    await expect(service.confirm(context, {
      preparationId: corrected.preparationId,
      requestId: "quote-provider-rejected-corrected",
      confirmationPhrase: corrected.confirmationPhrase,
    })).resolves.toMatchObject({ state: "CONFIRMED" });
  });

  it("consumes one preparation atomically under concurrent exact confirmation", async () => {
    const { context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("4".repeat(64)));
    const confirmation = {
      preparationId: prepared.preparationId,
      requestId: "quote-concurrent-confirm-001",
      confirmationPhrase: prepared.confirmationPhrase,
    };
    const results = await Promise.all([
      service.confirm(context, confirmation),
      service.confirm(context, confirmation),
    ]);
    expect(new Set(results.map((result) => result.mutationRequestId)).size).toBe(1);
    expect(results.every((result) => result.state === "CONFIRMED")).toBe(true);
  });

  it("defaults to OAuth-only and fails closed when installation or connection binding changes", async () => {
    const { repository, context, service } = harness();
    const prepared = await service.prepare(context, quoteInput("5".repeat(64)));
    const oauthOnly = new XeroMutationService(repository, {
      confirmationSecret: "test-confirmation-secret-that-is-at-least-32-bytes",
      now: () => now,
    });
    await expect(oauthOnly.prepare(context, quoteInput("6".repeat(64))))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.prepare(context, {
      ...quoteInput("6".repeat(64)),
      tenantId: "attacker-selected-tenant",
    } as never)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const changedBinding = harness({ connectionId: "connection-other" }).service;
    await expect(changedBinding.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-wrong-binding-001",
      confirmationPhrase: prepared.confirmationPhrase,
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(service.confirm(context, {
      preparationId: `xmp_${"0".repeat(32)}`,
      requestId: "quote-unknown-preparation",
      confirmationPhrase: prepared.confirmationPhrase,
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("expires confirmation without creating a mutation request", async () => {
    const clock = { value: now };
    const { repository, context, service } = harness({ currentTime: clock });
    const prepared = await service.prepare(context, quoteInput("7".repeat(64)));
    clock.value = new Date(now.getTime() + 5 * 60 * 1_000 + 1);
    await expect(service.confirm(context, {
      preparationId: prepared.preparationId,
      requestId: "quote-expired-confirmation",
      confirmationPhrase: prepared.confirmationPhrase,
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    const expired = await repository.getXeroMutationPreparation(prepared.preparationId);
    expect(expired).toMatchObject({ state: "EXPIRED" });
    expect(expired).not.toHaveProperty("consumedAt");
  });

  it.each([
    ["SUPPLIER_BILL", "CREATE_DRAFT"],
    ["SALES_INVOICE", "CREATE_DRAFT"],
    ["QUOTE", "CREATE_DRAFT"],
    ["PURCHASE_ORDER", "CREATE_DRAFT"],
    ["CREDIT_NOTE", "CREATE_DRAFT"],
    ["MANUAL_JOURNAL", "CREATE_DRAFT"],
    ["CONTACT", "CREATE"],
    ["CONTACT", "UPDATE"],
    ["ITEM", "CREATE"],
    ["ITEM", "UPDATE"],
    ["ATTACHMENT", "UPLOAD"],
  ] as const)("accepts the controlled %s %s foundation contract", async (objectType, operation) => {
    const { context, service } = harness();
    const discriminator = `${objectType}:${operation}`;
    const targetXeroObjectId = operation === "UPDATE" ? `target-${objectType.toLowerCase()}` : undefined;
    await expect(service.prepare(context, {
      objectType,
      operation,
      ...(targetXeroObjectId ? { targetXeroObjectId } : {}),
      canonicalPayload: { discriminator },
      sourceUnitKey: `row:${discriminator}`,
      sourceSha256: hashObject({ discriminator }),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { discriminator },
    })).resolves.toMatchObject({ objectType, operation });
  });

  it("rejects object-operation combinations outside the controlled matrix", async () => {
    const { context, service } = harness();
    await expect(service.prepare(context, {
      objectType: "QUOTE",
      operation: "CREATE",
      canonicalPayload: { reference: "unsafe-final-quote" },
      sourceUnitKey: "row:unsafe-final-quote",
      sourceSha256: "8".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { reference: "unsafe-final-quote" },
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
