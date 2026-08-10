import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import { createDraftSupplierBillSchema, type CreateDraftSupplierBillInput } from "../src/domain/schemas.js";
import type { Logger } from "../src/logging.js";
import { createOAuthRequestContext } from "../src/security/requestContext.js";
import { AccountingService } from "../src/services/accountingService.js";
import { ConnectionTicketService } from "../src/services/connectionTicketService.js";
import { SyntheticXeroWriteProvider } from "../harness/lib/syntheticXeroWriteProvider.js";

const fixturePath = resolve(import.meta.dirname, "../harness/fixtures/xero/synthetic-ledger.json");

function logger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function token(tenantId: string): ResolvedMcpAccessToken {
  const audience = "https://p0-concurrency.invalid/mcp";
  return {
    tokenId: "token_concurrency_regression",
    clientId: "p0-concurrency-regression",
    resource: audience,
    audience,
    grantedScopes: ["xero.read", "xero.draft.write"],
    issuedAt: new Date("2026-08-06T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    installationId: "installation_concurrency_regression",
    bindingId: "binding_concurrency_regression",
    connectionId: "connection_xero_harness_001",
    authorizationId: "authorization_concurrency_regression",
    workspaceId: "workspace_concurrency_regression",
    subjectType: "USER",
    subjectId: "accountant_concurrency_regression",
    agentId: "agent_concurrency_regression",
    policyId: "policy_concurrency_regression",
    tenantId,
  };
}

function service(
  repository: InMemoryAccountingRepository,
  provider: SyntheticXeroWriteProvider,
): AccountingService {
  return new AccountingService({
    repository,
    provider,
    config: {
      publicBaseUrl: "https://p0-concurrency.invalid",
      xeroWriteEnabled: true,
      xeroAllowedTenantId: provider.tenantId,
    },
    logger: logger(),
    connectionTickets: new ConnectionTicketService(repository, "https://p0-concurrency.invalid"),
  });
}

function input(overrides: Partial<CreateDraftSupplierBillInput> = {}): CreateDraftSupplierBillInput {
  return createDraftSupplierBillSchema.parse({
    request_id: "p0.concurrent-regression.001",
    source_ref: "synthetic://p0/concurrent-regression",
    source_sha256: "d".repeat(64),
    source_evidence_type: "AGENT_ASSERTED_UNVERIFIED",
    user_confirmation: "CONFIRMED_FOR_DRAFT",
    contact_id: "20000000-0000-4000-8000-000000000001",
    invoice_date: "2026-08-01",
    due_date: "2026-08-31",
    currency: "HKD",
    reference: "P0-CONCURRENT-REGRESSION",
    line_amount_type: "NoTax",
    lines: [{
      description: "Concurrent regression fixture",
      quantity: 1,
      unit_amount: 1000,
      account_code: "445",
      tax_type: "NONE",
    }],
    ...overrides,
  });
}

function context(provider: SyntheticXeroWriteProvider) {
  return createOAuthRequestContext({
    issuer: "https://issuer.p0-concurrency.invalid",
    resolvedToken: token(provider.tenantId),
  });
}

describe("DC-CONCURRENT-012B regression", () => {
  it("returns one posting and invoice across two service instances sharing one repository", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const repository = new InMemoryAccountingRepository();
    const provider = new SyntheticXeroWriteProvider(fixture, () => true);
    const serviceA = service(repository, provider);
    const serviceB = service(repository, provider);
    const principal = context(provider);
    const request = input();

    const originalCreate = provider.createDraftSupplierBill.bind(provider);
    let releaseProvider: () => void = () => undefined;
    const providerBarrier = new Promise<void>((resolveBarrier) => {
      releaseProvider = resolveBarrier;
    });
    let signalProviderStarted: () => void = () => undefined;
    const providerStarted = new Promise<void>((resolveStarted) => {
      signalProviderStarted = resolveStarted;
    });
    const createSpy = vi.spyOn(provider, "createDraftSupplierBill").mockImplementation(async (...args) => {
      signalProviderStarted();
      await providerBarrier;
      return originalCreate(...args);
    });
    const getPostingSpy = vi.spyOn(repository, "getPosting");

    const first = serviceA.createDraftSupplierBill(principal, request);
    await providerStarted;
    const second = serviceB.createDraftSupplierBill(principal, request);
    await vi.waitFor(() => expect(getPostingSpy).toHaveBeenCalled(), { timeout: 1_000 });
    expect(createSpy).toHaveBeenCalledTimes(1);
    releaseProvider();
    const settled = await Promise.allSettled([first, second]);

    expect(provider.writeAttempts).toBe(1);
    expect(provider.records).toHaveLength(1);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    if (settled[0]?.status !== "fulfilled" || settled[1]?.status !== "fulfilled") return;
    expect(settled[0].value.postingRequestId).toBe(settled[1].value.postingRequestId);
    expect(settled[0].value.invoiceId).toBe(settled[1].value.invoiceId);
    expect([settled[0].value.idempotentReplay, settled[1].value.idempotentReplay].sort())
      .toEqual([false, true]);
  });

  it("conflicts changed payload and business duplicates without merging an unrelated document", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const repository = new InMemoryAccountingRepository();
    const provider = new SyntheticXeroWriteProvider(fixture, () => true);
    const serviceA = service(repository, provider);
    const serviceB = service(repository, provider);
    const principal = context(provider);
    const firstInput = input();

    const originalCreate = provider.createDraftSupplierBill.bind(provider);
    let releaseProvider: () => void = () => undefined;
    const providerBarrier = new Promise<void>((resolveBarrier) => {
      releaseProvider = resolveBarrier;
    });
    let signalProviderStarted: () => void = () => undefined;
    const providerStarted = new Promise<void>((resolveStarted) => {
      signalProviderStarted = resolveStarted;
    });
    let interceptedCreates = 0;
    const createSpy = vi.spyOn(provider, "createDraftSupplierBill").mockImplementation(async (...args) => {
      interceptedCreates += 1;
      if (interceptedCreates === 1) {
        signalProviderStarted();
        await providerBarrier;
      }
      return originalCreate(...args);
    });

    const first = serviceA.createDraftSupplierBill(principal, firstInput);
    await providerStarted;
    await expect(serviceB.createDraftSupplierBill(principal, input({
      reference: "P0-CONCURRENT-CHANGED-PAYLOAD",
    }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(serviceB.createDraftSupplierBill(principal, input({
      request_id: "p0.concurrent-business-duplicate.002",
    }))).rejects.toMatchObject({
      code: "CONFLICT",
      details: { duplicateState: "VALIDATED" },
    });
    expect(createSpy).toHaveBeenCalledTimes(1);

    releaseProvider();
    const created = await first;
    const unrelated = await serviceB.createDraftSupplierBill(principal, input({
      request_id: "p0.concurrent-unrelated.003",
      source_ref: "synthetic://p0/concurrent-unrelated",
      source_sha256: "e".repeat(64),
      reference: "P0-CONCURRENT-UNRELATED",
    }));

    expect(unrelated.postingRequestId).not.toBe(created.postingRequestId);
    expect(unrelated.invoiceId).not.toBe(created.invoiceId);
    expect(provider.writeAttempts).toBe(2);
    expect(provider.records).toHaveLength(2);
  });

  it("lets concurrent cross-instance unknown-write recovery converge by exact readback only", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const repository = new InMemoryAccountingRepository();
    const provider = new SyntheticXeroWriteProvider(fixture, () => true);
    const serviceA = service(repository, provider);
    const serviceB = service(repository, provider);
    const principal = context(provider);
    const request = input({ request_id: "p0.concurrent-recovery.004" });

    provider.armNextDraftFault("DRAFT_TIMEOUT_AFTER_COMMIT");
    await expect(serviceA.createDraftSupplierBill(principal, request)).rejects.toMatchObject({
      code: "WRITE_RESULT_UNKNOWN",
    });
    expect(provider.writeAttempts).toBe(1);
    expect(provider.records).toHaveLength(1);

    const originalReadback = provider.getSupplierBill.bind(provider);
    let releaseReadbacks: () => void = () => undefined;
    const readbackBarrier = new Promise<void>((resolveBarrier) => {
      releaseReadbacks = resolveBarrier;
    });
    let signalBothReadbacks: () => void = () => undefined;
    const bothReadbacks = new Promise<void>((resolveStarted) => {
      signalBothReadbacks = resolveStarted;
    });
    let readbackCount = 0;
    vi.spyOn(provider, "getSupplierBill").mockImplementation(async (...args) => {
      readbackCount += 1;
      if (readbackCount === 2) signalBothReadbacks();
      await readbackBarrier;
      return originalReadback(...args);
    });

    const recoveryA = serviceA.createDraftSupplierBill(principal, request);
    const recoveryB = serviceB.createDraftSupplierBill(principal, request);
    await bothReadbacks;
    releaseReadbacks();
    const [resultA, resultB] = await Promise.all([recoveryA, recoveryB]);

    expect(resultA.postingRequestId).toBe(resultB.postingRequestId);
    expect(resultA.invoiceId).toBe(resultB.invoiceId);
    expect(resultA.idempotentReplay).toBe(true);
    expect(resultB.idempotentReplay).toBe(true);
    expect(provider.writeAttempts).toBe(1);
    expect(provider.records).toHaveLength(1);
    expect(readbackCount).toBe(2);
  });
});
