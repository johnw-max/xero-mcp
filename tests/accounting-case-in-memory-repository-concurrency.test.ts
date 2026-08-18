import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileTestXeroAccountingCase as compileAccountingCase,
  TEST_XERO_TENANT_ID,
  testXeroBusinessAuthorityProfile,
} from "./helpers/xeroTenantCoaProfile.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type {
  AccountingCaseBinding,
  UpdateAccountingCaseOperationInput,
} from "../src/domain/accountingCasePersistence.js";
import {
  accountingCaseMutationRoute,
  accountingCasePlanHash,
  accountingCasePreflightReceiptHash,
  accountingCasePreflightResealReceiptHash,
  type AccountingCaseOperationReseal,
  type AccountingCasePreflightResealReceipt,
} from "../src/domain/accountingCasePersistence.js";
import {
  accountingCaseContinuationTemplateHash,
  accountingCaseRecoveryResidualContinuationTemplate,
} from "../src/domain/accountingCaseContinuation.js";
import type { CompiledAccountingCase } from "../src/domain/accountingCase.js";
import type { ContactDurableIdentity } from "../src/domain/accountingCase.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import type { XeroMutationPreparation } from "../src/domain/xeroMutation.js";
import { XERO_MUTATION_EXPECTED_READBACK_STATUS } from "../src/domain/xeroMutation.js";
import { hashObject } from "../src/security/hash.js";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

const now = new Date("2026-08-13T04:00:00.000Z");

function binding(overrides: Partial<AccountingCaseBinding> = {}): AccountingCaseBinding {
  return {
    actorId: "workspace-1:user:user-1",
    workspaceId: "workspace-1",
    subjectType: "USER",
    subjectId: "user-1",
    agentId: "accounting-agent-1",
    installationId: "installation-1",
    bindingId: "binding-1",
    bindingRevision: 1,
    connectionId: "connection-1",
    tenantId: fixture.target.tenantId,
    targetSessionId: "target-session-1",
    targetSessionHash: "a".repeat(64),
    targetSessionExpiresAt: new Date("2026-08-13T04:30:00.000Z"),
    ...overrides,
  };
}

function compiled(version: number): CompiledAccountingCase {
  return compileAccountingCase({
    ...structuredClone(fixture),
    expectedVersion: version - 1,
  });
}

function compiledTwoInvoiceCase(caseId: string): CompiledAccountingCase {
  const input = structuredClone(fixture);
  const documents = input.facts
    .filter((fact) => fact.kind === "NATIVE_DOCUMENT" && fact.documentKind === "INVOICE")
    .slice(0, 2);
  const unitIds = new Set(documents.flatMap((fact) => fact.sourceUnitIds));
  input.caseId = caseId;
  input.expectedVersion = 0;
  input.sources = input.sources.flatMap((source) => {
    const units = source.units.filter((unit) => unitIds.has(unit.unitId));
    return units.length > 0 ? [{ ...source, units }] : [];
  });
  input.facts = documents;
  return compileAccountingCase(input);
}

