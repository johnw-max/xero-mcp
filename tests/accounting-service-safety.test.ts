import { describe, expect, it, vi } from "vitest";
import {
  canonicalBillForApproval,
  canonicalDraftExtractionFingerprint,
  canonicalDraftRequest,
} from "../src/domain/canonical.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import type { AuthoriseSupplierBillInput, CreateDraftSupplierBillInput } from "../src/domain/schemas.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import { AppError } from "../src/errors.js";
import type { Logger } from "../src/logging.js";
import type {
  AccountingPrincipal,
  AccountingProvider,
  RecordProviderDraftWriteEvidence,
  SupplierBillSnapshot,
} from "../src/providers/types.js";
import { hashObject, sha256 } from "../src/security/hash.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { AccountingService } from "../src/services/accountingService.js";
import type { ConnectionTicketService } from "../src/services/connectionTicketService.js";

const actorId = "actor-a";
const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherTenantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const invoiceId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const postingRequestId = "pr_abcdefghijklmnop";
const approvalRef = "a".repeat(43);

const draftInput: CreateDraftSupplierBillInput = {
  request_id: "request-create-a",
  source_ref: "synthetic://invoice-a",
  source_sha256: "1".repeat(64),
  source_evidence_type: "AGENT_ASSERTED_UNVERIFIED",
  user_confirmation: "CONFIRMED_FOR_DRAFT",
  contact_id: contactId,
  invoice_date: "2026-08-03",
  due_date: "2026-08-17",
  currency: "SGD",
  reference: "ZC-XERO-DEMO-QA",
  authoritative_provider_field: "INVOICE_NUMBER",
  line_amount_type: "Inclusive",
  lines: [{
    description: "Synthetic software subscription",
    quantity: 1,
    unit_amount: 109,
    account_code: "404",
    tax_type: "NONE",
  }],
};

const draftBill: SupplierBillSnapshot = {
  tenantId,
  invoiceId,
  type: "ACCPAY",
  status: "DRAFT",
  contact: { contactId, name: "Synthetic supplier" },
  invoiceDate: "2026-08-03",
  dueDate: "2026-08-17",
  currency: "SGD",
  invoiceNumber: "ZC-XERO-DEMO-QA",
  lineAmountType: "Inclusive",
  lines: [{
    description: "Synthetic software subscription",
    quantity: "1.0000",
    unitAmount: "109.0000",
    lineAmount: "109.0000",
    taxAmount: "0.0000",
    accountCode: "404",
    taxType: "NONE",
  }],
  subTotal: "109.0000",
  totalTax: "0.0000",
  total: "109.0000",
};

const authorisedBill: SupplierBillSnapshot = { ...draftBill, status: "AUTHORISED" };

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("draft source evidence and user confirmation", () => {
  it("binds both fields into the canonical request", () => {
    expect(canonicalDraftRequest(tenantId, draftInput)).toMatchObject({
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      userConfirmation: "CONFIRMED_FOR_DRAFT",
    });
  });
});

function service(
  repository: InMemoryAccountingRepository,
  provider: AccountingProvider,
  writePolicy: { enabled: boolean; allowedTenantId?: string },
): AccountingService {
  return new AccountingService({
    repository,
    provider,
    config: {
      publicBaseUrl: "https://xero-mcp.example.test",
      xeroWriteEnabled: writePolicy.enabled,
      ...(writePolicy.allowedTenantId ? { xeroAllowedTenantId: writePolicy.allowedTenantId } : {}),
    },
    logger,
    connectionTickets: {} as ConnectionTicketService,
    unsafeAllowDirectMutationForTests: true,
  });
}

function oauthPrincipal(scopes: string[], agentId = "agent-a") {
  const now = new Date();
  const resolvedToken: ResolvedMcpAccessToken = {
    tokenId: `oauth-token-${agentId}`,
    clientId: "agent2-accounting-mcp",
    resource: "https://xero-mcp.example.test/mcp",
    audience: "https://xero-mcp.example.test/mcp",
    grantedScopes: scopes,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 900_000),
    installationId: `installation-${agentId}`,
    bindingId: `binding-${agentId}`,
    connectionId: "connection-a",
    bindingRevision: 1,
    authorizationId: "authorization-a",
    workspaceId: "workspace-a",
    subjectType: "USER",
    subjectId: "user-a",
    agentId,
    policyId: "policy-a",
    tenantId,
  };
  return createOAuthRequestContext({
    issuer: "https://xero-mcp.example.test",
    resolvedToken,
  });
}

