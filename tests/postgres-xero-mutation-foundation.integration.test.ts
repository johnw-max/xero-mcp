import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import type { Logger } from "../src/logging.js";
import type { AccountingProvider, SupplierBillSnapshot } from "../src/providers/types.js";
import { hashObject } from "../src/security/hash.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import { XeroMutationService } from "../src/services/xeroMutationService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres Xero controlled mutation foundation", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;
  const suffix = randomUUID();
  const now = new Date("2026-08-07T09:00:00.000Z");
  const workspaceId = `workspace-xero-mutation-${suffix}`;
  const subjectId = `user-xero-mutation-${suffix}`;
  const tenantId = `tenant-xero-mutation-${suffix}`;
  const installationId = `installation-xero-mutation-${suffix}`;
  const bindingId = `binding-xero-mutation-${suffix}`;
  const connectionId = `connection-xero-mutation-${suffix}`;
  const authorizationId = `authorization-xero-mutation-${suffix}`;
  const agentId = `agent-xero-mutation-${suffix}`;

  beforeAll(async () => {
    if (!databaseUrl || !repository) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
    await expect(repository.readiness()).resolves.toBe(true);
    await repository.saveProviderAuthorization({
      authorizationId,
      workspaceId,
      authorizedBySubject: subjectId,
      provider: "xero",
      grantedScopes: ["accounting.transactions"],
      tokenCiphertext: `encrypted-${suffix}`,
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    await repository.upsertAuthorizedProviderConnection(workspaceId, {
      connectionId,
      authorizationId,
      provider: "xero",
      providerConnectionId: `xero-connection-${suffix}`,
      tenantId,
      tenantName: "Controlled Mutation Test Organisation",
      status: "ACTIVE",
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await repository.saveOAuthInstallation({
      installationId,
      workspaceId,
      subjectType: "USER",
      subjectId,
      agentId,
      clientId: `client-xero-mutation-${suffix}`,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    await repository.saveAgentConnectionBinding({
      bindingId,
      installationId,
      workspaceId,
      subjectType: "USER",
      subjectId,
      agentId,
      connectionId,
      policyId: `policy-xero-mutation-${suffix}`,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    if (!repository) return;
    await repository.pool.query("DELETE FROM posting_requests WHERE tenant_id = $1", [tenantId]);
    await repository.pool.query("DELETE FROM xero_mutation_requests WHERE tenant_id = $1", [tenantId]);
    await repository.pool.query("DELETE FROM xero_mutation_preparations WHERE tenant_id = $1", [tenantId]);
    await repository.pool.query("DELETE FROM agent_connection_bindings WHERE binding_id = $1", [bindingId]);
    await repository.pool.query("DELETE FROM oauth_installations WHERE installation_id = $1", [installationId]);
    await repository.pool.query("DELETE FROM provider_connections WHERE connection_id = $1", [connectionId]);
    await repository.pool.query("DELETE FROM provider_authorizations WHERE authorization_id = $1", [authorizationId]);
    await repository.close();
  });

  function context(overrides: Partial<ResolvedMcpAccessToken> = {}) {
    const token: ResolvedMcpAccessToken = {
      tokenId: `token-xero-mutation-${suffix}`,
      clientId: `client-xero-mutation-${suffix}`,
      resource: "https://mcp.example.test/mcp",
      audience: "https://mcp.example.test/mcp",
      grantedScopes: ["xero.read", "xero.draft.write"],
      issuedAt: now,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      installationId,
      bindingId,
      connectionId,
      authorizationId,
      workspaceId,
      subjectType: "USER",
      subjectId,
      agentId,
      policyId: `policy-xero-mutation-${suffix}`,
      tenantId,
      ...overrides,
    };
    return createOAuthRequestContext({ issuer: "https://mcp.example.test", resolvedToken: token });
  }

  function service() {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    return new XeroMutationService(repository, {
      confirmationSecret: "postgres-confirmation-secret-that-is-at-least-32-bytes",
      now: () => now,
    });
  }

  it.each(["SUPPLIER_BILL", "SALES_INVOICE"] as const)(
    "persists one-time %s DRAFT confirmation through exact readback",
    async (objectType) => {
      if (!repository) throw new Error("TEST_DATABASE_URL is required");
      const mutationService = service();
      const discriminator = `${objectType.toLowerCase()}-${suffix}`;
      const canonicalPayload = { objectType, status: "DRAFT", reference: discriminator };
      const prepared = await mutationService.prepare(context(), {
        objectType,
        operation: "CREATE_DRAFT",
        canonicalPayload,
        sourceRef: `host-upload:${discriminator}`,
        sourceUnitKey: `document:${discriminator}`,
        sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
        confirmationDetails: { reference: discriminator, status: "DRAFT" },
      });
      const confirmed = await mutationService.confirm(context(), {
        preparationId: prepared.preparationId,
        requestId: `confirm-${discriminator}`,
        confirmationPhrase: prepared.confirmationPhrase,
      });
      await expect(mutationService.start(context(), { mutationRequestId: confirmed.mutationRequestId }))
        .resolves.toMatchObject({ mode: "CALL_PROVIDER" });
      const xeroObjectId = `xero-${discriminator}`;
      const writeReceipt = { providerRequestId: `provider-${discriminator}` };
      await mutationService.recordWriteEvidence(context(), {
        mutationRequestId: confirmed.mutationRequestId,
        xeroObjectId,
        writeReceipt,
      });
      await expect(mutationService.markReadbackVerified(context(), {
        mutationRequestId: confirmed.mutationRequestId,
        writeReceipt,
        verifiedReadback: { xeroObjectId, status: "DRAFT", canonicalPayload },
      })).resolves.toMatchObject({
        objectType,
        state: "READBACK_VERIFIED",
        xeroObjectId,
        readbackStatus: "DRAFT",
      });
    },
  );

  it("claims once before one cross-instance invoice Provider create and replays the verified result", async () => {
    if (!databaseUrl || !repository) throw new Error("TEST_DATABASE_URL is required");
    const secondRepository = new PostgresAccountingRepository(databaseUrl);
    try {
      const confirmationSecret = "postgres-invoice-cross-instance-secret-at-least-32-bytes";
      const firstMutations = new XeroMutationService(repository, { confirmationSecret, now: () => now });
      const secondMutations = new XeroMutationService(secondRepository, { confirmationSecret, now: () => now });
      const discriminator = `invoice-cross-instance-${randomUUID()}`;
      const contactId = randomUUID();
      const xeroInvoiceId = randomUUID();
      const canonicalPayload = {
        request_id: `xero-draft:${discriminator}`,
        source_ref: `host-upload:${discriminator}`,
        source_sha256: "9".repeat(64),
        source_evidence_type: "AGENT_ASSERTED_UNVERIFIED" as const,
        contact_id: contactId,
        invoice_date: "2026-08-07",
        due_date: "2026-08-21",
        currency: "HKD",
        reference: `AP-${discriminator}`,
        line_amount_type: "Exclusive" as const,
        lines: [{
          description: "Cross-instance accounting service",
          quantity: 1,
          unit_amount: 43.21,
          account_code: "485",
          tax_type: "NONE",
        }],
      };
      const bill: SupplierBillSnapshot = {
        tenantId,
        invoiceId: xeroInvoiceId,
        type: "ACCPAY",
        status: "DRAFT",
        contact: { contactId, name: "Cross-instance Supplier" },
        invoiceDate: canonicalPayload.invoice_date,
        dueDate: canonicalPayload.due_date,
        currency: canonicalPayload.currency,
        reference: canonicalPayload.reference,
        lineAmountType: canonicalPayload.line_amount_type,
        lines: [{
          description: canonicalPayload.lines[0]!.description,
          quantity: "1.0000",
          unitAmount: "43.2100",
          lineAmount: "43.2100",
          taxAmount: "0.0000",
          accountCode: "485",
          taxType: "NONE",
        }],
        subTotal: "43.2100",
        totalTax: "0.0000",
        total: "43.2100",
      };
      const prepared = await firstMutations.prepare(context(), {
        objectType: "SUPPLIER_BILL",
        operation: "CREATE_DRAFT",
        canonicalPayload,
        sourceRef: canonicalPayload.source_ref,
        sourceUnitKey: `document:${discriminator}`,
        sourceSha256: canonicalPayload.source_sha256,
        sourceEvidenceType: canonicalPayload.source_evidence_type,
        confirmationDetails: { reference: canonicalPayload.reference, status: "DRAFT" },
      });
      const mutationRequestId = `xmr_${hashObject({ preparationId: prepared.preparationId }).slice(0, 32)}`;
      let stateAtProviderCall: string | undefined;
      const createDraftSupplierBill = vi.fn(async () => {
        stateAtProviderCall = (await repository.getXeroMutationRequest(mutationRequestId))?.state;
        await new Promise<void>((resolveProvider) => setTimeout(resolveProvider, 25));
        return {
          bill,
          receipt: { providerRequestId: `provider-${discriminator}`, invoiceId: xeroInvoiceId },
        };
      });
      const provider = {
        resolveContext: vi.fn(async () => ({ actorId: context().actorId, tenantId, tenantName: "Test" })),
        listAccounts: vi.fn(async () => [
          { code: "485", name: "Subscriptions", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" },
        ]),
        listTaxRates: vi.fn(async () => [{
          taxType: "NONE",
          name: "No Tax",
          status: "ACTIVE",
          canApplyToExpenses: true,
        }]),
        getContact: vi.fn(async () => ({ contactId, name: "Cross-instance Supplier", status: "ACTIVE" })),
        createDraftSupplierBill,
      } as unknown as AccountingProvider;
      const logger: Logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const accounting = (repo: PostgresAccountingRepository, mutations: XeroMutationService) =>
        new AccountingService({
          repository: repo,
          provider,
          config: { publicBaseUrl: "https://mcp.example.test", xeroWriteEnabled: true },
          logger,
          connectionTickets: {} as ConnectionTicketService,
          mutationFoundation: mutations,
        });
      const command = {
        preparation_id: prepared.preparationId,
        request_id: `confirm-${discriminator}`,
        confirmation_phrase: prepared.confirmationPhrase,
      };

      const [first, second] = await Promise.all([
        accounting(repository, firstMutations).executePreparedSupplierBillDraft(context(), command),
        accounting(secondRepository, secondMutations).executePreparedSupplierBillDraft(context(), command),
      ]);

      expect(createDraftSupplierBill).toHaveBeenCalledOnce();
      expect(stateAtProviderCall).toBe("WRITE_IN_FLIGHT");
      expect(first.invoiceId).toBe(xeroInvoiceId);
      expect(second.invoiceId).toBe(xeroInvoiceId);
      expect([first.idempotentReplay, second.idempotentReplay]).toContain(true);
      await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
        state: "READBACK_VERIFIED",
        xeroObjectId: xeroInvoiceId,
      });
    } finally {
      await secondRepository.close();
    }
  });

  it("atomically confirms once, never stores phrase plaintext, and preserves mismatch/uncertain source guards", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const mutationService = service();
    const canonicalPayload = { objectType: "QUOTE", status: "DRAFT", reference: `QUOTE-${suffix}` };
    const phrase = `确认创建报价草稿｜校验 ${suffix.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    const prepared = await mutationService.prepare(context(), {
      objectType: "QUOTE",
      operation: "CREATE_DRAFT",
      canonicalPayload,
      sourceRef: `host-upload:${suffix}`,
      sourceUnitKey: "row:quote-primary",
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      confirmationDetails: { reference: `QUOTE-${suffix}` },
      confirmationPhrase: phrase,
    });
    const rawPreparation = await repository.pool.query<{ persisted: string }>(
      "SELECT to_jsonb(preparation)::text AS persisted FROM xero_mutation_preparations preparation WHERE preparation_id = $1",
      [prepared.preparationId],
    );
    expect(rawPreparation.rows[0]?.persisted).not.toContain(phrase);
    expect(rawPreparation.rows[0]?.persisted).not.toContain("CANONICAL_EXTRACTION_FINGERPRINT_NOT_FILE_HASH");

    const confirmation = {
      preparationId: prepared.preparationId,
      requestId: `quote-confirm-${suffix}`,
      confirmationPhrase: prepared.confirmationPhrase,
    };
    const confirmed = await Promise.all([
      mutationService.confirm(context(), confirmation),
      mutationService.confirm(context(), confirmation),
    ]);
    expect(new Set(confirmed.map((request) => request.mutationRequestId)).size).toBe(1);
    const mutationRequestId = confirmed[0]?.mutationRequestId;
    if (!mutationRequestId) throw new Error("confirmation did not return a mutation request");

    await expect(mutationService.start(context(), { mutationRequestId }))
      .resolves.toMatchObject({ mode: "CALL_PROVIDER" });
    const writeReceipt = { providerRequestId: `provider-${suffix}` };
    await expect(mutationService.markReadbackVerified(context(), {
      mutationRequestId,
      writeReceipt,
      verifiedReadback: {
        xeroObjectId: `xero-quote-${suffix}`,
        status: "DRAFT",
        canonicalPayload,
      },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
      state: "WRITE_IN_FLIGHT",
    });
    await mutationService.markUnknown(context(), {
      mutationRequestId,
      xeroObjectId: `xero-quote-${suffix}`,
      writeReceipt,
    });
    await expect(mutationService.markReadbackVerified(context(), {
      mutationRequestId,
      writeReceipt,
      verifiedReadback: {
        xeroObjectId: `xero-quote-${suffix}`,
        status: "AUTHORISED",
        canonicalPayload,
      },
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    const statusMismatch = await repository.getXeroMutationRequest(mutationRequestId);
    expect(statusMismatch).toMatchObject({
      state: "READBACK_MISMATCH",
      readbackStatus: "AUTHORISED",
    });
    expect(statusMismatch?.readbackPayloadHash).toBe(statusMismatch?.canonicalPayloadHash);

    const alteredSameSourceUnit = await mutationService.prepare(context(), {
      objectType: "QUOTE",
      operation: "CREATE_DRAFT",
      canonicalPayload: { ...canonicalPayload, reference: "ALTERED-SAME-SOURCE-ROW" },
      sourceRef: `host-upload:${suffix}`,
      sourceUnitKey: "row:quote-primary",
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      confirmationDetails: { reference: "ALTERED-SAME-SOURCE-ROW" },
    });
    expect(alteredSameSourceUnit.sourceSha256).not.toBe(prepared.sourceSha256);
    await expect(mutationService.confirm(context(), {
      preparationId: alteredSameSourceUnit.preparationId,
      requestId: `quote-altered-same-source-${suffix}`,
      confirmationPhrase: alteredSameSourceUnit.confirmationPhrase,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const duplicate = await mutationService.prepare(context(), {
      objectType: "QUOTE",
      operation: "CREATE_DRAFT",
      canonicalPayload: { ...canonicalPayload, reference: "DUPLICATE" },
      sourceUnitKey: "row:quote-primary",
      sourceSha256: prepared.sourceSha256,
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { reference: "DUPLICATE" },
    });
    await expect(mutationService.confirm(context(), {
      preparationId: duplicate.preparationId,
      requestId: `quote-duplicate-${suffix}`,
      confirmationPhrase: duplicate.confirmationPhrase,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(mutationService.recover(context(), {
      mutationRequestId,
      writeReceipt,
      verifiedReadback: {
        xeroObjectId: `xero-quote-${suffix}`,
        status: "DRAFT",
        canonicalPayload,
      },
    })).resolves.toMatchObject({ outcome: "READBACK_VERIFIED", request: { state: "READBACK_VERIFIED" } });
  });

  it("keeps UPDATE target and canonical source fields immutable at the database boundary", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const mutationService = service();
    const targetXeroObjectId = `xero-item-${suffix}`;
    const prepared = await mutationService.prepare(context(), {
      objectType: "ITEM",
      operation: "UPDATE",
      targetXeroObjectId,
      canonicalPayload: { itemId: targetXeroObjectId, name: "Controlled update" },
      sourceUnitKey: "row:item-update",
      sourceSha256: "b".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { itemId: targetXeroObjectId, changedFields: ["name"] },
    });
    const confirmed = await mutationService.confirm(context(), {
      preparationId: prepared.preparationId,
      requestId: `item-update-${suffix}`,
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await expect(mutationService.start(context(), { mutationRequestId: confirmed.mutationRequestId }))
      .resolves.toMatchObject({ request: { xeroObjectId: targetXeroObjectId } });

    await expect(repository.pool.query(
      "UPDATE xero_mutation_requests SET target_xero_object_id = $2 WHERE mutation_request_id = $1",
      [confirmed.mutationRequestId, `attacker-target-${suffix}`],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(repository.pool.query(
      "UPDATE xero_mutation_preparations SET source_sha256 = $2 WHERE preparation_id = $1",
      [prepared.preparationId, "c".repeat(64)],
    )).rejects.toMatchObject({ code: "23514" });

    const rejectionReceipt = { httpStatus: 400, noWriteConfirmed: true, validationCode: "ITEM_INVALID" };
    await expect(mutationService.rejectProvider(context(), {
      mutationRequestId: confirmed.mutationRequestId,
      providerRejectionReceipt: rejectionReceipt,
    })).resolves.toMatchObject({
      state: "PROVIDER_REJECTED",
      targetXeroObjectId,
      xeroObjectId: targetXeroObjectId,
      providerRejectionReceipt: rejectionReceipt,
    });
  });

  it("stores local validation evidence separately from provider write evidence", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const mutationService = service();
    const prepared = await mutationService.prepare(context(), {
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload: { name: `Contact ${suffix}` },
      sourceUnitKey: "row:contact-validation",
      sourceSha256: "d".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { name: `Contact ${suffix}` },
    });
    const confirmed = await mutationService.confirm(context(), {
      preparationId: prepared.preparationId,
      requestId: `contact-validation-${suffix}`,
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await mutationService.failValidation(context(), {
      mutationRequestId: confirmed.mutationRequestId,
      validationReceipt: { reasonCode: "DUPLICATE_CONTACT_NAME" },
    });
    const row = await repository.pool.query<{
      state: string;
      write_receipt: unknown;
      validation_receipt: unknown;
    }>(
      `SELECT state, write_receipt, validation_receipt
       FROM xero_mutation_requests WHERE mutation_request_id = $1`,
      [confirmed.mutationRequestId],
    );
    expect(row.rows[0]).toEqual({
      state: "FAILED_VALIDATION",
      write_receipt: null,
      validation_receipt: { reasonCode: "DUPLICATE_CONTACT_NAME" },
    });
    await expect(mutationService.failValidation(context(), {
      mutationRequestId: confirmed.mutationRequestId,
      validationReceipt: { reasonCode: "DIFFERENT_REASON" },
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("locks one known Xero object across CREATE and UPDATE, then permits UPDATE after verified CREATE", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const mutationService = service();
    const xeroObjectId = `xero-contact-cross-operation-${suffix}`;
    const createPayload = { name: `Cross operation contact ${suffix}` };
    const createPrepared = await mutationService.prepare(context(), {
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload: createPayload,
      sourceUnitKey: "row:contact-create-cross-operation",
      sourceSha256: "3".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { name: createPayload.name },
    });
    const createConfirmed = await mutationService.confirm(context(), {
      preparationId: createPrepared.preparationId,
      requestId: `contact-create-cross-operation-${suffix}`,
      confirmationPhrase: createPrepared.confirmationPhrase,
    });
    await mutationService.start(context(), { mutationRequestId: createConfirmed.mutationRequestId });
    const createReceipt = { providerRequestId: `contact-create-provider-${suffix}` };
    await mutationService.recordWriteEvidence(context(), {
      mutationRequestId: createConfirmed.mutationRequestId,
      xeroObjectId,
      writeReceipt: createReceipt,
    });

    const updatePayload = { contactId: xeroObjectId, name: `Updated contact ${suffix}` };
    const updatePrepared = await mutationService.prepare(context(), {
      objectType: "CONTACT",
      operation: "UPDATE",
      targetXeroObjectId: xeroObjectId,
      canonicalPayload: updatePayload,
      sourceUnitKey: "row:contact-update-cross-operation",
      sourceSha256: "4".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { contactId: xeroObjectId, changedFields: ["name"] },
    });
    const updateConfirmed = await mutationService.confirm(context(), {
      preparationId: updatePrepared.preparationId,
      requestId: `contact-update-cross-operation-${suffix}`,
      confirmationPhrase: updatePrepared.confirmationPhrase,
    });
    await expect(mutationService.start(context(), { mutationRequestId: updateConfirmed.mutationRequestId }))
      .rejects.toMatchObject({ code: "CONFLICT" });

    await expect(mutationService.recover(context(), {
      mutationRequestId: createConfirmed.mutationRequestId,
      writeReceipt: createReceipt,
      verifiedReadback: {
        xeroObjectId,
        status: "ACTIVE",
        canonicalPayload: createPayload,
        evidence: { providerProjection: "exact" },
      },
    })).resolves.toMatchObject({ outcome: "READBACK_VERIFIED" });
    await expect(mutationService.start(context(), { mutationRequestId: updateConfirmed.mutationRequestId }))
      .resolves.toMatchObject({ mode: "CALL_PROVIDER", request: { xeroObjectId, state: "WRITE_IN_FLIGHT" } });
  });

  it("persists an exact provider rejection and allows a corrected retry for the same source row", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const mutationService = service();
    const baseInput = {
      objectType: "CONTACT" as const,
      operation: "CREATE" as const,
      canonicalPayload: { name: `Rejected contact ${suffix}` },
      sourceUnitKey: "row:provider-rejected-contact",
      sourceSha256: "5".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED" as const,
      confirmationDetails: { name: `Rejected contact ${suffix}` },
    };
    const prepared = await mutationService.prepare(context(), baseInput);
    const confirmed = await mutationService.confirm(context(), {
      preparationId: prepared.preparationId,
      requestId: `provider-rejected-contact-${suffix}`,
      confirmationPhrase: prepared.confirmationPhrase,
    });
    await expect(repository.pool.query(
      `UPDATE xero_mutation_requests
       SET state = 'PROVIDER_REJECTED',
           write_started_at = $2,
           provider_rejected_at = $2,
           provider_rejection_receipt = '{"noWriteConfirmed":true}'::jsonb,
           updated_at = $2
       WHERE mutation_request_id = $1`,
      [confirmed.mutationRequestId, now],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(repository.getXeroMutationRequest(confirmed.mutationRequestId))
      .resolves.toMatchObject({ state: "CONFIRMED" });
    await mutationService.start(context(), { mutationRequestId: confirmed.mutationRequestId });
    const receipt = { httpStatus: 400, xeroErrorNumber: 10, noWriteConfirmed: true };
    await expect(mutationService.rejectProvider(context(), {
      mutationRequestId: confirmed.mutationRequestId,
      providerRejectionReceipt: receipt,
    })).resolves.toMatchObject({ state: "PROVIDER_REJECTED", providerRejectionReceipt: receipt });
    await expect(mutationService.rejectProvider(context(), {
      mutationRequestId: confirmed.mutationRequestId,
      providerRejectionReceipt: { ...receipt, xeroErrorNumber: 11 },
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const corrected = await mutationService.prepare(context(), {
      ...baseInput,
      canonicalPayload: { name: `Corrected contact ${suffix}` },
    });
    await expect(mutationService.confirm(context(), {
      preparationId: corrected.preparationId,
      requestId: `provider-rejected-contact-corrected-${suffix}`,
      confirmationPhrase: corrected.confirmationPhrase,
    })).resolves.toMatchObject({ state: "CONFIRMED" });
  });

  it("derives tenant only from the active binding and rejects token binding alterations", async () => {
    const mutationService = service();
    const tenantClaimIgnored = await mutationService.prepare(context({ tenantId: "attacker-tenant-claim" }), {
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload: { name: `Tenant-bound contact ${suffix}` },
      sourceUnitKey: "row:tenant-bound",
      sourceSha256: "e".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { name: `Tenant-bound contact ${suffix}` },
    });
    expect(tenantClaimIgnored.confirmationSummary.tenantId).toBe(tenantId);

    await expect(mutationService.prepare(context({ installationId: `wrong-installation-${suffix}` }), {
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload: { name: "Wrong installation" },
      sourceUnitKey: "row:wrong-installation",
      sourceSha256: "f".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { name: "Wrong installation" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mutationService.prepare(context({ connectionId: `wrong-connection-${suffix}` }), {
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload: { name: "Wrong connection" },
      sourceUnitKey: "row:wrong-connection",
      sourceSha256: "1".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { name: "Wrong connection" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(mutationService.prepare(context({ subjectId: `wrong-user-${suffix}` }), {
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload: { name: "Wrong actor" },
      sourceUnitKey: "row:wrong-actor",
      sourceSha256: "2".repeat(64),
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationDetails: { name: "Wrong actor" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails readiness when a critical 017 index, trigger, or constraint is renamed", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const checks = [
      {
        renameAway: "ALTER INDEX xero_mutation_requests_active_object_unique_idx RENAME TO xero_mutation_active_object_idx_tampered",
        restore: "ALTER INDEX xero_mutation_active_object_idx_tampered RENAME TO xero_mutation_requests_active_object_unique_idx",
      },
      {
        renameAway: "ALTER TRIGGER xero_mutation_request_immutable_trigger ON xero_mutation_requests RENAME TO xero_mutation_request_immutable_tampered",
        restore: "ALTER TRIGGER xero_mutation_request_immutable_tampered ON xero_mutation_requests RENAME TO xero_mutation_request_immutable_trigger",
      },
      {
        renameAway: "ALTER TABLE xero_mutation_requests RENAME CONSTRAINT xero_mutation_request_readback_binding_check TO xero_mutation_readback_binding_tampered",
        restore: "ALTER TABLE xero_mutation_requests RENAME CONSTRAINT xero_mutation_readback_binding_tampered TO xero_mutation_request_readback_binding_check",
      },
    ];
    for (const check of checks) {
      await repository.pool.query(check.renameAway);
      try {
        await expect(repository.readiness()).resolves.toBe(false);
      } finally {
        await repository.pool.query(check.restore);
      }
      await expect(repository.readiness()).resolves.toBe(true);
    }
  });
});