function compiledSingleDocument(options: {
  caseId: string;
  referenceKind: "FORMAL_DOCUMENT_NUMBER" | "GENERIC_RECURRING_REFERENCE";
  documentDate?: string;
  dueDate?: string;
  unitAmount?: string;
  declaredNet?: string;
  declaredTax?: string;
  declaredGross?: string;
  contactDurableIdentity?: ContactDurableIdentity | null;
  businessAuthority?: ReturnType<typeof testXeroBusinessAuthorityProfile>;
}): CompiledAccountingCase {
  const source = structuredClone(fixture);
  const original = source.facts.find((fact) =>
    fact.kind === "NATIVE_DOCUMENT" && fact.factId === "fact-sales-invoice-v1");
  if (!original || original.kind !== "NATIVE_DOCUMENT") throw new Error("sales invoice fixture missing");
  const unitId = original.sourceUnitIds[0];
  if (!unitId) throw new Error("sales invoice source unit missing");
  const document = {
    ...original,
    referenceKind: options.referenceKind,
    documentDate: options.documentDate ?? original.documentDate,
    dueDate: options.dueDate ?? original.dueDate,
    lines: original.lines.map((line) => ({
      ...line,
      unitAmount: options.unitAmount ?? line.unitAmount,
      sourceTax: options.declaredTax ?? line.sourceTax,
    })),
    declaredNet: options.declaredNet ?? original.declaredNet,
    declaredTax: options.declaredTax ?? original.declaredTax,
    declaredGross: options.declaredGross ?? original.declaredGross,
    ...(options.contactDurableIdentity === null
      ? { contactDurableIdentity: undefined }
      : options.contactDurableIdentity
        ? { contactDurableIdentity: options.contactDurableIdentity }
        : {}),
  };
  return compileAccountingCase({
    ...source,
    caseId: options.caseId,
    target: options.businessAuthority
      ? { ...source.target, tenantId: options.businessAuthority.tenant_id }
      : source.target,
    sources: [{
      artifactId: `source-${options.caseId}`,
      label: "One bounded identity test document",
      units: [{ unitId, expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    }],
    facts: [document],
  }, options.businessAuthority);
}

function compiledContactCase(options: {
  caseId: string;
  identity: ContactDurableIdentity;
  expectedVersion?: number;
}): CompiledAccountingCase {
  return compileAccountingCase({
    caseId: options.caseId,
    expectedVersion: options.expectedVersion ?? 0,
    target: structuredClone(fixture.target),
    sources: [{
      artifactId: `contact-source-${options.caseId}`,
      label: "One contact reservation source",
      units: [{ unitId: `contact-unit-${options.caseId}`, expectedFactKinds: ["CONTACT_CANDIDATE"] }],
    }],
    facts: [{
      factId: `contact-fact-${options.caseId}`,
      lineageKey: `contact-lineage-${options.caseId}`,
      eventKey: `contact-event-${options.caseId}`,
      sourceUnitIds: [`contact-unit-${options.caseId}`],
      origin: "MODEL_EXTRACTED",
      revision: 1,
      kind: "CONTACT_CANDIDATE",
      usageRoles: ["CUSTOMER"],
      name: `Contact ${options.caseId}`,
      durableIdentity: options.identity,
      ...(options.identity.kind === "LEGAL_REGISTRY"
        ? { companyNumber: options.identity.number }
        : { accountNumber: options.identity.number }),
      bankVerification: "NOT_APPLICABLE",
    }],
  });
}

function planHash(value: CompiledAccountingCase, caseBinding = binding()): string {
  return accountingCasePlanHash(caseBinding, value);
}

async function createCase(
  repository: InMemoryAccountingRepository,
  caseBinding = binding(),
  value = compiled(1),
) {
  return repository.createOrAdvanceAccountingCase({
    binding: caseBinding,
    compiled: value,
    compiledPlanHash: planHash(value, caseBinding),
    now,
  });
}

async function seedLiveTarget(repository: InMemoryAccountingRepository, caseBinding = binding()) {
  await repository.saveProviderAuthorization({
    authorizationId: "authorization-1",
    workspaceId: caseBinding.workspaceId,
    authorizedBySubject: caseBinding.subjectId,
    provider: "xero",
    grantedScopes: ["accounting.transactions"],
    tokenCiphertext: "encrypted-test-token",
    tokenExpiresAt: new Date("2026-08-13T08:00:00.000Z"),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  await repository.upsertAuthorizedProviderConnection(caseBinding.workspaceId, {
    connectionId: caseBinding.connectionId,
    authorizationId: "authorization-1",
    provider: "xero",
    tenantId: caseBinding.tenantId,
    tenantName: "Case Test Tenant",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  await repository.saveOAuthInstallation({
    installationId: caseBinding.installationId,
    workspaceId: caseBinding.workspaceId,
    subjectType: caseBinding.subjectType,
    subjectId: caseBinding.subjectId,
    agentId: caseBinding.agentId,
    clientId: "client-1",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  await repository.saveAgentConnectionBinding({
    bindingId: caseBinding.bindingId,
    installationId: caseBinding.installationId,
    workspaceId: caseBinding.workspaceId,
    subjectType: caseBinding.subjectType,
    subjectId: caseBinding.subjectId,
    agentId: caseBinding.agentId,
    connectionId: caseBinding.connectionId,
    policyId: "policy-1",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  await repository.saveLedgerTargetSession({
    sessionId: caseBinding.targetSessionId,
    sessionHash: caseBinding.targetSessionHash,
    installationId: caseBinding.installationId,
    bindingId: caseBinding.bindingId,
    connectionId: caseBinding.connectionId,
    bindingRevision: caseBinding.bindingRevision,
    createdAt: now,
    expiresAt: caseBinding.targetSessionExpiresAt,
  });
}

async function prepareOperation(
  repository: InMemoryAccountingRepository,
  value: CompiledAccountingCase,
  operation: CompiledAccountingCase["operations"][number],
  index: number,
  caseBinding = binding(),
  prefix = "preflight",
): Promise<XeroMutationPreparation> {
  const route = accountingCaseMutationRoute(operation);
  const canonicalPayload = { caseOperationId: operation.operationId, actionId: operation.actionId };
  const sourceSha256 = hashObject({ caseId: value.caseId, operationId: operation.operationId });
  return repository.createXeroMutationPreparation({
    preparationId: `${prefix}:${index}:${operation.operationId}`,
    actorId: caseBinding.actorId,
    workspaceId: caseBinding.workspaceId,
    tenantId: caseBinding.tenantId,
    installationId: caseBinding.installationId,
    bindingId: caseBinding.bindingId,
    bindingRevision: caseBinding.bindingRevision,
    connectionId: caseBinding.connectionId,
    targetSessionId: caseBinding.targetSessionId,
    objectType: route.objectType,
    operation: route.operation,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    sourceRef: `case:${value.caseId}`,
    sourceUnitKey: operation.operationId,
    sourceSha256,
    sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
    confirmationSummaryHash: hashObject({ operationId: operation.operationId, kind: "summary" }),
    confirmationPhraseHash: hashObject({ operationId: operation.operationId, kind: "phrase" }),
    expiresAt: new Date(now.getTime() + 20 * 60_000),
    now,
  });
}

async function preparedPreflight(
  repository: InMemoryAccountingRepository,
  value: CompiledAccountingCase,
  caseBinding = binding(),
  prefix = "preflight",
) {
  const preparations: XeroMutationPreparation[] = [];
  for (const [index, operation] of value.operations.entries()) {
    preparations.push(await prepareOperation(repository, value, operation, index, caseBinding, prefix));
  }
  const operations = value.operations.map((operation, index) => ({
    operationId: operation.operationId,
    state: "PREPARED" as const,
    preparationId: preparations[index]!.preparationId,
    operationCanonicalPayloadHash: operation.canonicalPayloadHash,
    preparationCanonicalPayloadHash: preparations[index]!.canonicalPayloadHash,
    sourceSha256: preparations[index]!.sourceSha256,
  }));
  return { preparations, operations };
}

function preflightReceiptForTest(
  value: CompiledAccountingCase,
  operations: Awaited<ReturnType<typeof preparedPreflight>>["operations"],
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    operations: operations.map((operation) => ({
      operationId: operation.operationId,
      actionId: value.operations.find((candidate) => candidate.operationId === operation.operationId)!.actionId,
      operationCanonicalPayloadHash: operation.operationCanonicalPayloadHash,
      state: operation.state,
      preparationId: operation.preparationId,
      preparationCanonicalPayloadHash: operation.preparationCanonicalPayloadHash,
      sourceSha256: operation.sourceSha256,
    })),
  };
}

async function confirmMutation(
  repository: InMemoryAccountingRepository,
  preparation: XeroMutationPreparation,
  mutationRequestId: string,
) {
  const confirmed = await repository.confirmXeroMutationPreparation({
    mutationRequestId,
    preparationId: preparation.preparationId,
    requestId: `request:${mutationRequestId}`,
    actorId: preparation.actorId,
    workspaceId: preparation.workspaceId,
    tenantId: preparation.tenantId,
    installationId: preparation.installationId,
    bindingId: preparation.bindingId,
    bindingRevision: preparation.bindingRevision,
    connectionId: preparation.connectionId,
    targetSessionId: preparation.targetSessionId,
    objectType: preparation.objectType,
    operation: preparation.operation,
    canonicalPayload: preparation.canonicalPayload,
    canonicalPayloadHash: preparation.canonicalPayloadHash,
    sourceRef: preparation.sourceRef,
    sourceUnitKey: preparation.sourceUnitKey,
    sourceSha256: preparation.sourceSha256,
    sourceEvidenceType: preparation.sourceEvidenceType,
    confirmationSummaryHash: preparation.confirmationSummaryHash,
    confirmationPhraseHash: preparation.confirmationPhraseHash,
    authorizationReceipt: { receiptType: "TEST_AUTONOMOUS_AUTHORITY" },
    successfulValidationReceipt: { receiptType: "TEST_VALIDATION" },
    claimForWrite: true,
    now,
  });
  if (!confirmed) throw new Error("test mutation confirmation failed");
  return confirmed.request;
}

async function expireMutationPreparation(
  repository: InMemoryAccountingRepository,
  preparation: XeroMutationPreparation,
): Promise<void> {
  const expired = await repository.confirmXeroMutationPreparation({
    mutationRequestId: `expired:${preparation.preparationId}`,
    preparationId: preparation.preparationId,
    requestId: `expire:${preparation.preparationId}`,
    actorId: preparation.actorId,
    workspaceId: preparation.workspaceId,
    tenantId: preparation.tenantId,
    installationId: preparation.installationId,
    bindingId: preparation.bindingId,
    bindingRevision: preparation.bindingRevision,
    connectionId: preparation.connectionId,
    targetSessionId: preparation.targetSessionId,
    objectType: preparation.objectType,
    operation: preparation.operation,
    canonicalPayload: preparation.canonicalPayload,
    canonicalPayloadHash: preparation.canonicalPayloadHash,
    sourceRef: preparation.sourceRef,
    sourceUnitKey: preparation.sourceUnitKey,
    sourceSha256: preparation.sourceSha256,
    sourceEvidenceType: preparation.sourceEvidenceType,
    confirmationSummaryHash: preparation.confirmationSummaryHash,
    confirmationPhraseHash: preparation.confirmationPhraseHash,
    authorizationReceipt: { receiptType: "TEST_AUTONOMOUS_AUTHORITY" },
    successfulValidationReceipt: { receiptType: "TEST_VALIDATION" },
    claimForWrite: true,
    now: new Date(preparation.expiresAt.getTime() + 1),
  });
  expect(expired).toBeUndefined();
  await expect(repository.getXeroMutationPreparation(preparation.preparationId)).resolves.toMatchObject({
    state: "EXPIRED",
  });
}

function boundMutationInput(preparation: XeroMutationPreparation, mutationRequestId: string) {
  return {
    mutationRequestId,
    actorId: preparation.actorId,
    workspaceId: preparation.workspaceId,
    tenantId: preparation.tenantId,
    installationId: preparation.installationId,
    bindingId: preparation.bindingId,
    bindingRevision: preparation.bindingRevision,
    connectionId: preparation.connectionId,
    targetSessionId: preparation.targetSessionId,
    objectType: preparation.objectType,
    operation: preparation.operation,
    canonicalPayloadHash: preparation.canonicalPayloadHash,
    sourceRef: preparation.sourceRef,
    sourceUnitKey: preparation.sourceUnitKey,
    sourceSha256: preparation.sourceSha256,
    sourceEvidenceType: preparation.sourceEvidenceType,
    now,
  };
}

async function casePreparation(
  repository: InMemoryAccountingRepository,
  value: CompiledAccountingCase,
  operationId: string,
  caseBinding = binding(),
): Promise<XeroMutationPreparation> {
  const record = await repository.getBoundAccountingCase({
    binding: caseBinding,
    caseId: value.caseId,
    version: value.version,
  });
  const preparationId = record?.operations.find(
    (candidate) => candidate.operation.operationId === operationId,
  )?.preparationId;
  if (!preparationId) throw new Error(`missing preparation for ${operationId}`);
  const preparation = await repository.getXeroMutationPreparation(preparationId);
  if (!preparation) throw new Error(`missing durable preparation ${preparationId}`);
  return preparation;
}

async function recordVerifiedMutation(
  repository: InMemoryAccountingRepository,
  preparation: XeroMutationPreparation,
  mutationRequestId: string,
  operation: CompiledAccountingCase["operations"][number],
  objectId = `xero:${mutationRequestId}`,
) {
  await confirmMutation(repository, preparation, mutationRequestId);
  const bound = boundMutationInput(preparation, mutationRequestId);
  const writeReceipt = { providerRequestId: `provider:${mutationRequestId}` };
  await repository.recordXeroMutationWriteEvidence({
    ...bound,
    xeroObjectId: objectId,
    writeReceipt,
  });
  const readbackSnapshot = operation.nativeRoute === "CONTACT_CREATE"
    ? { id: objectId, status: XERO_MUTATION_EXPECTED_READBACK_STATUS[preparation.objectType] }
    : {
        xeroObjectId: objectId,
        status: XERO_MUTATION_EXPECTED_READBACK_STATUS[preparation.objectType],
        canonicalPayload: preparation.canonicalPayload,
        evidence: economicReadbackEvidence(operation, objectId),
      };
  await repository.markXeroMutationReadbackVerified({
    ...bound,
    xeroObjectId: objectId,
    writeReceipt,
    readbackSnapshot,
    readbackSnapshotHash: hashObject(readbackSnapshot),
    readbackCanonicalPayload: preparation.canonicalPayload,
    readbackPayloadHash: preparation.canonicalPayloadHash,
    readbackStatus: XERO_MUTATION_EXPECTED_READBACK_STATUS[preparation.objectType],
  });
  return { bound, objectId, writeReceipt, readbackSnapshot };
}

function shiftedFour(value: unknown, delta = 10_000n): string {
  if (typeof value !== "string" || !/^-?\d+\.\d{4}$/u.test(value)) {
    throw new Error("test economic value is not fixed-four");
  }
  const shifted = BigInt(value.replace(".", "")) + delta;
  const negative = shifted < 0n;
  const absolute = negative ? -shifted : shifted;
  const digits = absolute.toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

function economicReadbackEvidence(
  operation: CompiledAccountingCase["operations"][number],
  objectId: string,
  tamperTax = false,
): Record<string, unknown> {
  const payload = operation.canonicalPayload;
  if (!Array.isArray(payload.lines)) throw new Error("test native operation has no lines");
  const caseLines = payload.lines as Array<Record<string, unknown>>;
  const tax = tamperTax ? shiftedFour(payload.tax) : payload.tax;
  const gross = tamperTax ? shiftedFour(payload.gross) : payload.gross;
  const taxAmounts = caseLines.map((line, index) =>
    tamperTax && index === 0 ? shiftedFour(line.tax) : line.tax);
  if (operation.nativeRoute === "SALES_INVOICE" || operation.nativeRoute === "SUPPLIER_BILL") {
    return {
      providerDocumentReadback: {
        invoiceId: objectId,
        type: operation.nativeRoute === "SALES_INVOICE" ? "ACCREC" : "ACCPAY",
        status: "DRAFT",
        subTotal: payload.net,
        totalTax: tax,
        total: gross,
        lineItemCount: caseLines.length,
        linesTruncated: false,
        lines: caseLines.map((line, index) => ({
          lineAmount: line.net,
          taxAmount: taxAmounts[index],
          accountId: (line.providerAccountBinding as Record<string, unknown>).accountId,
          accountCode: line.accountCode,
          taxType: line.taxType,
        })),
      },
    };
  }
  return {
    objectType: "CREDIT_NOTE",
    creditNoteId: objectId,
    providerEconomicsEvidence: {
      lineAmounts: caseLines.map((line) => line.net),
      taxAmounts,
      accountIds: caseLines.map((line) =>
        (line.providerAccountBinding as Record<string, unknown>).accountId),
      accountCodes: caseLines.map((line) => line.accountCode),
      taxTypes: caseLines.map((line) => line.taxType),
      subTotal: payload.net,
      totalTax: tax,
      total: gross,
      noDiscountsVerified: true,
    },
  };
}

async function recordCaseEconomicMutation(
  repository: InMemoryAccountingRepository,
  value: CompiledAccountingCase,
  operation: CompiledAccountingCase["operations"][number],
  mutationRequestId: string,
  tamperTax = false,
) {
  const preparation = await casePreparation(repository, value, operation.operationId);
  await confirmMutation(repository, preparation, mutationRequestId);
  const bound = boundMutationInput(preparation, mutationRequestId);
  const objectId = `xero:${mutationRequestId}`;
  const writeReceipt = { providerRequestId: `provider:${mutationRequestId}` };
  await repository.recordXeroMutationWriteEvidence({ ...bound, xeroObjectId: objectId, writeReceipt });
  const readbackSnapshot = {
    xeroObjectId: objectId,
    status: "DRAFT",
    canonicalPayload: preparation.canonicalPayload,
    evidence: economicReadbackEvidence(operation, objectId, tamperTax),
  };
  await repository.markXeroMutationReadbackVerified({
    ...bound,
    xeroObjectId: objectId,
    writeReceipt,
    readbackSnapshot,
    readbackSnapshotHash: hashObject(readbackSnapshot),
    readbackCanonicalPayload: preparation.canonicalPayload,
    readbackPayloadHash: preparation.canonicalPayloadHash,
    readbackStatus: "DRAFT",
  });
  return { preparation, objectId, writeReceipt, readbackSnapshot };
}

async function preflightCase(
  repository: InMemoryAccountingRepository,
  requestId = "execute-1",
  caseBinding = binding(),
  value = compiled(1),
) {
  const compiledPlanHash = planHash(value, caseBinding);
  const existing = await repository.getBoundAccountingCase({
    binding: caseBinding,
    caseId: value.caseId,
    version: value.version,
  });
  if (!existing?.preflightRequestId) {
    const prepared = await preparedPreflight(repository, value, caseBinding, `preflight:${requestId}`);
    const preflightReceipt = preflightReceiptForTest(
      value,
      prepared.operations,
      { policy: "test-whole-case-preflight", operationCount: value.operations.length },
    );
    await repository.recordAccountingCasePreflight({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: compiledPlanHash,
      preflightReceipt,
      preflightReceiptHash: accountingCasePreflightReceiptHash({
        binding: caseBinding,
        caseId: value.caseId,
        version: value.version,
        compiledPlanHash,
        requestId,
        preflightReceipt,
      }),
      operations: prepared.operations,
      now,
    });
  }
}

async function claimCase(
  repository: InMemoryAccountingRepository,
  requestId = "execute-1",
  caseBinding = binding(),
  value = compiled(1),
) {
  await preflightCase(repository, requestId, caseBinding, value);
  return repository.claimAccountingCaseExecution({
    binding: caseBinding,
    caseId: value.caseId,
    version: value.version,
    requestId,
    expectedPlanHash: planHash(value, caseBinding),
    now,
  });
}

async function resealInputForTest(
  repository: InMemoryAccountingRepository,
  value: CompiledAccountingCase,
  requestId: string,
  caseBinding = binding(),
  resealedAt = new Date(now.getTime() + 21 * 60_000),
) {
  const record = await repository.getBoundAccountingCase({
    binding: caseBinding,
    caseId: value.caseId,
    version: value.version,
  });
  if (!record?.preflightReceiptHash || !record.effectivePreflightSealHash ||
      record.preflightResealRevision === undefined) {
    throw new Error("test Case is not preflighted");
  }
  const operations: AccountingCaseOperationReseal[] = [];
  for (const operation of record.operations.filter((candidate) => candidate.state === "PREPARED")) {
    if (!operation.preparationId) throw new Error("test operation has no preparation");
    const old = await repository.getXeroMutationPreparation(operation.preparationId);
    if (!old) throw new Error("test old preparation is missing");
    const newPreparationId = `reseal:${requestId}:${resealedAt.getTime()}:${operation.ordinal}:${operation.operation.operationId}`;
    const replacement = await repository.createXeroMutationPreparation({
      preparationId: newPreparationId,
      actorId: old.actorId,
      workspaceId: old.workspaceId,
      tenantId: old.tenantId,
      installationId: old.installationId,
      bindingId: old.bindingId,
      bindingRevision: old.bindingRevision,
      connectionId: old.connectionId,
      targetSessionId: old.targetSessionId,
      objectType: old.objectType,
      operation: old.operation,
      ...(old.targetXeroObjectId ? { targetXeroObjectId: old.targetXeroObjectId } : {}),
      canonicalPayload: structuredClone(old.canonicalPayload),
      canonicalPayloadHash: old.canonicalPayloadHash,
      ...(old.sourceRef ? { sourceRef: old.sourceRef } : {}),
      sourceUnitKey: old.sourceUnitKey,
      sourceSha256: old.sourceSha256,
      sourceEvidenceType: old.sourceEvidenceType,
      confirmationSummaryHash: old.confirmationSummaryHash,
      confirmationPhraseHash: hashObject({ newPreparationId, kind: "phrase" }),
      expiresAt: new Date(resealedAt.getTime() + 5 * 60_000),
      now: resealedAt,
    });
    operations.push({
      operationId: operation.operation.operationId,
      oldPreparationId: old.preparationId,
      newPreparationId: replacement.preparationId,
      operationCanonicalPayloadHash: operation.operation.canonicalPayloadHash,
      preparationCanonicalPayloadHash: replacement.canonicalPayloadHash,
      sourceSha256: replacement.sourceSha256,
      newPreparationExpiresAt: replacement.expiresAt.toISOString(),
    });
  }
  const minimumPreparationExpiresAt = new Date(resealedAt.getTime() + 30_000);
  const revision = record.preflightResealRevision + 1;
  const resealReceipt: AccountingCasePreflightResealReceipt = {
    receiptType: "XERO_ACCOUNTING_CASE_PREFLIGHT_RESEAL",
    receiptVersion: 1,
    caseId: value.caseId,
    caseVersion: value.version,
    requestId,
    compiledPlanHash: record.compiledPlanHash,
    originalPreflightReceiptHash: record.preflightReceiptHash,
    previousEffectiveSealHash: record.effectivePreflightSealHash,
    revision,
    authorityReceipt: { receiptType: "TEST_LIVE_AUTHORITY", checkedAt: resealedAt.toISOString() },
    operations,
    minimumPreparationExpiresAt: minimumPreparationExpiresAt.toISOString(),
    checkedAt: resealedAt.toISOString(),
  };
  const resealReceiptHash = accountingCasePreflightResealReceiptHash({
    binding: caseBinding,
    caseId: value.caseId,
    version: value.version,
    compiledPlanHash: record.compiledPlanHash,
    originalPreflightReceiptHash: record.preflightReceiptHash,
    previousEffectiveSealHash: record.effectivePreflightSealHash,
    revision,
    requestId,
    resealReceipt,
  });
  return {
    binding: caseBinding,
    caseId: value.caseId,
    version: value.version,
    requestId,
    expectedPlanHash: record.compiledPlanHash,
    expectedOriginalPreflightReceiptHash: record.preflightReceiptHash,
    expectedEffectiveSealHash: record.effectivePreflightSealHash,
    expectedResealRevision: record.preflightResealRevision,
    resealReceipt,
    resealReceiptHash,
    operations,
    minimumPreparationExpiresAt,
    now: resealedAt,
  };
}

describe("InMemory Accounting Case repository concurrency and state consistency", () => {
  it("atomically claims one tenant bare number before preflight across different typed namespaces", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const sg = compiledContactCase({
      caseId: "pending-contact-sg",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "SG", registryScheme: "ACRA", number: "123" },
    });
    const us = compiledContactCase({
      caseId: "pending-contact-us",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "US", registryScheme: "IRS", number: "123" },
    });
    expect(sg.operations[0]?.businessIdentityHash).not.toBe(us.operations[0]?.businessIdentityHash);
    expect(sg.operations[0]?.businessReservation).toEqual(us.operations[0]?.businessReservation);

    const outcomes = await Promise.allSettled([
      createCase(repository, binding(), sg),
      createCase(repository, binding(), us),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({
      code: "CONFLICT",
      details: {
        reasonCodes: ["ACCOUNTING_CASE_CONTACT_BARE_NUMBER_ALREADY_RESERVED"],
        providerMutationPossible: false,
      },
    });
  });

  it("keeps exact same-Case contact intent idempotent, transfers corrections, and allows different numbers", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const exact = compiledContactCase({
      caseId: "pending-contact-exact",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "SG", registryScheme: "ACRA", number: "123" },
    });
    const replayed = await Promise.all([
      createCase(repository, binding(), exact),
      createCase(repository, binding(), exact),
    ]);
    expect(replayed.map((result) => result.mode).sort()).toEqual(["CREATED", "IDEMPOTENT_REPLAY"]);

    const corrected = compiledContactCase({
      caseId: exact.caseId,
      expectedVersion: 1,
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "SG", registryScheme: "ACRA", number: "123" },
    });
    await expect(createCase(repository, binding(), corrected)).resolves.toMatchObject({ mode: "ADVANCED" });

    const different = compiledContactCase({
      caseId: "pending-contact-different-number",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "US", registryScheme: "IRS", number: "456" },
    });
    await expect(createCase(repository, binding(), different)).resolves.toMatchObject({ mode: "CREATED" });
  });

  it("releases only an abandoned current PENDING contact claim after its target lease expires", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => new Date("2026-08-13T04:02:00.000Z") });
    const expiredBinding = binding({ targetSessionExpiresAt: new Date("2026-08-13T04:01:00.000Z") });
    const first = compiledContactCase({
      caseId: "pending-contact-expired-owner",
      identity: { kind: "PROVIDER_TENANT_ACCOUNT", providerId: "xero", namespace: "AR", number: "CUST-123" },
    });
    await createCase(repository, expiredBinding, first);

    const nextBinding = binding({
      targetSessionId: "target-session-2",
      targetSessionHash: "b".repeat(64),
      targetSessionExpiresAt: new Date("2026-08-13T05:00:00.000Z"),
    });
    const second = compiledContactCase({
      caseId: "pending-contact-after-expiry",
      identity: { kind: "PROVIDER_TENANT_ACCOUNT", providerId: "xero", namespace: "AP", number: "CUST-123" },
    });
    await expect(repository.createOrAdvanceAccountingCase({
      binding: nextBinding,
      compiled: second,
      compiledPlanHash: planHash(second, nextBinding),
      now: new Date("2026-08-13T04:02:00.000Z"),
    })).resolves.toMatchObject({ mode: "CREATED" });
  });

  it("atomically abandons an expired zero-request PREPARED contact and transfers its bare number", async () => {
    let repositoryNow = now;
    const repository = new InMemoryAccountingRepository({ now: () => repositoryNow });
    await seedLiveTarget(repository, binding());
    const first = compiledContactCase({
      caseId: "prepared-contact-expired-owner",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "SG", registryScheme: "ACRA", number: "STALE-123" },
    });
    await createCase(repository, binding(), first);
    await preflightCase(repository, "prepared-contact-expired-owner", binding(), first);
    const prepared = await repository.getBoundAccountingCase({
      binding: binding(), caseId: first.caseId, version: first.version,
    });
    const preparationId = prepared?.operations[0]?.preparationId;
    expect(preparationId).toBeTruthy();

    repositoryNow = new Date(now.getTime() + 21 * 60_000);
    const expiredPreparation = await repository.getXeroMutationPreparation(preparationId!);
    if (!expiredPreparation) throw new Error("prepared contact mutation is missing");
    // Model the losing begin-write connection observing expiry first. It may
    // mark the preparation EXPIRED, but must not poison the Case reservation.
    await expireMutationPreparation(repository, expiredPreparation);
    const second = compiledContactCase({
      caseId: "prepared-contact-successor",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "US", registryScheme: "IRS", number: "STALE-123" },
    });
    await expect(repository.createOrAdvanceAccountingCase({
      binding: binding(),
      compiled: second,
      compiledPlanHash: planHash(second),
      // Deliberately backdated: recovery must use the repository-owned clock.
      now: new Date(now.getTime() - 24 * 60 * 60_000),
    })).resolves.toMatchObject({ mode: "CREATED" });

    await expect(repository.getBoundAccountingCase({
      binding: binding(), caseId: first.caseId, version: first.version,
    })).resolves.toMatchObject({
      state: "TERMINAL",
      operations: [expect.objectContaining({
        state: "BLOCKED_VALIDATION",
        errorReceipt: expect.objectContaining({
          receiptType: "ACCOUNTING_CASE_NO_WRITE_STARTED",
          disposition: "ABANDONED",
          mutationRequestAbsent: true,
          providerCallAbsentByPermitInvariant: true,
        }),
      })],
    });
    await expect(repository.getXeroMutationPreparation(preparationId!)).resolves.toMatchObject({
      state: "EXPIRED",
    });
  });

  it("treats a missing durable target row as expired instead of trusting the Case lease copy", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const first = compiledContactCase({
      caseId: "prepared-contact-missing-target-owner",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "SG", registryScheme: "ACRA", number: "MISSING-123" },
    });
    await createCase(repository, binding(), first);
    await preflightCase(repository, "prepared-contact-missing-target-owner", binding(), first);

    const second = compiledContactCase({
      caseId: "prepared-contact-missing-target-successor",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "US", registryScheme: "IRS", number: "MISSING-123" },
    });
    await expect(repository.createOrAdvanceAccountingCase({
      binding: binding(),
      compiled: second,
      compiledPlanHash: planHash(second),
      now,
    })).resolves.toMatchObject({ mode: "CREATED" });
    await expect(repository.getBoundAccountingCase({
      binding: binding(), caseId: first.caseId, version: first.version,
    })).resolves.toMatchObject({
      state: "TERMINAL",
      operations: [expect.objectContaining({
        state: "BLOCKED_VALIDATION",
        errorReceipt: expect.objectContaining({
          receiptType: "ACCOUNTING_CASE_NO_WRITE_STARTED",
          mutationRequestAbsent: true,
        }),
      })],
    });
  });

  it("does not let a future caller timestamp steal a live PREPARED contact reservation", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    await seedLiveTarget(repository, binding());
    const first = compiledContactCase({
      caseId: "prepared-contact-live-owner",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "SG", registryScheme: "ACRA", number: "LIVE-123" },
    });
    await createCase(repository, binding(), first);
    await preflightCase(repository, "prepared-contact-live-owner", binding(), first);

    const second = compiledContactCase({
      caseId: "prepared-contact-future-attacker",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "US", registryScheme: "IRS", number: "LIVE-123" },
    });
    await expect(repository.createOrAdvanceAccountingCase({
      binding: binding(),
      compiled: second,
      compiledPlanHash: planHash(second),
      now: new Date(now.getTime() + 24 * 60 * 60_000),
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reasonCodes: ["ACCOUNTING_CASE_CONTACT_BARE_NUMBER_ALREADY_RESERVED"] },
    });
  });

  it("does not let a backdated caller persist an already-expired PREPARED operation", async () => {
    let repositoryNow = now;
    const repository = new InMemoryAccountingRepository({ now: () => repositoryNow });
    const value = compiledContactCase({
      caseId: "prepared-contact-backdated-preflight",
      identity: { kind: "LEGAL_REGISTRY", jurisdiction: "SG", registryScheme: "ACRA", number: "OLD-123" },
    });
    const caseBinding = binding();
    await createCase(repository, caseBinding, value);
    const prepared = await preparedPreflight(repository, value, caseBinding, "backdated-preflight");
    repositoryNow = new Date(now.getTime() + 21 * 60_000);
    const requestId = "backdated-preflight-request";
    const compiledPlanHash = planHash(value, caseBinding);
    const preflightReceipt = preflightReceiptForTest(value, prepared.operations);
    await expect(repository.recordAccountingCasePreflight({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: compiledPlanHash,
      preflightReceipt,
      preflightReceiptHash: accountingCasePreflightReceiptHash({
        binding: caseBinding,
        caseId: value.caseId,
        version: value.version,
        compiledPlanHash,
        requestId,
        preflightReceipt,
      }),
      operations: prepared.operations,
      // Deliberately backdated before the preparation expiry.
      now,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repository.getBoundAccountingCase({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
    })).resolves.toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      operations: [expect.objectContaining({ state: "PENDING" })],
    });
  });

  it("permanently blocks transfer after a durable mutation request exists even when the preparation expires", async () => {
    let repositoryNow = now;
    const repository = new InMemoryAccountingRepository({ now: () => repositoryNow });
    const first = compiledContactCase({
      caseId: "prepared-contact-claimed-owner",
      identity: { kind: "PROVIDER_TENANT_ACCOUNT", providerId: "xero", namespace: "AR", number: "CLAIMED-123" },
    });
    await createCase(repository, binding(), first);
    await preflightCase(repository, "prepared-contact-claimed-owner", binding(), first);
    const prepared = await repository.getBoundAccountingCase({
      binding: binding(), caseId: first.caseId, version: first.version,
    });
    const preparationId = prepared?.operations[0]?.preparationId;
    if (!preparationId) throw new Error("prepared contact has no preparation");
    const preparation = await repository.getXeroMutationPreparation(preparationId);
    if (!preparation) throw new Error("prepared contact mutation is missing");
    await confirmMutation(repository, preparation, "claimed-contact-mutation");

    repositoryNow = new Date(now.getTime() + 21 * 60_000);
    const second = compiledContactCase({
      caseId: "prepared-contact-claimed-successor",
      identity: { kind: "PROVIDER_TENANT_ACCOUNT", providerId: "xero", namespace: "AP", number: "CLAIMED-123" },
    });
    await expect(repository.createOrAdvanceAccountingCase({
      binding: binding(), compiled: second, compiledPlanHash: planHash(second), now: repositoryNow,
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reasonCodes: ["ACCOUNTING_CASE_CONTACT_BARE_NUMBER_ALREADY_RESERVED"] },
    });
    await expect(repository.getBoundAccountingCase({
      binding: binding(), caseId: first.caseId, version: first.version,
    })).resolves.toMatchObject({
      state: "PREFLIGHTED",
      operations: [expect.objectContaining({ state: "PREPARED" })],
    });
    const retained = await repository.getBoundAccountingCase({
      binding: binding(), caseId: first.caseId, version: first.version,
    });
    expect(retained?.operations[0]).not.toHaveProperty("errorReceipt");
  });

  it("atomically rejects the same active PENDING business coordinate at Case creation", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const first = compileAccountingCase({ ...structuredClone(fixture), caseId: "cross-case-business-a" });
    const second = compileAccountingCase({ ...structuredClone(fixture), caseId: "cross-case-business-b" });
    await createCase(repository, binding(), first);
    await expect(createCase(repository, binding(), second)).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
        duplicateCaseId: first.caseId,
        duplicateCaseVersion: 1,
        providerMutationPossible: false,
      },
    });
    await expect(repository.getBoundAccountingCase({
      binding: binding(), caseId: second.caseId, version: 1,
    })).resolves.toBeUndefined();
  });

  it("keeps a formal document number reserved when another Case changes its date and amount", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const first = compiledSingleDocument({
      caseId: "cross-case-formal-a",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
    });
    const second = compiledSingleDocument({
      caseId: "cross-case-formal-b",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: "2026-07-03",
      dueDate: "2026-08-02",
      unitAmount: "250.00",
      declaredNet: "5000.00",
      declaredTax: "450.00",
      declaredGross: "5450.00",
    });
    expect(first.operations[0]?.businessIdentity.kind).toBe("LEDGER_DOCUMENT_OCCURRENCE");
    expect(second.operations[0]?.businessIdentityHash).toBe(first.operations[0]?.businessIdentityHash);
    expect(second.operations[0]?.canonicalPayloadHash).not.toBe(first.operations[0]?.canonicalPayloadHash);

    await createCase(repository, binding(), first);
    await preflightCase(repository, "cross-case-formal-owner-a", binding(), first);
    await expect(createCase(repository, binding(), second)).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
          duplicateCaseId: first.caseId,
          duplicateCaseVersion: 1,
        },
      });
  });

  it("uses the server-resolved contact binding as the document key with or without typed resolution evidence", () => {
    const withoutTypedEvidence = compiledSingleDocument({
      caseId: "cross-case-contact-representation-a",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      contactDurableIdentity: null,
    });
    const withTypedEvidence = compiledSingleDocument({
      caseId: "cross-case-contact-representation-b",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      contactDurableIdentity: {
        kind: "LEGAL_REGISTRY",
        jurisdiction: "SG",
        registryScheme: "ACRA_UEN",
        number: "201900001A",
      },
    });

    expect(withTypedEvidence.operations[0]?.canonicalPayloadHash)
      .not.toBe(withoutTypedEvidence.operations[0]?.canonicalPayloadHash);
    expect(withTypedEvidence.operations[0]?.businessIdentityHash)
      .toBe(withoutTypedEvidence.operations[0]?.businessIdentityHash);
    expect(withTypedEvidence.operations[0]?.businessReservation)
      .toEqual(withoutTypedEvidence.operations[0]?.businessReservation);
  });

  it("cannot bypass a formal reservation by switching the same reference to recurring and changing its date", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const formal = compiledSingleDocument({
      caseId: "cross-case-reference-kind-a",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
    });
    const switched = compiledSingleDocument({
      caseId: "cross-case-reference-kind-b",
      referenceKind: "GENERIC_RECURRING_REFERENCE",
      documentDate: "2026-08-02",
      dueDate: "2026-09-01",
      unitAmount: "250.00",
      declaredNet: "5000.00",
      declaredTax: "450.00",
      declaredGross: "5450.00",
    });

    expect(formal.operations[0]?.businessIdentity.kind).toBe("LEDGER_DOCUMENT_OCCURRENCE");
    expect(switched.operations[0]?.businessIdentity.kind).toBe("LEDGER_DOCUMENT_OCCURRENCE");
    expect(switched.operations[0]?.canonicalPayloadHash).not.toBe(formal.operations[0]?.canonicalPayloadHash);

    await createCase(repository, binding(), formal);
    await preflightCase(repository, "cross-case-reference-kind-owner-a", binding(), formal);
    await expect(createCase(repository, binding(), switched)).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
        duplicateCaseId: formal.caseId,
        duplicateCaseVersion: 1,
      },
    });
  });

  it("allows a recurring reference on a different date but reserves same-date economic revisions", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const businessAuthority: ReturnType<typeof testXeroBusinessAuthorityProfile> = {
      ...testXeroBusinessAuthorityProfile(TEST_XERO_TENANT_ID),
      recurring_series_authorities: [{
        authority_id: "test-recurring-inv-2026-0702",
        revision: 1,
        route: "SALES_INVOICE",
        contact_id: "22222222-2222-4222-8222-222222222222",
        reference: "INV-2026-0702",
        authoritative_provider_field: "REFERENCE",
        normalization_version: "xero-reference-coordinate:v1",
        occurrence_key: "DOCUMENT_DATE",
        verification_receipt_sha256: "e".repeat(64),
      }],
    };
    const july = compiledSingleDocument({
      caseId: "cross-case-recurring-july",
      referenceKind: "GENERIC_RECURRING_REFERENCE",
      businessAuthority,
    });
    const august = compiledSingleDocument({
      caseId: "cross-case-recurring-august",
      referenceKind: "GENERIC_RECURRING_REFERENCE",
      documentDate: "2026-08-02",
      dueDate: "2026-09-01",
      businessAuthority,
    });
    const julyRevision = compiledSingleDocument({
      caseId: "cross-case-recurring-july-revision",
      referenceKind: "GENERIC_RECURRING_REFERENCE",
      unitAmount: "250.00",
      declaredNet: "5000.00",
      declaredTax: "450.00",
      declaredGross: "5450.00",
      businessAuthority,
    });
    expect(july.operations[0]?.businessIdentity.kind).toBe("LEDGER_DOCUMENT_OCCURRENCE");
    expect(august.operations[0]?.businessIdentityHash).not.toBe(july.operations[0]?.businessIdentityHash);
    expect(julyRevision.operations[0]?.businessIdentityHash).toBe(july.operations[0]?.businessIdentityHash);
    expect(julyRevision.operations[0]?.canonicalPayloadHash).not.toBe(july.operations[0]?.canonicalPayloadHash);

    const recurringBinding = binding({ tenantId: TEST_XERO_TENANT_ID });
    await createCase(repository, recurringBinding, july);
    await preflightCase(repository, "cross-case-recurring-july-owner", recurringBinding, july);
    await createCase(repository, recurringBinding, august);
    await expect(preflightCase(repository, "cross-case-recurring-august-owner", recurringBinding, august))
      .resolves.toBeUndefined();
    await expect(createCase(repository, recurringBinding, julyRevision)).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
        duplicateCaseId: july.caseId,
        duplicateCaseVersion: 1,
      },
    });
  });

  it("reserves a create business payload across source/request coordinates in the mutation kernel", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const makePreparation = async (suffix: string, externalReference: string, name: string) => repository.createXeroMutationPreparation({
      preparationId: `business-preparation-${suffix}`,
      actorId: binding().actorId,
      workspaceId: binding().workspaceId,
      tenantId: binding().tenantId,
      installationId: binding().installationId,
      bindingId: binding().bindingId,
      bindingRevision: binding().bindingRevision,
      connectionId: binding().connectionId,
      targetSessionId: binding().targetSessionId,
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload: {
        schemaVersion: "test-contact-v1",
        objectType: "CONTACT",
        operation: "CREATE",
        externalReference,
        target: { name, companyNumber: "SG-123456" },
      },
      canonicalPayloadHash: hashObject({
        schemaVersion: "test-contact-v1",
        objectType: "CONTACT",
        operation: "CREATE",
        externalReference,
        target: { name, companyNumber: "SG-123456" },
      }),
      sourceRef: `case:${suffix}`,
      sourceUnitKey: `operation:${suffix}`,
      sourceSha256: hashObject({ source: suffix }),
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      confirmationSummaryHash: hashObject({ summary: suffix }),
      confirmationPhraseHash: hashObject({ phrase: suffix }),
      expiresAt: new Date(now.getTime() + 20 * 60_000),
      now,
    });
    const first = await makePreparation("a", "ZC:test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Legal Entity A");
    await confirmMutation(repository, first, "business-mutation-a");
    const second = await makePreparation("b", "ZC:test:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Renamed Legal Entity A");

    await expect(confirmMutation(repository, second, "business-mutation-b")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { duplicateMutationRequestId: "business-mutation-a" },
    });
  });

  it("makes exact invoice/credit economics an unavoidable READBACK_VERIFIED projection gate", async () => {
    for (const [route, tampered] of [
      ["SALES_INVOICE", true],
      ["CUSTOMER_CREDIT", true],
      ["SUPPLIER_BILL", false],
      ["SUPPLIER_CREDIT", false],
    ] as const) {
      const repository = new InMemoryAccountingRepository({ now: () => now });
      const value = compiled(1);
      await createCase(repository, binding(), value);
      const requestId = `economic-projection:${route}:${tampered ? "tampered" : "exact"}`;
      await claimCase(repository, requestId, binding(), value);
      const operation = value.operations.find((candidate) => candidate.nativeRoute === route);
      if (!operation) throw new Error(`fixture has no ${route} operation`);
      const mutationRequestId = `economic-mutation:${route}:${tampered ? "tampered" : "exact"}`;
      await recordCaseEconomicMutation(repository, value, operation, mutationRequestId, tampered);
      const projection = repository.projectAccountingCaseOperationFromMutation({
        binding: binding(),
        caseId: value.caseId,
        version: value.version,
        operationId: operation.operationId,
        requestId,
        expectedStates: ["PREPARED"],
        desiredState: "READBACK_VERIFIED",
        mutationRequestId,
        now,
      });
      if (tampered) {
        await expect(projection).resolves.toMatchObject({
          operations: expect.arrayContaining([
            expect.objectContaining({
              operation: expect.objectContaining({ operationId: operation.operationId }),
              state: "READBACK_MISMATCH",
              errorReceipt: expect.objectContaining({ mutationState: "READBACK_MISMATCH" }),
            }),
          ]),
        });
        const durableMutation = await repository.getXeroMutationRequest(mutationRequestId);
        expect(durableMutation).toMatchObject({
          state: "READBACK_MISMATCH",
          readbackMismatchReceipt: {
            receiptType: "ACCOUNTING_CASE_ECONOMIC_READBACK_MISMATCH",
            mismatchType: "ACCOUNTING_CASE_ECONOMICS",
            reasonCodes: expect.arrayContaining([expect.stringMatching(/MISMATCH$/u)]),
          },
        });
        expect(durableMutation).not.toHaveProperty("verifiedAt");
        await expect(repository.getBoundAccountingCase({
          binding: binding(), caseId: value.caseId, version: value.version,
        })).resolves.toMatchObject({
          operations: expect.arrayContaining([
            expect.objectContaining({ operation: expect.objectContaining({ operationId: operation.operationId }), state: "READBACK_MISMATCH" }),
          ]),
        });
      } else {
        await expect(projection).resolves.toMatchObject({
          operations: expect.arrayContaining([
            expect.objectContaining({ operation: expect.objectContaining({ operationId: operation.operationId }), state: "READBACK_VERIFIED" }),
          ]),
        });
      }
    }
  });

  it("isolates the complete binding tuple without revealing or mutating another bound case", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const owner = binding();
    const value = compiled(1);
    await createCase(repository, owner, value);

    const mismatches: AccountingCaseBinding[] = [
      binding({ actorId: "workspace-1:user:user-2" }),
      binding({ workspaceId: "workspace-2" }),
      binding({ subjectType: "TEAM" }),
      binding({ subjectId: "user-2" }),
      binding({ agentId: "accounting-agent-2" }),
      binding({ installationId: "installation-2" }),
      binding({ bindingId: "binding-2" }),
      binding({ bindingRevision: 4 }),
      binding({ connectionId: "connection-2" }),
      binding({ tenantId: "tenant-other" }),
      binding({ targetSessionId: "target-session-2" }),
      binding({ targetSessionHash: "b".repeat(64) }),
      binding({ targetSessionExpiresAt: new Date("2026-08-13T04:31:00.000Z") }),
    ];

    for (const mismatch of mismatches) {
      await expect(repository.getBoundAccountingCase({
        binding: mismatch,
        caseId: value.caseId,
      })).resolves.toBeUndefined();
      await expect(repository.claimAccountingCaseExecution({
        binding: mismatch,
        caseId: value.caseId,
        version: value.version,
        requestId: "foreign-request",
        expectedPlanHash: planHash(value),
        now,
      })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }

    await expect(repository.getBoundAccountingCase({ binding: owner, caseId: value.caseId }))
      .resolves.toMatchObject({ compiledPlanHash: planHash(value), state: value.status });
  });

  it("creates version 1, replays the same plan idempotently, and advances only by one CAS version", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const first = compiled(1);
    const second = compiled(2);

    await expect(createCase(repository, binding(), first)).resolves.toMatchObject({
      mode: "CREATED",
      record: { compiled: { version: 1 } },
    });
    await expect(createCase(repository, binding(), first)).resolves.toMatchObject({
      mode: "IDEMPOTENT_REPLAY",
      record: { compiledPlanHash: planHash(first) },
    });
    await expect(createCase(repository, binding(), second)).resolves.toMatchObject({
      mode: "ADVANCED",
      record: { compiled: { version: 2 } },
    });

    await expect(createCase(repository, binding(), compiled(4)))
      .rejects.toMatchObject({ code: "CONFLICT", details: { currentVersion: 2 } });
  });

  it("serializes concurrent advances so one wins and an identical second plan becomes a replay", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    await createCase(repository);
    const second = compiled(2);

    const results = await Promise.all([
      createCase(repository, binding(), second),
      createCase(repository, binding(), second),
    ]);
    expect(results.map((result) => result.mode).sort()).toEqual(["ADVANCED", "IDEMPOTENT_REPLAY"]);
    await expect(repository.getBoundAccountingCase({ binding: binding(), caseId: second.caseId }))
      .resolves.toMatchObject({ compiled: { version: 2 }, compiledPlanHash: planHash(second) });
  });

  it("rejects execution of a stale version after the head advances", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const first = compiled(1);
    const second = compiled(2);
    await createCase(repository, binding(), first);
    await createCase(repository, binding(), second);

    await expect(claimCase(repository, "stale-execution", binding(), first))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("atomically preflights the exact operation set and replays only the same owner and receipt", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    const caseBinding = binding();
    await createCase(repository, caseBinding, value);
    const requestId = "preflight-owner";
    const expectedPlanHash = planHash(value, caseBinding);
    const prepared = await preparedPreflight(repository, value, caseBinding, "atomic-preflight");
    const preflightReceipt = preflightReceiptForTest(value, prepared.operations, {
      authorityReceiptHash: "b".repeat(64),
      checkedActionCount: value.operations.length,
    });
    const preflightReceiptHash = accountingCasePreflightReceiptHash({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      compiledPlanHash: expectedPlanHash,
      requestId,
      preflightReceipt,
    });
    const operations = prepared.operations;
    const input = {
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash,
      preflightReceipt,
      preflightReceiptHash,
      operations,
      now,
    };

    await expect(repository.recordAccountingCasePreflight(input)).resolves.toMatchObject({
      mode: "PREFLIGHTED",
      record: {
        state: "PREFLIGHTED",
        preflightRequestId: requestId,
        preflightReceiptHash,
        operations: expect.arrayContaining([
          expect.objectContaining({
            state: "PREPARED",
            preparationId: prepared.preparations[0]!.preparationId,
            preparationCanonicalPayloadHash: prepared.preparations[0]!.canonicalPayloadHash,
            sourceSha256: prepared.preparations[0]!.sourceSha256,
          }),
        ]),
      },
    });
    await expect(repository.recordAccountingCasePreflight(input)).resolves.toMatchObject({
      mode: "IDEMPOTENT_REPLAY",
    });
    await expect(repository.recordAccountingCasePreflight({
      ...input,
      requestId: "other-owner",
      preflightReceiptHash: accountingCasePreflightReceiptHash({
        binding: caseBinding,
        caseId: value.caseId,
        version: value.version,
        compiledPlanHash: expectedPlanHash,
        requestId: "other-owner",
        preflightReceipt,
      }),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.createOrAdvanceAccountingCase({
      binding: caseBinding,
      compiled: compiled(2),
      compiledPlanHash: planHash(compiled(2), caseBinding),
      now,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.claimAccountingCaseExecution({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      requestId: "other-owner",
      expectedPlanHash,
      now,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repository.claimAccountingCaseExecution({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash,
      now,
    })).resolves.toMatchObject({ mode: "CLAIMED", record: { state: "EXECUTING" } });
  });

  it("rolls back an incomplete or invalid preflight without partially changing operations", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    const caseBinding = binding();
    await createCase(repository, caseBinding, value);
    const expectedPlanHash = planHash(value, caseBinding);
    const requestId = "invalid-preflight";
    const prepared = await preparedPreflight(repository, value, caseBinding, "incomplete-preflight");
    const preflightReceipt = preflightReceiptForTest(value, prepared.operations, { checked: true });
    const preflightReceiptHash = accountingCasePreflightReceiptHash({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      compiledPlanHash: expectedPlanHash,
      requestId,
      preflightReceipt,
    });
    await expect(repository.recordAccountingCasePreflight({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash,
      preflightReceipt,
      preflightReceiptHash,
      operations: prepared.operations.slice(0, -1),
      now,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.getBoundAccountingCase({ binding: caseBinding, caseId: value.caseId }))
      .resolves.toMatchObject({
        state: value.status,
        operations: value.operations.map(() => expect.objectContaining({ state: "PENDING" })),
      });
  });

  it("makes same-request execution claims resumable and rejects a different concurrent request", async () => {
    const sameRequestRepository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    const caseBinding = binding();
    await createCase(sameRequestRepository, caseBinding, value);
    await preflightCase(sameRequestRepository, "execute-same", caseBinding, value);
    const claim = (requestId: string) => sameRequestRepository.claimAccountingCaseExecution({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: planHash(value, caseBinding),
      now,
    });
    const same = await Promise.all([
      claim("execute-same"),
      claim("execute-same"),
    ]);
    expect(same.map((result) => result.mode).sort()).toEqual(["CLAIMED", "RESUME"]);

    const differentRequestRepository = new InMemoryAccountingRepository({ now: () => now });
    await createCase(differentRequestRepository, caseBinding, value);
    await preflightCase(differentRequestRepository, "execute-a", caseBinding, value);
    const differentClaim = (requestId: string) => differentRequestRepository.claimAccountingCaseExecution({
      binding: caseBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: planHash(value, caseBinding),
      now,
    });
    const different = await Promise.allSettled([
      differentClaim("execute-a"),
      differentClaim("execute-b"),
    ]);
    expect(different.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(different.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = different.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "CONFLICT" } });
  });

  it("atomically reseals every stale PREPARED operation, appends one chain link, and preserves the original receipt", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    const caseBinding = binding();
    await seedLiveTarget(repository, caseBinding);
    await createCase(repository, caseBinding, value);
    await preflightCase(repository, "execute-reseal", caseBinding, value);
    const before = await repository.getBoundAccountingCase({ binding: caseBinding, caseId: value.caseId });
    const originalReceipt = structuredClone(before?.preflightReceipt);
    const originalReceiptHash = before?.preflightReceiptHash;
    const originalPreparationIds = before?.operations.map((operation) => operation.preparationId);
    const input = await resealInputForTest(repository, value, "execute-reseal", caseBinding);

    await expect(repository.resealAndClaimAccountingCaseExecution(input)).resolves.toMatchObject({
      mode: "RESEALED_AND_CLAIMED",
      record: {
        state: "EXECUTING",
        preflightResealRevision: 1,
        originalPreflightReceiptHash: originalReceiptHash,
        effectivePreflightSealHash: input.resealReceiptHash,
      },
    });
    const after = await repository.getBoundAccountingCase({ binding: caseBinding, caseId: value.caseId });
    expect(after?.preflightReceipt).toEqual(originalReceipt);
    expect(after?.preflightReceiptHash).toBe(originalReceiptHash);
    expect(after?.preflightReseals).toHaveLength(1);
    expect(after?.operations.map((operation) => operation.originalPreparationId)).toEqual(originalPreparationIds);
    expect(after?.operations.map((operation) => operation.preparationId)).toEqual(
      input.operations.map((operation) => operation.newPreparationId),
    );
  });

  it("reseals TTL-expired zero-request preparations while the Case operations remain PREPARED", async () => {
    let repositoryNow = now;
    const repository = new InMemoryAccountingRepository({ now: () => repositoryNow });
    const value = compiled(1);
    const caseBinding = binding();
    await seedLiveTarget(repository, caseBinding);
    await createCase(repository, caseBinding, value);
    await preflightCase(repository, "execute-expired-zero-request", caseBinding, value);
    const before = await repository.getBoundAccountingCase({ binding: caseBinding, caseId: value.caseId });
    for (const operation of before!.operations) {
      const preparation = await repository.getXeroMutationPreparation(operation.preparationId!);
      repositoryNow = new Date(preparation!.expiresAt.getTime() + 1);
      await expireMutationPreparation(repository, preparation!);
      await expect(repository.getXeroMutationRequest(`expired:${preparation!.preparationId}`))
        .resolves.toBeUndefined();
    }

    const input = await resealInputForTest(
      repository,
      value,
      "execute-expired-zero-request",
      caseBinding,
    );
    await expect(repository.resealAndClaimAccountingCaseExecution(input)).resolves.toMatchObject({
      mode: "RESEALED_AND_CLAIMED",
      record: { state: "EXECUTING", preflightResealRevision: 1 },
    });
  });

  it("rejects reseal swaps, hash/source/binding drift, existing requests, and insufficient replacement runway", async () => {
    const mutators: Array<(input: Awaited<ReturnType<typeof resealInputForTest>>) => Promise<void> | void> = [
      (input) => { input.operations[0]!.preparationCanonicalPayloadHash = "f".repeat(64); },
      (input) => { input.operations[0]!.sourceSha256 = "e".repeat(64); },
      (input) => { input.operations[0]!.oldPreparationId = "swapped-preparation-id"; },
      (input) => { input.binding = binding({ bindingRevision: 2 }); },
      async (input) => {
        const replacement = await repositoryForMutation.getXeroMutationPreparation(
          input.operations[0]!.newPreparationId,
        );
        if (!replacement) throw new Error("missing replacement");
        input.operations[0]!.newPreparationExpiresAt = input.now.toISOString();
      },
    ];
    let repositoryForMutation = new InMemoryAccountingRepository({ now: () => now });
    for (const [index, mutate] of mutators.entries()) {
      repositoryForMutation = new InMemoryAccountingRepository({ now: () => now });
      const value = compiled(1);
      const caseBinding = binding();
      await seedLiveTarget(repositoryForMutation, caseBinding);
      await createCase(repositoryForMutation, caseBinding, value);
      await preflightCase(repositoryForMutation, "execute-reseal-invalid", caseBinding, value);
      const input = await resealInputForTest(
        repositoryForMutation,
        value,
        `execute-reseal-invalid-${index}`,
        caseBinding,
      );
      await mutate(input);
      await expect(repositoryForMutation.resealAndClaimAccountingCaseExecution(input))
        .rejects.toMatchObject({ code: expect.stringMatching(/^(?:VALIDATION_FAILED|NOT_FOUND)$/u) });
      await expect(repositoryForMutation.getBoundAccountingCase({ binding: caseBinding, caseId: value.caseId }))
        .resolves.toMatchObject({ state: "PREFLIGHTED", preflightResealRevision: 0 });
    }

    const requestRepository = new InMemoryAccountingRepository({ now: () => now });
    const requestValue = compiled(1);
    await seedLiveTarget(requestRepository, binding());
    await createCase(requestRepository, binding(), requestValue);
    await preflightCase(requestRepository, "execute-existing-request", binding(), requestValue);
    const current = await requestRepository.getBoundAccountingCase({ binding: binding(), caseId: requestValue.caseId });
    const operation = current!.operations[0]!;
    const old = await requestRepository.getXeroMutationPreparation(operation.preparationId!);
    await confirmMutation(requestRepository, old!, "existing-reseal-request");
    const requestInput = await resealInputForTest(
      requestRepository,
      requestValue,
      "execute-existing-request",
    );
    await expect(requestRepository.resealAndClaimAccountingCaseExecution(requestInput))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("serializes concurrent reseals so only one chain link and execution claim can win", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    await seedLiveTarget(repository, binding());
    await createCase(repository, binding(), value);
    await preflightCase(repository, "execute-concurrent-reseal", binding(), value);
    const first = await resealInputForTest(repository, value, "execute-concurrent-reseal", binding());
    const second = await resealInputForTest(
      repository,
      value,
      "execute-concurrent-reseal",
      binding(),
      new Date(now.getTime() + 21 * 60_000 + 1),
    );
    const results = await Promise.all([
      repository.resealAndClaimAccountingCaseExecution(first),
      repository.resealAndClaimAccountingCaseExecution(second),
    ]);
    expect(results.map((result) => result.mode).sort()).toEqual(["RESEALED_AND_CLAIMED", "RESUME"]);
    await expect(repository.getBoundAccountingCase({ binding: binding(), caseId: value.caseId }))
      .resolves.toMatchObject({
        state: "EXECUTING",
        preflightResealRevision: 1,
        preflightReseals: [expect.objectContaining({ revision: 1 })],
      });
  });

  it("rejects a target session at the exact expiry boundary", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const expired = binding({ targetSessionExpiresAt: now });
    const value = compiled(1);
    await createCase(repository, expired, value);

    await expect(claimCase(repository, "expired-target", expired, value))
      .rejects.toMatchObject({ code: "TARGET_SESSION_EXPIRED" });
  });

  it("keeps expired target sessions referenced by a durable Case or residual grant while cleaning unrelated targets", async () => {
    const cleanupTime = new Date(now.getTime() + 40 * 60_000);
    let repositoryTime = now;
    const repository = new InMemoryAccountingRepository({ now: () => repositoryTime });
    const originalBinding = binding({
      targetSessionId: "target-session-cleanup-case",
      targetSessionHash: "1".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 60_000),
    });
    const successorBinding = binding({
      targetSessionId: "target-session-cleanup-grant",
      targetSessionHash: "2".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 30 * 60_000),
    });
    const unrelatedBinding = binding({
      targetSessionId: "target-session-cleanup-unrelated",
      targetSessionHash: "3".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 30 * 60_000),
    });
    await seedLiveTarget(repository, originalBinding);
    for (const caseBinding of [successorBinding, unrelatedBinding]) {
      await repository.saveLedgerTargetSession({
        sessionId: caseBinding.targetSessionId,
        sessionHash: caseBinding.targetSessionHash,
        installationId: caseBinding.installationId,
        bindingId: caseBinding.bindingId,
        connectionId: caseBinding.connectionId,
        bindingRevision: caseBinding.bindingRevision,
        createdAt: now,
        expiresAt: caseBinding.targetSessionExpiresAt,
      });
    }
    const value = compiledTwoInvoiceCase("case-cleanup-recovery-grant");
    const requestId = "execute-cleanup-recovery-grant";
    await createCase(repository, originalBinding, value);
    await claimCase(repository, requestId, originalBinding, value);
    const writtenOperation = value.operations[0]!;
    const residualOperation = value.operations[1]!;
    const writtenPreparation = await casePreparation(
      repository,
      value,
      writtenOperation.operationId,
      originalBinding,
    );
    const mutationRequestId = "mutation-cleanup-recovery-grant";
    await confirmMutation(repository, writtenPreparation, mutationRequestId);
    repositoryTime = new Date(originalBinding.targetSessionExpiresAt.getTime() + 1);
    await repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: successorBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: planHash(value, originalBinding),
      now: repositoryTime,
    });
    await recordVerifiedMutation(
      repository,
      writtenPreparation,
      mutationRequestId,
      writtenOperation,
      "xero:cleanup-recovery-grant",
    );
    await repository.projectAccountingCaseOperationFromMutation({
      binding: successorBinding,
      caseId: value.caseId,
      version: value.version,
      operationId: writtenOperation.operationId,
      requestId,
      expectedStates: ["WRITE_IN_FLIGHT"],
      desiredState: "READBACK_VERIFIED",
      mutationRequestId,
      accessMode: "RECOVERY_GET_ONLY",
      now: repositoryTime,
    });
    const successorCaseId = `recovery-${hashObject({ kind: "cleanup-successor" })}`;
    const grantId = `acrg_${hashObject({ kind: "cleanup-grant" })}`;
    const template = accountingCaseRecoveryResidualContinuationTemplate({
      source: value,
      successorCaseId,
      residualOperationIds: [residualOperation.operationId],
    });
    await repository.completeExpiredTargetAccountingCaseRecovery({
      currentAccessBinding: successorBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      continuation: {
        grantId,
        successorCaseId,
        template,
        templateHash: accountingCaseContinuationTemplateHash(template),
      },
      reasonReceipt: { receiptType: "TEST_EXPIRED_TARGET_RECOVERY_CLEANUP" },
      now: repositoryTime,
    });
    await expect(repository.revokeLedgerTargetSession(
      successorBinding.targetSessionHash,
      successorBinding.installationId,
      repositoryTime,
    )).resolves.toBe(true);

    repositoryTime = cleanupTime;
    await expect(repository.cleanupExpiredEphemeral(cleanupTime, 1)).resolves.toMatchObject({
      deleted: { ledgerTargetSessions: 1 },
    });
    await expect(repository.resolveLedgerTargetSession({
      sessionHash: originalBinding.targetSessionHash,
      installationId: originalBinding.installationId,
      workspaceId: originalBinding.workspaceId,
      subjectType: originalBinding.subjectType,
      subjectId: originalBinding.subjectId,
      agentId: originalBinding.agentId,
      now,
    })).resolves.toBeDefined();
    await expect(repository.saveLedgerTargetSession({
      sessionId: successorBinding.targetSessionId,
      sessionHash: successorBinding.targetSessionHash,
      installationId: successorBinding.installationId,
      bindingId: successorBinding.bindingId,
      connectionId: successorBinding.connectionId,
      bindingRevision: successorBinding.bindingRevision,
      createdAt: now,
      expiresAt: successorBinding.targetSessionExpiresAt,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repository.resolveLedgerTargetSession({
      sessionHash: unrelatedBinding.targetSessionHash,
      installationId: unrelatedBinding.installationId,
      workspaceId: unrelatedBinding.workspaceId,
      subjectType: unrelatedBinding.subjectType,
      subjectId: unrelatedBinding.subjectId,
      agentId: unrelatedBinding.agentId,
      now,
    })).resolves.toBeUndefined();
  });

  it("adopts an expired-target EXECUTING crash window only when a durable write claim exists", async () => {
    const originalBinding = binding({
      targetSessionId: "target-session-crashed",
      targetSessionHash: "c".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 60_000),
    });
    const adoptionTime = new Date(now.getTime() + 120_000);
    const renewedBinding = binding({
      targetSessionId: "target-session-recovery",
      targetSessionHash: "d".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 30 * 60_000),
    });
    let repositoryTime = now;
    const repository = new InMemoryAccountingRepository({ now: () => repositoryTime });
    const value = compiled(1);
    const requestId = "execute-expired-target-recovery";
    await seedLiveTarget(repository, originalBinding);
    await repository.saveLedgerTargetSession({
      sessionId: renewedBinding.targetSessionId,
      sessionHash: renewedBinding.targetSessionHash,
      installationId: renewedBinding.installationId,
      bindingId: renewedBinding.bindingId,
      connectionId: renewedBinding.connectionId,
      bindingRevision: renewedBinding.bindingRevision,
      createdAt: now,
      expiresAt: renewedBinding.targetSessionExpiresAt,
    });
    await createCase(repository, originalBinding, value);
    await claimCase(repository, requestId, originalBinding, value);
    const operation = value.operations[0]!;
    const preparation = await casePreparation(repository, value, operation.operationId, originalBinding);
    const request = await confirmMutation(repository, preparation, "mutation-expired-target-recovery");
    expect(request.state).toBe("WRITE_IN_FLIGHT");
    await expect(repository.getBoundAccountingCase({
      binding: originalBinding,
      caseId: value.caseId,
      version: value.version,
    })).resolves.toMatchObject({
      state: "EXECUTING",
      operations: expect.arrayContaining([
        expect.objectContaining({
          operation: expect.objectContaining({ operationId: operation.operationId }),
          state: "PREPARED",
        }),
      ]),
    });
    repositoryTime = adoptionTime;

    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: renewedBinding,
      caseId: value.caseId,
      version: value.version,
      requestId: `${requestId}-wrong`,
      expectedPlanHash: planHash(value, originalBinding),
      now: adoptionTime,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: { ...renewedBinding, subjectId: "other-subject" },
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: planHash(value, originalBinding),
      now: adoptionTime,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: {
        ...renewedBinding,
        targetSessionId: "missing-renewed-target",
        targetSessionHash: "9".repeat(64),
      },
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: planHash(value, originalBinding),
      now: adoptionTime,
    })).rejects.toMatchObject({ code: "TARGET_SESSION_EXPIRED" });
    await expect(repository.getBoundAccountingCase({
      binding: originalBinding,
      caseId: value.caseId,
      version: value.version,
    })).resolves.toMatchObject({
      state: "EXECUTING",
      operations: expect.arrayContaining([expect.objectContaining({ state: "PREPARED" })]),
    });

    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: renewedBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: planHash(value, originalBinding),
      now: adoptionTime,
    })).resolves.toMatchObject({
      mode: "ADOPTED",
      record: {
        state: "RECOVERY_REQUIRED",
        executionRequestId: requestId,
        operations: expect.arrayContaining([
          expect.objectContaining({
            operation: expect.objectContaining({ operationId: operation.operationId }),
            state: "WRITE_IN_FLIGHT",
            mutationRequestId: request.mutationRequestId,
          }),
        ]),
      },
    });
  });

  it("rejects expired-target adoption for a plain EXECUTING Case with zero durable mutation requests", async () => {
    let repositoryTime = now;
    const repository = new InMemoryAccountingRepository({ now: () => repositoryTime });
    const originalBinding = binding({
      targetSessionId: "target-session-plain-executing",
      targetSessionHash: "6".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 60_000),
    });
    const renewedBinding = binding({
      targetSessionId: "target-session-plain-recovery",
      targetSessionHash: "7".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 30 * 60_000),
    });
    const adoptionTime = new Date(now.getTime() + 120_000);
    const value = compiledSingleDocument({
      caseId: "case-plain-executing-no-mutation",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
    });
    const requestId = "execute-plain-no-mutation";
    await seedLiveTarget(repository, originalBinding);
    await repository.saveLedgerTargetSession({
      sessionId: renewedBinding.targetSessionId,
      sessionHash: renewedBinding.targetSessionHash,
      installationId: renewedBinding.installationId,
      bindingId: renewedBinding.bindingId,
      connectionId: renewedBinding.connectionId,
      bindingRevision: renewedBinding.bindingRevision,
      createdAt: now,
      expiresAt: renewedBinding.targetSessionExpiresAt,
    });
    await createCase(repository, originalBinding, value);
    await claimCase(repository, requestId, originalBinding, value);
    repositoryTime = adoptionTime;

    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: renewedBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: planHash(value, originalBinding),
      now: adoptionTime,
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reasonCodes: ["NO_POTENTIALLY_WRITTEN_MUTATION_REQUEST"] },
    });
    await expect(repository.getBoundAccountingCase({
      binding: originalBinding,
      caseId: value.caseId,
      version: value.version,
    })).resolves.toMatchObject({ state: "EXECUTING", operations: [expect.objectContaining({ state: "PREPARED" })] });
  });

  it("still adopts after ephemeral cleanup preserves the already-expired Case target row", async () => {
    let repositoryTime = now;
    const repository = new InMemoryAccountingRepository({ now: () => repositoryTime });
    const originalBinding = binding({
      targetSessionId: "target-session-cleaned-expired",
      targetSessionHash: "3".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 60_000),
    });
    const renewedBinding = binding({
      targetSessionId: "target-session-cleaned-renewed",
      targetSessionHash: "4".repeat(64),
      targetSessionExpiresAt: new Date(now.getTime() + 30 * 60_000),
    });
    const adoptionTime = new Date(now.getTime() + 120_000);
    const value = compiledSingleDocument({
      caseId: "case-expired-target-row-cleaned",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
    });
    const requestId = "execute-cleaned-expired-target";
    await seedLiveTarget(repository, originalBinding);
    await repository.saveLedgerTargetSession({
      sessionId: renewedBinding.targetSessionId,
      sessionHash: renewedBinding.targetSessionHash,
      installationId: renewedBinding.installationId,
      bindingId: renewedBinding.bindingId,
      connectionId: renewedBinding.connectionId,
      bindingRevision: renewedBinding.bindingRevision,
      createdAt: now,
      expiresAt: renewedBinding.targetSessionExpiresAt,
    });
    await createCase(repository, originalBinding, value);
    await claimCase(repository, requestId, originalBinding, value);
    const operation = value.operations[0]!;
    const preparation = await casePreparation(repository, value, operation.operationId, originalBinding);
    await confirmMutation(repository, preparation, "mutation-cleaned-expired-target");
    repositoryTime = adoptionTime;
    await expect(repository.cleanupExpiredEphemeral(adoptionTime, 100)).resolves.toMatchObject({
      deleted: { ledgerTargetSessions: 0 },
    });

    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: renewedBinding,
      caseId: value.caseId,
      version: value.version,
      requestId,
      expectedPlanHash: planHash(value, originalBinding),
      now: adoptionTime,
    })).resolves.toMatchObject({
      mode: "ADOPTED",
      record: { state: "RECOVERY_REQUIRED", operations: [expect.objectContaining({ state: "WRITE_IN_FLIGHT" })] },
    });
  });

  it.each(["WRITE_UNCERTAIN", "READBACK_MISMATCH"] as const)(
    "projects a durable %s request while atomically adopting expired-target recovery",
    async (mutationState) => {
      let repositoryTime = now;
      const repository = new InMemoryAccountingRepository({ now: () => repositoryTime });
      const discriminator = mutationState === "WRITE_UNCERTAIN" ? "e" : "f";
      const originalBinding = binding({
        targetSessionId: `target-session-${mutationState.toLowerCase()}`,
        targetSessionHash: discriminator.repeat(64),
        targetSessionExpiresAt: new Date(now.getTime() + 60_000),
      });
      const renewedBinding = binding({
        targetSessionId: `target-session-${mutationState.toLowerCase()}-renewed`,
        targetSessionHash: (mutationState === "WRITE_UNCERTAIN" ? "1" : "2").repeat(64),
        targetSessionExpiresAt: new Date(now.getTime() + 30 * 60_000),
      });
      const adoptionTime = new Date(now.getTime() + 120_000);
      const value = compiledSingleDocument({
        caseId: `case-expired-target-${mutationState.toLowerCase()}`,
        referenceKind: "FORMAL_DOCUMENT_NUMBER",
      });
      const requestId = `execute-${mutationState.toLowerCase()}`;
      await seedLiveTarget(repository, originalBinding);
      await repository.saveLedgerTargetSession({
        sessionId: renewedBinding.targetSessionId,
        sessionHash: renewedBinding.targetSessionHash,
        installationId: renewedBinding.installationId,
        bindingId: renewedBinding.bindingId,
        connectionId: renewedBinding.connectionId,
        bindingRevision: renewedBinding.bindingRevision,
        createdAt: now,
        expiresAt: renewedBinding.targetSessionExpiresAt,
      });
      await createCase(repository, originalBinding, value);
      await claimCase(repository, requestId, originalBinding, value);
      const operation = value.operations[0]!;
      const preparation = await casePreparation(repository, value, operation.operationId, originalBinding);
      const mutationRequestId = `mutation-${mutationState.toLowerCase()}`;
      await confirmMutation(repository, preparation, mutationRequestId);
      const bound = boundMutationInput(preparation, mutationRequestId);
      if (mutationState === "WRITE_UNCERTAIN") {
        await repository.markXeroMutationWriteUnknown(bound);
      } else {
        const xeroObjectId = "xero-mismatch-object";
        const writeReceipt = { providerRequestId: "provider-mismatch" };
        await repository.recordXeroMutationWriteEvidence({ ...bound, xeroObjectId, writeReceipt });
        const readbackCanonicalPayload = { ...preparation.canonicalPayload, deliberatelyDifferent: true };
        const readbackSnapshot = { xeroObjectId, status: "DRAFT", canonicalPayload: readbackCanonicalPayload };
        await repository.markXeroMutationReadbackMismatch({
          ...bound,
          xeroObjectId,
          writeReceipt,
          readbackSnapshot,
          readbackSnapshotHash: hashObject(readbackSnapshot),
          readbackCanonicalPayload,
          readbackPayloadHash: hashObject(readbackCanonicalPayload),
          readbackStatus: "DRAFT",
        });
      }
      repositoryTime = adoptionTime;

      await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
        currentAccessBinding: renewedBinding,
        caseId: value.caseId,
        version: value.version,
        requestId,
        expectedPlanHash: planHash(value, originalBinding),
        now: adoptionTime,
      })).resolves.toMatchObject({
        mode: "ADOPTED",
        record: {
          state: "RECOVERY_REQUIRED",
          operations: [expect.objectContaining({ state: mutationState, mutationRequestId })],
        },
      });
    },
  );

  it("rejects caller-authored mutation evidence on concurrent operation updates", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    await createCase(repository, binding(), value);
    await claimCase(repository);
    const operationId = value.operations[0]!.operationId;
    const transition = (mutationRequestId: string) => repository.updateAccountingCaseOperation({
      binding: binding(),
      caseId: value.caseId,
      version: value.version,
      operationId,
      requestId: "execute-1",
      expectedStates: ["PREPARED"],
      state: "WRITE_IN_FLIGHT",
      mutationRequestId,
      now,
    });

    const outcomes = await Promise.allSettled([transition("prep-a"), transition("prep-b")]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(0);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(2);
    for (const rejected of outcomes) {
      expect(rejected).toMatchObject({ status: "rejected", reason: { code: "VALIDATION_FAILED" } });
    }
    await expect(repository.updateAccountingCaseOperation({
      binding: binding(),
      caseId: value.caseId,
      version: value.version,
      operationId,
      requestId: "execute-1",
      expectedStates: ["PREPARED"],
      state: "WRITE_IN_FLIGHT",
      now,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("keeps WRITE_UNCERTAIN on recovery-only flow until exact readback can complete the case", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    const originalBinding = binding();
    const renewedBinding = binding({
      targetSessionId: "target-session-renewed",
      targetSessionHash: "b".repeat(64),
    });
    await seedLiveTarget(repository, originalBinding);
    await repository.saveLedgerTargetSession({
      sessionId: renewedBinding.targetSessionId,
      sessionHash: renewedBinding.targetSessionHash,
      installationId: renewedBinding.installationId,
      bindingId: renewedBinding.bindingId,
      connectionId: renewedBinding.connectionId,
      bindingRevision: renewedBinding.bindingRevision,
      createdAt: now,
      expiresAt: renewedBinding.targetSessionExpiresAt,
    });
    await createCase(repository, binding(), value);
    await claimCase(repository, "execute-recovery");
    const operation = value.operations[0]!;
    const operationId = operation.operationId;
    const preparation = await casePreparation(repository, value, operationId);
    const mutationRequestId = "mutation-1";
    const objectId = "xero-object-1";
    const writeReceipt = { requestId: "provider-1" };
    await confirmMutation(repository, preparation, mutationRequestId);
    await repository.projectAccountingCaseOperationFromMutation({
      binding: binding(), caseId: value.caseId, version: 1, operationId,
      requestId: "execute-recovery", expectedStates: ["PREPARED"], desiredState: "WRITE_IN_FLIGHT",
      mutationRequestId, now,
    });
    await repository.markXeroMutationWriteUnknown({
      ...boundMutationInput(preparation, mutationRequestId),
      xeroObjectId: objectId,
      writeReceipt,
    });
    await repository.projectAccountingCaseOperationFromMutation({
      binding: binding(), caseId: value.caseId, version: 1, operationId,
      requestId: "execute-recovery", expectedStates: ["WRITE_IN_FLIGHT"], desiredState: "WRITE_UNCERTAIN",
      mutationRequestId, now,
    });
    await expect(repository.finalizeAccountingCase({
      binding: binding(), caseId: value.caseId, version: 1, requestId: "execute-recovery",
      state: "RECOVERY_REQUIRED", terminalSummary: { uncertainOperationIds: [operationId] }, now,
    })).resolves.toMatchObject({ state: "RECOVERY_REQUIRED" });
    await expect(repository.getBoundAccountingCase({
      binding: renewedBinding, caseId: value.caseId, version: 1,
    })).resolves.toBeUndefined();
    await expect(repository.getAccessibleAccountingCase({
      currentAccessBinding: renewedBinding, caseId: value.caseId, version: 1, mode: "STATUS", now,
    })).resolves.toMatchObject({ binding: originalBinding, state: "RECOVERY_REQUIRED" });
    for (const denied of [
      binding({ subjectId: "other-subject" }),
      binding({ connectionId: "other-connection" }),
      binding({ tenantId: "other-tenant" }),
    ]) {
      await expect(repository.getAccessibleAccountingCase({
        currentAccessBinding: denied, caseId: value.caseId, version: 1, mode: "STATUS", now,
      })).resolves.toBeUndefined();
    }
    await expect(repository.claimAccountingCaseExecution({
      binding: renewedBinding, caseId: value.caseId, version: 1, requestId: "execute-recovery",
      expectedPlanHash: planHash(value), accessMode: "RECOVERY_GET_ONLY", now,
    })).resolves.toMatchObject({ mode: "RECOVERY_GET_ONLY", record: { binding: originalBinding } });

    const bound = boundMutationInput(preparation, mutationRequestId);
    const readbackSnapshot = operation.nativeRoute === "CONTACT_CREATE"
      ? { id: objectId, status: XERO_MUTATION_EXPECTED_READBACK_STATUS[preparation.objectType] }
      : {
          xeroObjectId: objectId,
          status: XERO_MUTATION_EXPECTED_READBACK_STATUS[preparation.objectType],
          canonicalPayload: preparation.canonicalPayload,
          evidence: economicReadbackEvidence(operation, objectId),
        };
    await repository.markXeroMutationReadbackVerified({
      ...bound,
      xeroObjectId: objectId,
      writeReceipt,
      readbackSnapshot,
      readbackSnapshotHash: hashObject(readbackSnapshot),
      readbackCanonicalPayload: preparation.canonicalPayload,
      readbackPayloadHash: preparation.canonicalPayloadHash,
      readbackStatus: XERO_MUTATION_EXPECTED_READBACK_STATUS[preparation.objectType],
    });
    await repository.projectAccountingCaseOperationFromMutation({
      binding: renewedBinding, caseId: value.caseId, version: 1, operationId,
      requestId: "execute-recovery", expectedStates: ["WRITE_UNCERTAIN"], desiredState: "READBACK_VERIFIED",
      mutationRequestId, accessMode: "RECOVERY_GET_ONLY", now,
    });
    for (const operation of value.operations.slice(1)) {
      await repository.updateAccountingCaseOperation({
        binding: binding(), caseId: value.caseId, version: 1,
        operationId: operation.operationId,
        requestId: "execute-recovery", expectedStates: ["PREPARED"], state: "BLOCKED_VALIDATION",
        errorReceipt: { code: "TEST_TERMINAL_RESIDUAL" }, now,
      });
    }
    await expect(repository.finalizeAccountingCase({
      binding: binding(), caseId: value.caseId, version: 1, requestId: "execute-recovery",
      state: "PARTIALLY_COMMITTED", terminalSummary: { readbackVerifiedOperationIds: [operationId] }, now,
    })).resolves.toMatchObject({
      state: "PARTIALLY_COMMITTED",
      operations: expect.arrayContaining([
        expect.objectContaining({ state: "READBACK_VERIFIED", xeroObjectId: "xero-object-1" }),
      ]),
    });
    await expect(repository.claimAccountingCaseExecution({
      binding: binding(), caseId: value.caseId, version: 1, requestId: "execute-recovery",
      expectedPlanHash: planHash(value), now,
    })).resolves.toMatchObject({ mode: "ALREADY_TERMINAL" });
    await expect(repository.getAccessibleAccountingCase({
      currentAccessBinding: renewedBinding, caseId: value.caseId, version: 1, mode: "STATUS", now,
    })).resolves.toMatchObject({ binding: originalBinding, state: "PARTIALLY_COMMITTED" });
  });

  it("rejects a compiled plan hash that is not derived from the compiled case", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    await expect(repository.createOrAdvanceAccountingCase({
      binding: binding(),
      compiled: value,
      compiledPlanHash: "f".repeat(64),
      now,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("requires the execution request owner on operation updates", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    await createCase(repository, binding(), value);
    await claimCase(repository, "owner-request");
    const update = {
      binding: binding(),
      caseId: value.caseId,
      version: value.version,
      operationId: value.operations[0]!.operationId,
      expectedStates: ["PREPARED"],
      state: "WRITE_IN_FLIGHT",
      mutationRequestId: "foreign-mutation",
      requestId: "foreign-request",
      now,
    } satisfies UpdateAccountingCaseOperationInput;

    await expect(repository.updateAccountingCaseOperation(update))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects state jumps that satisfy expected-state CAS but violate the operation lifecycle", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    await createCase(repository, binding(), value);
    await claimCase(repository);

    await expect(repository.updateAccountingCaseOperation({
      binding: binding(),
      caseId: value.caseId,
      version: value.version,
      operationId: value.operations[0]!.operationId,
      expectedStates: ["PREPARED"],
      state: "PENDING",
      now,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not finalize TERMINAL while any operation remains pending or write-uncertain", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    await createCase(repository, binding(), value);
    await claimCase(repository, "premature-finalize");
    const operationId = value.operations[0]!.operationId;
    const preparation = await casePreparation(repository, value, operationId);
    const mutationRequestId = "premature-mutation";
    await confirmMutation(repository, preparation, mutationRequestId);
    await repository.projectAccountingCaseOperationFromMutation({
      binding: binding(), caseId: value.caseId, version: 1, operationId,
      requestId: "premature-finalize", expectedStates: ["PREPARED"], desiredState: "WRITE_IN_FLIGHT",
      mutationRequestId, now,
    });
    await repository.markXeroMutationWriteUnknown(boundMutationInput(preparation, mutationRequestId));
    await repository.projectAccountingCaseOperationFromMutation({
      binding: binding(), caseId: value.caseId, version: 1, operationId,
      requestId: "premature-finalize", expectedStates: ["WRITE_IN_FLIGHT"], desiredState: "WRITE_UNCERTAIN",
      mutationRequestId, now,
    });

    await expect(repository.finalizeAccountingCase({
      binding: binding(),
      caseId: value.caseId,
      version: value.version,
      requestId: "premature-finalize",
      state: "TERMINAL",
      terminalSummary: { claimedComplete: true, ignoredUncertainOperationId: operationId },
      now,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("seals mixed completed and definitely failed operations as PARTIALLY_COMMITTED and retains verified coordinates", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = compiled(1);
    await createCase(repository, binding(), value);
    await claimCase(repository, "partial-owner");
    const [completed, ...failed] = value.operations;
    if (!completed || failed.length === 0) throw new Error("fixture needs multiple operations");
    const preparation = await casePreparation(repository, value, completed.operationId);
    const mutationRequestId = "partial-mutation";
    await recordVerifiedMutation(repository, preparation, mutationRequestId, completed, "partial-object");
    await repository.projectAccountingCaseOperationFromMutation({
      binding: binding(), caseId: value.caseId, version: 1,
      operationId: completed.operationId, requestId: "partial-owner",
      expectedStates: ["PREPARED"], desiredState: "READBACK_VERIFIED",
      mutationRequestId, now,
    });
    for (const operation of failed) {
      await repository.updateAccountingCaseOperation({
        binding: binding(), caseId: value.caseId, version: 1,
        operationId: operation.operationId, requestId: "partial-owner",
        expectedStates: ["PREPARED"], state: "BLOCKED_VALIDATION",
        errorReceipt: { code: "DEFINITE_VALIDATION_FAILURE" }, now,
      });
    }
    const terminalSummary = { completed: 1, failed: failed.length };
    await expect(repository.finalizeAccountingCase({
      binding: binding(), caseId: value.caseId, version: 1, requestId: "partial-owner",
      state: "TERMINAL", terminalSummary, now,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.finalizeAccountingCase({
      binding: binding(), caseId: value.caseId, version: 1, requestId: "partial-owner",
      state: "PARTIALLY_COMMITTED", terminalSummary, now,
    })).resolves.toMatchObject({ state: "PARTIALLY_COMMITTED" });
    await expect(claimCase(repository, "partial-owner")).resolves.toMatchObject({ mode: "ALREADY_TERMINAL" });
    await expect(repository.claimAccountingCaseExecution({
      binding: binding(), caseId: value.caseId, version: 1, requestId: "partial-owner",
      expectedPlanHash: planHash(value), now: new Date("2026-08-13T05:00:00.000Z"),
    })).resolves.toMatchObject({ mode: "ALREADY_TERMINAL" });
    const second = compiled(2);
    await expect(createCase(repository, binding(), second)).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
        duplicateCaseId: value.caseId,
        duplicateCaseVersion: 1,
      },
    });
  });

  it("blocks readiness only while a legacy projection has active write recovery", async () => {
    const repository = new InMemoryAccountingRepository({ now: () => now });
    const value = structuredClone(compiledSingleDocument({
      caseId: "case-legacy-active-recovery-readiness",
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
    }));
    (value.policyProjection as Record<string, unknown>).schemaVersion =
      "xero-sg-accounting-policy-projection:v3";
    (value.providerProjection as Record<string, unknown>).schemaVersion =
      "xero-accounting-case-provider-projection:v4";
    const requestId = "legacy-active-recovery-owner";
    const mutationRequestId = "legacy-active-recovery-mutation";

    await createCase(repository, binding(), value);
    await expect(repository.readinessEvidence("test-migration")).resolves.toMatchObject({
      ready: true,
      activeAccountingCaseRecoveryProjection: { status: "COMPATIBLE", activeCaseCount: 0 },
    });

    await claimCase(repository, requestId, binding(), value);
    const operation = value.operations[0]!;
    const preparation = await casePreparation(repository, value, operation.operationId);
    await confirmMutation(repository, preparation, mutationRequestId);
    await repository.projectAccountingCaseOperationFromMutation({
      binding: binding(), caseId: value.caseId, version: value.version,
      operationId: operation.operationId, requestId,
      expectedStates: ["PREPARED"], desiredState: "WRITE_IN_FLIGHT",
      mutationRequestId, now,
    });
    await expect(repository.readinessEvidence("test-migration")).resolves.toMatchObject({
      ready: false,
      activeAccountingCaseRecoveryProjection: {
        status: "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION",
        activeCaseCount: 1,
        storedPolicyProjectionVersions: ["xero-sg-accounting-policy-projection:v3"],
        storedProviderProjectionVersions: ["xero-accounting-case-provider-projection:v4"],
      },
    });

    await recordCaseEconomicMutation(repository, value, operation, mutationRequestId);
    await repository.projectAccountingCaseOperationFromMutation({
      binding: binding(), caseId: value.caseId, version: value.version,
      operationId: operation.operationId, requestId,
      expectedStates: ["WRITE_IN_FLIGHT"], desiredState: "READBACK_VERIFIED",
      mutationRequestId, now,
    });
    await repository.finalizeAccountingCase({
      binding: binding(), caseId: value.caseId, version: value.version, requestId,
      state: "TERMINAL", terminalSummary: {}, now,
    });
    await expect(repository.readinessEvidence("test-migration")).resolves.toMatchObject({
      ready: true,
      activeAccountingCaseRecoveryProjection: { status: "COMPATIBLE", activeCaseCount: 0 },
    });
  });
});