describe("Xero connection lifecycle guidance", () => {
  it("keeps one exact organisation bound and requires fresh user OAuth for an organisation change", async () => {
    const repository = new InMemoryAccountingRepository();
    const provider = {
      connectionStatus: vi.fn(async () => ({
        connected: true,
        tenant: { id: tenantId, name: "Synthetic Trial Co" },
        scopes: ["accounting.settings"],
        tokenExpiresAt: "2026-08-08T12:30:00.000Z",
      })),
    } as unknown as AccountingProvider;

    const result = await service(repository, provider, { enabled: false })
      .connectionStatus(oauthPrincipal(["xero.read"]));

    expect(result).toMatchObject({
      connected: true,
      tenant: { name: "Synthetic Trial Co" },
      connectionLifecycle: {
        organisationBinding: "ONE_IMMUTABLE_ORGANISATION_PER_TARGET_SESSION",
        currentTenantMeaning: "COMPATIBILITY_POINTER_NOT_LEDGER_TARGET",
        targetSessionLifetime: "SHORT_LIVED_SERVER_ENFORCED",
        accessTokenRefresh: "AUTOMATIC_NO_USER_ACTION",
        organisationChange: {
          supported: true,
          requiresFreshXeroOAuth: "ONLY_IF_ORGANISATION_NOT_ALREADY_AUTHORISED",
          silentChatSwitchAllowed: false,
          hostSteps: [
            "ASK_AGENT_TO_SWITCH_XERO_ORGANISATION",
            "OPEN_SHORT_LIVED_CONFIRMATION_LINK",
            "SELECT_EXACTLY_ONE_XERO_ORGANISATION",
            "PIN_SELECTED_ORGANISATION",
            "VERIFY_WITH_PINNED_ORGANISATION_READ",
          ],
        },
      },
    });
  });
});

async function approvedPosting(repository: InMemoryAccountingRepository): Promise<string> {
  const payloadHash = hashObject(canonicalBillForApproval(draftBill));
  await repository.createOrGetPosting({
    postingRequestId,
    actorId,
    tenantId,
    sourceRef: draftInput.source_ref,
    sourceSha256: draftInput.source_sha256,
    sourceEvidenceType: draftInput.source_evidence_type,
    providerPayload: draftBill as unknown as Record<string, unknown>,
    requestPayloadHash: "2".repeat(64),
    providerPayloadHash: payloadHash,
    requestId: draftInput.request_id,
    createIdempotencyKey: "create-key-a",
  });
  await repository.markDraftCreated(postingRequestId, {
    xeroInvoiceId: invoiceId,
    providerPayload: draftBill as unknown as Record<string, unknown>,
    providerPayloadHash: payloadHash,
    writeReceipt: { operation: "CREATE_DRAFT", invoiceId },
    readbackSnapshot: draftBill as unknown as Record<string, unknown>,
  });
  await repository.approvePosting(
    postingRequestId,
    actorId,
    sha256(approvalRef),
    new Date(Date.now() + 60_000),
    new Date(),
  );
  return payloadHash;
}

describe("authorise monotonicity", () => {
  it("performs one provider write and keeps the verified terminal state under deterministic concurrency", async () => {
    const repository = new InMemoryAccountingRepository();
    const approvedPayloadHash = await approvedPosting(repository);
    let providerStatus: "DRAFT" | "AUTHORISED" = "DRAFT";
    let releaseProvider!: () => void;
    let signalProviderStarted!: () => void;
    const providerReleased = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerStarted = new Promise<void>((resolve) => { signalProviderStarted = resolve; });
    const getSupplierBill = vi.fn(async () => providerStatus === "DRAFT" ? draftBill : authorisedBill);
    const authoriseSupplierBill = vi.fn(async () => {
      providerStatus = "AUTHORISED";
      signalProviderStarted();
      await providerReleased;
      return {
        bill: authorisedBill,
        receipt: { operation: "AUTHORISE", invoiceId, providerRequestId: "xero-authorise-a" },
      };
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      getSupplierBill,
      authoriseSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });
    const input: AuthoriseSupplierBillInput = {
      posting_request_id: postingRequestId,
      invoice_id: invoiceId,
      expected_status: "DRAFT",
      approval_ref: approvalRef,
      approved_payload_hash: approvedPayloadHash,
      request_id: "request-authorise-a",
    };

    const first = accounting.authoriseSupplierBill(actorId, input);
    await providerStarted;

    await expect(accounting.authoriseSupplierBill(actorId, {
      ...input,
      request_id: "request-authorise-b",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(authoriseSupplierBill).toHaveBeenCalledTimes(1);

    const second = accounting.authoriseSupplierBill(actorId, input);
    const secondResult = await second;
    releaseProvider();
    const firstResult = await first;

    expect(authoriseSupplierBill).toHaveBeenCalledTimes(1);
    expect([firstResult.invoiceId, secondResult.invoiceId]).toEqual([invoiceId, invoiceId]);
    expect(firstResult.verified).toBe(true);
    expect(secondResult.verified).toBe(true);
    const terminalPosting = await repository.getPosting(postingRequestId);
    expect(terminalPosting).toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      xeroInvoiceId: invoiceId,
      readbackSnapshot: { status: "AUTHORISED" },
      draftWriteReceipt: { operation: "CREATE_DRAFT", invoiceId },
      draftReadbackSnapshot: { status: "DRAFT" },
      authoriseWriteReceipt: { invoiceId },
      authoriseReadbackSnapshot: { status: "AUTHORISED" },
    });
    expect(["AUTHORISE", "AUTHORISE_RECOVERED_BY_READBACK"])
      .toContain(terminalPosting?.authoriseWriteReceipt?.operation);
  });

  it("replays a completed create with the original CREATE_DRAFT receipt after later authorisation", async () => {
    const repository = new InMemoryAccountingRepository();
    const createDraftSupplierBill = vi.fn().mockResolvedValue({
      bill: draftBill,
      receipt: { operation: "CREATE_DRAFT", invoiceId, providerRequestId: "xero-create-a" },
    });
    const authoriseSupplierBill = vi.fn().mockResolvedValue({
      bill: authorisedBill,
      receipt: { operation: "AUTHORISE", invoiceId, providerRequestId: "xero-authorise-a" },
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      getSupplierBill: vi.fn().mockResolvedValue(draftBill),
      createDraftSupplierBill,
      authoriseSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    const created = await accounting.createDraftSupplierBill(actorId, draftInput);
    await repository.approvePosting(
      created.postingRequestId,
      actorId,
      sha256(approvalRef),
      new Date(Date.now() + 60_000),
      new Date(),
    );
    await accounting.authoriseSupplierBill(actorId, {
      posting_request_id: created.postingRequestId,
      invoice_id: invoiceId,
      expected_status: "DRAFT",
      approval_ref: approvalRef,
      approved_payload_hash: created.approvedPayloadHash,
      request_id: "request-authorise-create-replay",
    });

    const replay = await accounting.createDraftSupplierBill(actorId, draftInput);
    expect(replay).toMatchObject({
      idempotentReplay: true,
      invoiceId,
      status: "AUTHORISED",
      providerReceipt: { operation: "CREATE_DRAFT", invoiceId, providerRequestId: "xero-create-a" },
    });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
    expect(authoriseSupplierBill).toHaveBeenCalledOnce();
  });

  it("keeps a Provider success with failed durable completion on the readback-only recovery path", async () => {
    const repository = new InMemoryAccountingRepository();
    const approvedPayloadHash = await approvedPosting(repository);
    const completeAuthorise = vi.spyOn(repository, "completeAuthorise")
      .mockRejectedValueOnce(new Error("database unavailable after Provider success"));
    const getSupplierBill = vi.fn().mockResolvedValueOnce(draftBill).mockResolvedValue(authorisedBill);
    const authoriseSupplierBill = vi.fn().mockResolvedValue({
      bill: authorisedBill,
      receipt: { operation: "AUTHORISE", invoiceId, providerRequestId: "xero-authorise-a" },
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      getSupplierBill,
      authoriseSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });
    const input: AuthoriseSupplierBillInput = {
      posting_request_id: postingRequestId,
      invoice_id: invoiceId,
      expected_status: "DRAFT",
      approval_ref: approvalRef,
      approved_payload_hash: approvedPayloadHash,
      request_id: "request-authorise-a",
    };

    await expect(accounting.authoriseSupplierBill(actorId, input)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
    });
    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN",
      authoriseRequestId: "request-authorise-a",
      xeroInvoiceId: invoiceId,
    });
    expect(authoriseSupplierBill).toHaveBeenCalledTimes(1);

    const recovered = await accounting.authoriseSupplierBill(actorId, input);
    expect(recovered).toMatchObject({ verified: true, idempotentReplay: true, invoiceId });
    expect(authoriseSupplierBill).toHaveBeenCalledTimes(1);
    expect(completeAuthorise).toHaveBeenCalledTimes(2);
    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({
      state: "AUTHORISED_READBACK_VERIFIED",
      xeroInvoiceId: invoiceId,
    });
  });
});

describe("draft recovery monotonicity", () => {
  it("persists the AP InvoiceID and Provider receipt before the Provider starts readback", async () => {
    const repository = new InMemoryAccountingRepository();
    let evidenceBeforeReadback: unknown;
    const receipt = { operation: "CREATE_DRAFT", invoiceId, providerRequestId: "provider-before-get" };
    const createDraftSupplierBill = vi.fn(async (
      _principal: AccountingPrincipal,
      _input: CreateDraftSupplierBillInput,
      _idempotencyKey: string,
      recordWriteEvidence?: RecordProviderDraftWriteEvidence,
    ) => {
      if (!recordWriteEvidence) throw new Error("write-evidence callback was not supplied");
      await recordWriteEvidence({ invoiceId, receipt });
      evidenceBeforeReadback = await repository.findActivePostingDuplicate({
        tenantId,
        sourceSha256: draftInput.source_sha256,
        contactId: contactId.toLowerCase(),
        normalizedReference: draftInput.reference.toLowerCase(),
      });
      return { bill: draftBill, receipt };
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    const completed = await accounting.createDraftSupplierBill(actorId, draftInput);
    expect(evidenceBeforeReadback).toMatchObject({
      state: "WRITE_RESULT_UNKNOWN",
      xeroInvoiceId: invoiceId,
      writeReceipt: receipt,
      draftWriteReceipt: receipt,
    });
    expect(completed).toMatchObject({ invoiceId, readbackVerified: true, idempotentReplay: false });
    await expect(repository.getPosting(completed.postingRequestId)).resolves.toMatchObject({
      state: "APPROVAL_PENDING",
      xeroInvoiceId: invoiceId,
      writeReceipt: receipt,
    });
  });

  it("keeps a verified Provider DRAFT reserved when durable completion throws a plain database error", async () => {
    const repository = new InMemoryAccountingRepository();
    vi.spyOn(repository, "markDraftCreated")
      .mockRejectedValueOnce(new Error("database unavailable after verified Provider DRAFT"));
    const createDraftSupplierBill = vi.fn().mockResolvedValue({
      bill: draftBill,
      receipt: { operation: "CREATE_DRAFT", invoiceId },
    });
    const getSupplierBill = vi.fn().mockResolvedValue(draftBill);
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill,
      getSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill(actorId, draftInput)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
      details: { invoiceId },
    });
    const uncertain = await repository.findActivePostingDuplicate({
      tenantId,
      sourceSha256: draftInput.source_sha256,
      contactId: contactId.toLowerCase(),
      normalizedReference: draftInput.reference.toLowerCase(),
    });
    expect(uncertain).toMatchObject({ state: "WRITE_RESULT_UNKNOWN", xeroInvoiceId: invoiceId });

    await expect(accounting.createDraftSupplierBill(actorId, {
      ...draftInput,
      request_id: "new-request-after-durable-completion-loss",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { duplicateState: "WRITE_RESULT_UNKNOWN" },
    });

    const recovered = await accounting.createDraftSupplierBill(actorId, draftInput);
    expect(recovered).toMatchObject({ invoiceId, idempotentReplay: true, status: "DRAFT" });
    expect(createDraftSupplierBill).toHaveBeenCalledTimes(1);
    expect(getSupplierBill).toHaveBeenCalledTimes(1);
    await expect(repository.getPosting(recovered.postingRequestId)).resolves.toMatchObject({
      state: "APPROVAL_PENDING",
      xeroInvoiceId: invoiceId,
    });
  });

  it("preserves the original readback mismatch when a faster recovery already entered AUTHORISING", async () => {
    const repository = new InMemoryAccountingRepository();
    const canonicalRequest = canonicalDraftRequest(tenantId, draftInput);
    const requestPayloadHash = hashObject(canonicalRequest);
    const approvedPayloadHash = hashObject(canonicalBillForApproval(draftBill));
    await repository.createOrGetPosting({
      postingRequestId,
      actorId,
      tenantId,
      sourceRef: draftInput.source_ref,
      sourceSha256: draftInput.source_sha256,
      sourceEvidenceType: draftInput.source_evidence_type,
      providerPayload: canonicalRequest,
      requestPayloadHash,
      providerPayloadHash: requestPayloadHash,
      requestId: draftInput.request_id,
      createIdempotencyKey: "create-key-a",
    });
    await repository.markDraftWriteUnknown(postingRequestId, invoiceId);

    const getSupplierBill = vi.fn(async () => {
      await repository.recoverDraftCreated(postingRequestId, {
        xeroInvoiceId: invoiceId,
        providerPayload: draftBill as unknown as Record<string, unknown>,
        providerPayloadHash: approvedPayloadHash,
        writeReceipt: { operation: "CREATE_DRAFT_RECOVERED_BY_FASTER_REQUEST", invoiceId },
        readbackSnapshot: draftBill as unknown as Record<string, unknown>,
      });
      await repository.approvePosting(
        postingRequestId,
        actorId,
        sha256(approvalRef),
        new Date(Date.now() + 60_000),
        new Date(),
      );
      await repository.beginAuthorise({
        postingRequestId,
        actorId,
        tenantId,
        invoiceId,
        approvalRefHash: sha256(approvalRef),
        approvedPayloadHash,
        requestId: "request-authorise-race-winner",
        idempotencyKey: "authorise-race-winner",
        now: new Date(),
      });
      return authorisedBill;
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      getSupplierBill,
      createDraftSupplierBill: vi.fn(),
      authoriseSupplierBill: vi.fn(),
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill(actorId, draftInput)).rejects.toMatchObject({
      code: "READBACK_MISMATCH",
    });
    await expect(repository.getPosting(postingRequestId)).resolves.toMatchObject({
      state: "AUTHORISING",
      authoriseRequestId: "request-authorise-race-winner",
      xeroInvoiceId: invoiceId,
      readbackSnapshot: { invoiceId, status: "DRAFT" },
    });
    expect(provider.createDraftSupplierBill).not.toHaveBeenCalled();
    expect(provider.authoriseSupplierBill).not.toHaveBeenCalled();
  });
});

describe("exact-tenant write gate", () => {
  it("rejects a forged server extraction fingerprint before accounting validation or write", async () => {
    const repository = new InMemoryAccountingRepository();
    const listAccounts = vi.fn();
    const createDraftSupplierBill = vi.fn();
    const resolveContext = vi.fn();
    const createOrGetPosting = vi.spyOn(repository, "createOrGetPosting");
    const provider = {
      resolveContext,
      listAccounts,
      listTaxRates: vi.fn(),
      getContact: vi.fn(),
      createDraftSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill(actorId, {
      ...draftInput,
      source_evidence_type: "SERVER_FINGERPRINTED_EXTRACTION",
      source_sha256: "f".repeat(64),
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(resolveContext).not.toHaveBeenCalled();
    expect(createOrGetPosting).not.toHaveBeenCalled();
    expect(listAccounts).not.toHaveBeenCalled();
    expect(createDraftSupplierBill).not.toHaveBeenCalled();
  });

  it("turns a create-time duplicate race into CONFLICT without a second provider write", async () => {
    const repository = new InMemoryAccountingRepository();
    const canonicalRequest = canonicalDraftRequest(tenantId, draftInput);
    await repository.createOrGetPosting({
      postingRequestId,
      actorId,
      tenantId,
      sourceRef: draftInput.source_ref,
      sourceSha256: draftInput.source_sha256,
      sourceEvidenceType: draftInput.source_evidence_type,
      providerPayload: canonicalRequest,
      requestPayloadHash: hashObject(canonicalRequest),
      providerPayloadHash: hashObject(canonicalRequest),
      requestId: draftInput.request_id,
      createIdempotencyKey: "create-race-winner",
    });
    vi.spyOn(repository, "findActivePostingDuplicate").mockResolvedValueOnce(undefined);
    const createDraftSupplierBill = vi.fn();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill(actorId, {
      ...draftInput,
      request_id: "request-create-racing-loser",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        duplicatePostingRequestId: postingRequestId,
        duplicateState: "VALIDATED",
      },
    });
    expect(createDraftSupplierBill).not.toHaveBeenCalled();
  });

  it("keeps a created-but-mismatched Xero readback active so a new request cannot create a duplicate", async () => {
    const repository = new InMemoryAccountingRepository();
    const createDraftSupplierBill = vi.fn().mockResolvedValue({
      bill: { ...draftBill, invoiceNumber: "XERO-MISMATCHED-REFERENCE" },
      receipt: { operation: "CREATE_DRAFT", invoiceId },
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill(actorId, draftInput)).rejects.toMatchObject({
      code: "READBACK_MISMATCH",
    });
    await expect(repository.findActivePostingDuplicate({
      tenantId,
      sourceSha256: draftInput.source_sha256,
      contactId: contactId.toLowerCase(),
      normalizedReference: draftInput.reference.toLowerCase(),
    })).resolves.toMatchObject({
      state: "READBACK_MISMATCH",
      xeroInvoiceId: invoiceId,
      writeReceipt: { operation: "CREATE_DRAFT", invoiceId },
      draftWriteReceipt: { operation: "CREATE_DRAFT", invoiceId },
      readbackSnapshot: { invoiceId, invoiceNumber: "XERO-MISMATCHED-REFERENCE" },
      draftReadbackSnapshot: { invoiceId, invoiceNumber: "XERO-MISMATCHED-REFERENCE" },
    });

    await expect(accounting.createDraftSupplierBill(actorId, {
      ...draftInput,
      request_id: "request-after-readback-mismatch",
    })).rejects.toMatchObject({ code: "CONFLICT", details: { duplicateState: "READBACK_MISMATCH" } });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
  });

  it("fails closed as WRITE_RESULT_UNKNOWN if mismatched DRAFT evidence cannot be persisted", async () => {
    const repository = new InMemoryAccountingRepository();
    vi.spyOn(repository, "markDraftReadbackMismatch")
      .mockRejectedValueOnce(new Error("database unavailable while preserving mismatch evidence"));
    const createDraftSupplierBill = vi.fn().mockResolvedValue({
      bill: { ...draftBill, invoiceNumber: "XERO-MISMATCHED-REFERENCE" },
      receipt: { operation: "CREATE_DRAFT", invoiceId },
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill(actorId, draftInput)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
      details: { invoiceId },
    });
    await expect(repository.findActivePostingDuplicate({
      tenantId,
      sourceSha256: draftInput.source_sha256,
      contactId: contactId.toLowerCase(),
      normalizedReference: draftInput.reference.toLowerCase(),
    })).resolves.toMatchObject({
      state: "WRITE_RESULT_UNKNOWN",
      xeroInvoiceId: invoiceId,
    });
    expect(createDraftSupplierBill).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled create", false, tenantId, "create"],
    ["wrong-tenant create", true, otherTenantId, "create"],
    ["disabled authorise", false, tenantId, "authorise"],
    ["wrong-tenant authorise", true, otherTenantId, "authorise"],
  ] as const)("blocks %s before validation or any provider write", async (_label, enabled, allowedTenantId, operation) => {
    const repository = new InMemoryAccountingRepository();
    const listAccounts = vi.fn();
    const listTaxRates = vi.fn();
    const getContact = vi.fn();
    const getSupplierBill = vi.fn();
    const createDraftSupplierBill = vi.fn();
    const authoriseSupplierBill = vi.fn();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts,
      listTaxRates,
      getContact,
      getSupplierBill,
      createDraftSupplierBill,
      authoriseSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled, allowedTenantId });

    const invocation = operation === "create"
      ? accounting.createDraftSupplierBill(actorId, draftInput)
      : accounting.authoriseSupplierBill(actorId, {
        posting_request_id: postingRequestId,
        invoice_id: invoiceId,
        expected_status: "DRAFT",
        approval_ref: approvalRef,
        approved_payload_hash: "3".repeat(64),
        request_id: "request-authorise-a",
      });

    await expect(invocation).rejects.toMatchObject({
      code: enabled ? "STANDING_DELEGATION_REQUIRED" : "WRITE_GATE_DISABLED",
    });
    expect(listAccounts).not.toHaveBeenCalled();
    expect(listTaxRates).not.toHaveBeenCalled();
    expect(getContact).not.toHaveBeenCalled();
    expect(getSupplierBill).not.toHaveBeenCalled();
    expect(createDraftSupplierBill).not.toHaveBeenCalled();
    expect(authoriseSupplierBill).not.toHaveBeenCalled();
  });

  it("lets a bound OAuth draft write ignore the legacy global tenant allowlist", async () => {
    const repository = new InMemoryAccountingRepository();
    const principal = oauthPrincipal(["xero.read", "xero.draft.write"]);
    const serverFingerprintInput: CreateDraftSupplierBillInput = {
      ...draftInput,
      source_evidence_type: "SERVER_FINGERPRINTED_EXTRACTION",
      source_sha256: hashObject(canonicalDraftExtractionFingerprint(draftInput)),
    };
    const createOrGetPosting = vi.spyOn(repository, "createOrGetPosting");
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: principal.actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill: vi.fn().mockResolvedValue({
        bill: draftBill,
        receipt: { operation: "CREATE_DRAFT", invoiceId },
      }),
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: otherTenantId });

    const created = await accounting.createDraftSupplierBill(principal, serverFingerprintInput);
    expect(created).toMatchObject({
      invoiceId,
      status: "DRAFT",
      providerReceipt: { operation: "CREATE_DRAFT", invoiceId },
      readbackVerified: true,
    });
    await expect(repository.getPosting(created.postingRequestId)).resolves.toMatchObject({
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
    });
    expect(createOrGetPosting).toHaveBeenCalledWith(expect.objectContaining({
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      providerPayload: expect.objectContaining({
        sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
        userConfirmation: "CONFIRMED_FOR_DRAFT",
      }),
    }));
    expect(provider.resolveContext).toHaveBeenCalledWith(principal);
    expect(provider.createDraftSupplierBill).toHaveBeenCalledWith(
      principal,
      serverFingerprintInput,
      expect.any(String),
      expect.any(Function),
      undefined,
      undefined,
    );
  });

  it("keeps the AP duplicate guard after a generic provider error without definite Xero rejection evidence", async () => {
    const repository = new InMemoryAccountingRepository();
    const createDraftSupplierBill = vi.fn().mockRejectedValue(new AppError(
      "PROVIDER_ERROR",
      "Generic upstream conflict without structured Xero validation evidence.",
      { httpStatus: 502, retryable: true },
    ));
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts: vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]),
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill,
      getSupplierBill: vi.fn(),
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill(actorId, draftInput)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
      retryable: false,
    });
    await expect(accounting.createDraftSupplierBill(actorId, {
      ...draftInput,
      request_id: "new-request-after-ambiguous-generic-provider-error",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { duplicateState: "WRITE_RESULT_UNKNOWN" },
    });
    expect(createDraftSupplierBill).toHaveBeenCalledTimes(1);
    expect(provider.getSupplierBill).not.toHaveBeenCalled();
  });

  it("keeps exact-source replay idempotent across Agents without treating a reused free-form reference as identity", async () => {
    const repository = new InMemoryAccountingRepository();
    const agentA = oauthPrincipal(["xero.read", "xero.draft.write"], "agent-a");
    const agentB = oauthPrincipal(["xero.read", "xero.draft.write"], "agent-b");
    expect(agentA.actorId).toBe(agentB.actorId);

    const serverFingerprintInput: CreateDraftSupplierBillInput = {
      ...draftInput,
      source_evidence_type: "SERVER_FINGERPRINTED_EXTRACTION",
      source_sha256: hashObject(canonicalDraftExtractionFingerprint(draftInput)),
    };
    const listAccounts = vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]);
    const createDraftSupplierBill = vi.fn().mockResolvedValue({
      bill: draftBill,
      receipt: { operation: "CREATE_DRAFT", invoiceId },
    });
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: agentA.actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts,
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: otherTenantId });

    const first = await accounting.createDraftSupplierBill(agentA, serverFingerprintInput);
    const replay = await accounting.createDraftSupplierBill(agentB, serverFingerprintInput);
    expect(replay).toMatchObject({
      postingRequestId: first.postingRequestId,
      idempotentReplay: true,
      providerReceipt: { operation: "CREATE_DRAFT", invoiceId },
      readbackVerified: true,
    });
    await repository.rejectPosting(first.postingRequestId, "reviewer-a", new Date());

    await expect(accounting.createDraftSupplierBill(agentB, {
      ...serverFingerprintInput,
      request_id: "request-create-new-id-same-source",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        duplicatePostingRequestId: first.postingRequestId,
        duplicateState: "REJECTED",
      },
    });

    const sameSupplierReferenceFromAnotherSource: CreateDraftSupplierBillInput = {
      ...serverFingerprintInput,
      request_id: "request-create-new-source-same-reference",
      source_ref: "synthetic://invoice-a-second-copy",
      source_sha256: "0".repeat(64),
    };
    sameSupplierReferenceFromAnotherSource.source_sha256 = hashObject(
      canonicalDraftExtractionFingerprint(sameSupplierReferenceFromAnotherSource),
    );
    await expect(accounting.createDraftSupplierBill(agentB, sameSupplierReferenceFromAnotherSource)).resolves.toMatchObject({
      idempotentReplay: false,
      providerReceipt: { operation: "CREATE_DRAFT", invoiceId },
      readbackVerified: true,
    });

    expect(createDraftSupplierBill).toHaveBeenCalledTimes(2);
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });

  it("treats the same request ID from another actor as a tenant business conflict, not an idempotent replay", async () => {
    const repository = new InMemoryAccountingRepository();
    const canonicalRequest = canonicalDraftRequest(tenantId, draftInput);
    const requestPayloadHash = hashObject(canonicalRequest);
    await repository.createOrGetPosting({
      postingRequestId,
      actorId,
      tenantId,
      sourceRef: draftInput.source_ref,
      sourceSha256: draftInput.source_sha256,
      sourceEvidenceType: draftInput.source_evidence_type,
      providerPayload: canonicalRequest,
      requestPayloadHash,
      providerPayloadHash: requestPayloadHash,
      requestId: draftInput.request_id,
      createIdempotencyKey: "create-other-actor-conflict-seed",
    });
    await repository.markDraftCreated(postingRequestId, {
      xeroInvoiceId: invoiceId,
      providerPayload: draftBill as unknown as Record<string, unknown>,
      providerPayloadHash: hashObject(canonicalBillForApproval(draftBill)),
      writeReceipt: { operation: "CREATE_DRAFT", invoiceId },
      readbackSnapshot: draftBill as unknown as Record<string, unknown>,
    });

    const listAccounts = vi.fn().mockResolvedValue([{ code: "404", type: "EXPENSE", class: "EXPENSE", status: "ACTIVE" }]);
    const createDraftSupplierBill = vi.fn();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: "actor-b", tenantId, tenantName: "Tenant A" }),
      listAccounts,
      listTaxRates: vi.fn().mockResolvedValue([{
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }]),
      getContact: vi.fn().mockResolvedValue({ contactId, status: "ACTIVE" }),
      createDraftSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill("actor-b", draftInput)).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        duplicatePostingRequestId: postingRequestId,
        duplicateState: "APPROVAL_PENDING",
      },
    });
    expect(listAccounts).not.toHaveBeenCalled();
    expect(createDraftSupplierBill).not.toHaveBeenCalled();
  });

  it("blocks a read-only OAuth principal before draft validation or provider write", async () => {
    const repository = new InMemoryAccountingRepository();
    const principal = oauthPrincipal(["xero.read"]);
    const listAccounts = vi.fn();
    const createDraftSupplierBill = vi.fn();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: principal.actorId, tenantId, tenantName: "Tenant A" }),
      listAccounts,
      listTaxRates: vi.fn(),
      getContact: vi.fn(),
      createDraftSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.createDraftSupplierBill(principal, draftInput)).rejects.toMatchObject({
      code: "SCOPE_MISSING",
    });
    expect(listAccounts).not.toHaveBeenCalled();
    expect(createDraftSupplierBill).not.toHaveBeenCalled();
  });

  it("does not promote xero.draft.write into AUTHORISE authority", async () => {
    const repository = new InMemoryAccountingRepository();
    const principal = oauthPrincipal(["xero.read", "xero.draft.write"]);
    const authoriseSupplierBill = vi.fn();
    const provider = {
      resolveContext: vi.fn().mockResolvedValue({ actorId: principal.actorId, tenantId, tenantName: "Tenant A" }),
      authoriseSupplierBill,
    } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.authoriseSupplierBill(principal, {
      posting_request_id: postingRequestId,
      invoice_id: invoiceId,
      expected_status: "DRAFT",
      approval_ref: approvalRef,
      approved_payload_hash: "3".repeat(64),
      request_id: "oauth-authorise-must-not-open",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(authoriseSupplierBill).not.toHaveBeenCalled();
  });

  it("fails closed when a legacy browser review cannot carry the OAuth binding tuple", async () => {
    const repository = new InMemoryAccountingRepository();
    const principal = oauthPrincipal(["xero.read", "xero.draft.write"]);
    const canonicalRequest = canonicalDraftRequest(tenantId, draftInput);
    const payloadHash = hashObject(canonicalBillForApproval(draftBill));
    await repository.createOrGetPosting({
      postingRequestId,
      actorId: principal.actorId,
      tenantId,
      sourceRef: draftInput.source_ref,
      sourceSha256: draftInput.source_sha256,
      sourceEvidenceType: draftInput.source_evidence_type,
      providerPayload: canonicalRequest,
      requestPayloadHash: hashObject(canonicalRequest),
      providerPayloadHash: hashObject(canonicalRequest),
      requestId: draftInput.request_id,
      createIdempotencyKey: "oauth-create-key-a",
    });
    await repository.markDraftCreated(postingRequestId, {
      xeroInvoiceId: invoiceId,
      providerPayload: draftBill as unknown as Record<string, unknown>,
      providerPayloadHash: payloadHash,
      writeReceipt: { operation: "CREATE_DRAFT", invoiceId },
      readbackSnapshot: draftBill as unknown as Record<string, unknown>,
    });
    const resolveContext = vi.fn();
    const provider = { resolveContext } as unknown as AccountingProvider;
    const accounting = service(repository, provider, { enabled: true, allowedTenantId: tenantId });

    await expect(accounting.authoriseReviewedSupplierBill(principal.actorId, {
      postingRequestId,
      sessionHash: "legacy-review-session",
      csrfToken: "legacy-review-csrf",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(resolveContext).not.toHaveBeenCalled();
  });
});
