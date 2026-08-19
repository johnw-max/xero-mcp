import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  xeroContactDurableBusinessIdentityHash,
} from "../src/policy/xeroAccountingCaseProviderContract.js";
import {
  compileTestXeroAccountingCase as compileAccountingCase,
  TEST_XERO_TENANT_ID,
  testXeroBusinessAuthorityProfile,
} from "./helpers/xeroTenantCoaProfile.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import type { CompiledAccountingCase } from "../src/domain/accountingCase.js";
import {
  accountingCaseMutationRoute,
  accountingCasePlanHash,
  accountingCasePreflightReceiptHash,
  accountingCasePreflightResealReceiptHash,
  accountingCaseTerminalSummary,
  type AccountingCaseBinding,
  type AccountingCaseOperationPreflight,
  type AccountingCaseOperationReseal,
  type AccountingCasePreflightResealReceipt,
  type CreateOrAdvanceAccountingCaseResult,
  type ResealAndClaimAccountingCaseExecutionInput,
} from "../src/domain/accountingCasePersistence.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import {
  accountingCaseContinuationTemplateHash,
  accountingCaseDependentContinuationTemplate,
  accountingCaseRecoveryResidualContinuationTemplate,
} from "../src/domain/accountingCaseContinuation.js";
import {
  XERO_MUTATION_EXPECTED_READBACK_STATUS,
  type XeroMutationPreparation,
} from "../src/domain/xeroMutation.js";
import { hashObject } from "../src/security/hash.js";
import { createXeroExistingDocumentNoWriteEvidence } from "../src/policy/xeroAccountingCaseExistingDocumentEvidence.js";
import { XERO_RELEASE_ATTESTATION } from "../src/xeroRelease.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("../harness/fixtures/xero/golden-14-case.v1.json", import.meta.url)),
  "utf8",
)) as PrepareAccountingCaseInput;

describeWithPostgres("Accounting Case PostgreSQL evidence linkage", () => {
  const repository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;
  const suffix = randomUUID().replaceAll("-", "");
  const continuationContactId = randomUUID();
  // Repository expiry decisions use PostgreSQL statement_timestamp(); keep
  // this integration fixture live relative to the database under test.
  const createdAt = new Date(Date.now() - 10 * 60_000);
  const targetExpiresAt = new Date(createdAt.getTime() + 4 * 60 * 60_000);
  const ids = {
    workspace: `case-workspace-${suffix}`,
    subject: `case-user-${suffix}`,
    agent: `case-agent-${suffix}`,
    installation: `case-installation-${suffix}`,
    client: `case-client-${suffix}`,
    binding: `case-binding-${suffix}`,
    connection: `case-connection-${suffix}`,
    authorization: `case-authorization-${suffix}`,
    tenant: TEST_XERO_TENANT_ID,
    policy: `case-policy-${suffix}`,
    targetSession: `case-target-${suffix}`,
    targetHash: hashObject({ suffix, kind: "target" }),
    primaryCase: `case-pg-primary-${suffix}`,
  };
  const caseIds = new Set<string>();
  const preparationIds = new Set<string>();
  const mutationRequestIds = new Set<string>();
  const targetSessionHashes = new Set<string>([ids.targetHash]);
  const businessAuthority = testXeroBusinessAuthorityProfile(ids.tenant);
  let retainsAppendOnlyRecoveryGrant = false;

  const binding: AccountingCaseBinding = {
    actorId: `${ids.workspace}:user:${ids.subject}`,
    workspaceId: ids.workspace,
    subjectType: "USER",
    subjectId: ids.subject,
    agentId: ids.agent,
    installationId: ids.installation,
    bindingId: ids.binding,
    bindingRevision: 1,
    connectionId: ids.connection,
    tenantId: ids.tenant,
    targetSessionId: ids.targetSession,
    targetSessionHash: ids.targetHash,
    targetSessionExpiresAt: targetExpiresAt,
  };

  function durableId(prefix: "xmp" | "xmr"): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
  }

  function compile(caseId: string, version = 1): CompiledAccountingCase {
    const input = structuredClone(fixture);
    input.caseId = caseId;
    input.expectedVersion = version - 1;
    input.target.tenantId = ids.tenant;
    // Each test Case represents a distinct source set. Keep its formal
    // business references distinct so one test's durable reservation cannot
    // masquerade as another test's intended document. Credits retain the
    // exact rewritten original-document reference.
    const discriminator = hashObject({ caseId }).slice(0, 12).toUpperCase();
    const referenceMap = new Map<string, string>();
    for (const fact of input.facts) {
      if (fact.kind !== "NATIVE_DOCUMENT") continue;
      referenceMap.set(fact.reference, `${fact.reference}-${discriminator}`);
    }
    for (const fact of input.facts) {
      if (fact.kind !== "NATIVE_DOCUMENT") continue;
      fact.reference = referenceMap.get(fact.reference)!;
      if (fact.originalDocumentReference) {
        fact.originalDocumentReference = referenceMap.get(fact.originalDocumentReference) ??
          `${fact.originalDocumentReference}-${discriminator}`;
      }
    }
    return compileAccountingCase(input, businessAuthority);
  }

  function compileTwoInvoiceCase(caseId: string): CompiledAccountingCase {
    const input = structuredClone(fixture);
    const documents = input.facts
      .filter((fact) => fact.kind === "NATIVE_DOCUMENT" && fact.documentKind === "INVOICE")
      .slice(0, 2);
    const unitIds = new Set(documents.flatMap((fact) => fact.sourceUnitIds));
    input.caseId = caseId;
    input.expectedVersion = 0;
    input.target.tenantId = ids.tenant;
    const caseDiscriminator = hashObject({ caseId }).slice(0, 12).toUpperCase();
    input.sources = input.sources.flatMap((source) => {
      const units = source.units.filter((unit) => unitIds.has(unit.unitId));
      return units.length > 0 ? [{ ...source, units }] : [];
    });
    input.facts = documents.map((fact, index) => ({
      ...fact,
      reference: `${fact.reference}-RECOVERY-${index + 1}-${caseDiscriminator}`,
    }));
    return compileAccountingCase(input, businessAuthority);
  }

  function compileResidualSuccessor(
    source: CompiledAccountingCase,
    successorCaseId: string,
    residualOperationId: string,
  ): CompiledAccountingCase {
    const operation = source.operations.find((candidate) => candidate.operationId === residualOperationId);
    const event = source.events.find((candidate) => candidate.eventId === operation?.eventId);
    const fact = source.activeFacts.find((candidate) => candidate.factId === event?.primaryFactId);
    if (!operation || !event || !fact || fact.kind !== "NATIVE_DOCUMENT") {
      throw new Error("Recovery successor fixture has no exact residual document");
    }
    const unitIds = new Set(fact.sourceUnitIds);
    const sources = source.sources.flatMap((artifact) => {
      const units = artifact.units.filter((unit) => unitIds.has(unit.unitId));
      return units.length > 0 ? [{ ...artifact, units }] : [];
    });
    return compileAccountingCase({
      caseId: successorCaseId,
      expectedVersion: 0,
      target: { ...structuredClone(source.target), paysTax: true },
      sources,
      facts: [{
        ...structuredClone(fact),
        xeroContactId: String(operation.canonicalPayload.xeroContactId),
      }],
    }, businessAuthority);
  }

  function continuationCaseInput(caseId: string, expectedVersion: 0 | 1, resolvedContact = false) {
    const durableIdentity = {
      kind: "LEGAL_REGISTRY" as const,
      jurisdiction: "SG",
      registryScheme: "ACRA_UEN",
      number: `REG-${suffix}`,
    };
    return {
      caseId,
      expectedVersion,
      target: {
        tenantId: ids.tenant,
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        paysTax: true,
        organisationStatus: "ACTIVE",
      },
      sources: [
        ...(resolvedContact ? [] : [{
          artifactId: `contact-${suffix}`,
          label: "PostgreSQL continuation contact",
          units: [{ unitId: `contact-unit-${suffix}`, expectedFactKinds: ["CONTACT_CANDIDATE"] }],
        }]),
        {
          artifactId: `invoice-${suffix}`,
          label: "PostgreSQL continuation invoice",
          units: [{ unitId: `invoice-unit-${suffix}`, expectedFactKinds: ["NATIVE_DOCUMENT"] }],
        },
      ],
      facts: [
        ...(resolvedContact ? [] : [{
          factId: `contact-fact-${suffix}`,
          lineageKey: `contact-lineage-${suffix}`,
          eventKey: `contact-event-${suffix}`,
          sourceUnitIds: [`contact-unit-${suffix}`],
          origin: "MODEL_EXTRACTED",
          revision: 1,
          kind: "CONTACT_CANDIDATE",
          usageRoles: ["CUSTOMER"],
          name: "PostgreSQL Continuation Customer",
          durableIdentity,
          companyNumber: durableIdentity.number,
          bankVerification: "NOT_APPLICABLE",
        }]),
        {
          factId: `invoice-fact-${suffix}`,
          lineageKey: `invoice-lineage-${suffix}`,
          eventKey: `invoice-event-${suffix}`,
          sourceUnitIds: [`invoice-unit-${suffix}`],
          origin: "MODEL_EXTRACTED",
          revision: 1,
          kind: "NATIVE_DOCUMENT",
          documentKind: "INVOICE",
          counterpartyRole: "CUSTOMER",
          reference: `INV-CONT-${suffix}`,
          referenceKind: "FORMAL_DOCUMENT_NUMBER",
          documentDate: "2026-08-01",
          dueDate: "2026-08-31",
          currency: "SGD",
          contactName: "PostgreSQL Continuation Customer",
          contactDurableIdentity: durableIdentity,
          ...(resolvedContact ? { xeroContactId: continuationContactId } : {}),
          taxPolicyBasis: "DOCUMENT_DATE_NON_TRANSITION",
          lineAmountType: "EXCLUSIVE",
          lines: [{
            lineId: `line-${suffix}`,
            description: "PostgreSQL continuation service",
            quantity: "1",
            unitAmount: "100.00",
            sourceTax: "9.00",
            accountCode: "200",
            taxType: "OUTPUT",
          }],
          declaredNet: "100.00",
          declaredTax: "9.00",
          declaredGross: "109.00",
          documentValidity: "TEST_OR_NOT_VALID",
        },
      ],
    };
  }

  function compileNativeReservationCase(options: {
    caseId: string;
    reference: string;
    documentDate: string;
    dueDate: string;
  }): CompiledAccountingCase {
    const input = continuationCaseInput(options.caseId, 0, true);
    const document = input.facts[0];
    if (!document || document.kind !== "NATIVE_DOCUMENT") {
      throw new Error("native reservation fixture has no document");
    }
    return compileAccountingCase({
      ...input,
      facts: [{
        ...document,
        reference: options.reference,
        referenceKind: "GENERIC_RECURRING_REFERENCE",
        documentDate: options.documentDate,
        dueDate: options.dueDate,
      }],
    }, businessAuthority);
  }

  function exactExistingInvoiceEvidence(
    operation: CompiledAccountingCase["operations"][number],
    invoiceId: string,
  ): Record<string, unknown> {
    const payload = operation.canonicalPayload;
    const lines = Array.isArray(payload.lines)
      ? payload.lines as Array<Record<string, unknown>>
      : [];
    return createXeroExistingDocumentNoWriteEvidence(operation, {
      state: "EXACT_ONE",
      checkedObjectCount: 1,
      complete: true,
      providerObjectId: invoiceId,
      canonicalEconomicMatch: true,
      mismatchReasons: [],
      exactReadback: {
        invoiceId,
        tenantId: operation.target.tenantId,
        type: "ACCREC",
        status: "DRAFT",
        contact: { contactId: payload.xeroContactId },
        invoiceDate: payload.documentDate,
        dueDate: payload.dueDate,
        currency: payload.currency,
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
      },
    });
  }

  function contactOnlyInput(options: {
    caseId: string;
    jurisdiction: string;
    registryScheme: string;
    number: string;
  }) {
    const durableIdentity = {
      kind: "LEGAL_REGISTRY" as const,
      jurisdiction: options.jurisdiction,
      registryScheme: options.registryScheme,
      number: options.number,
    };
    return {
      caseId: options.caseId,
      expectedVersion: 0,
      target: {
        tenantId: ids.tenant,
        environment: "TEST" as const,
        baseCurrency: "SGD",
        taxJurisdiction: "SG",
        paysTax: true,
        organisationStatus: "ACTIVE",
      },
      sources: [{
        artifactId: `contact-source-${options.caseId}`,
        label: "PostgreSQL bare-number claim",
        units: [{ unitId: `contact-unit-${options.caseId}`, expectedFactKinds: ["CONTACT_CANDIDATE" as const] }],
      }],
      facts: [{
        factId: `contact-fact-${options.caseId}`,
        lineageKey: `contact-lineage-${options.caseId}`,
        eventKey: `contact-event-${options.caseId}`,
        sourceUnitIds: [`contact-unit-${options.caseId}`],
        origin: "MODEL_EXTRACTED" as const,
        revision: 1,
        kind: "CONTACT_CANDIDATE" as const,
        usageRoles: ["CUSTOMER"] as const,
        name: `Contact ${options.caseId}`,
        durableIdentity,
        companyNumber: durableIdentity.number,
        bankVerification: "NOT_APPLICABLE" as const,
      }],
    };
  }

  function twoContactInput(
    caseId: string,
    first: { jurisdiction: string; registryScheme: string; number: string },
    second: { jurisdiction: string; registryScheme: string; number: string },
  ): PrepareAccountingCaseInput {
    const firstInput = contactOnlyInput({ caseId: `${caseId}-first`, ...first });
    const secondInput = contactOnlyInput({ caseId: `${caseId}-second`, ...second });
    return {
      ...firstInput,
      caseId,
      sources: [...firstInput.sources, ...secondInput.sources],
      facts: [...firstInput.facts, ...secondInput.facts],
    };
  }

  async function createCase(caseId: string): Promise<CompiledAccountingCase> {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiled = compile(caseId);
    caseIds.add(caseId);
    await repository.createOrAdvanceAccountingCase({
      binding,
      compiled,
      compiledPlanHash: accountingCasePlanHash(binding, compiled),
      now: createdAt,
    });
    return compiled;
  }

  async function prepareOperation(
    compiled: CompiledAccountingCase,
    operation: CompiledAccountingCase["operations"][number],
    options: {
      expiresAt?: Date;
      route?: ReturnType<typeof accountingCaseMutationRoute>;
      sourceRef?: string;
      sourceUnitKey?: string;
      binding?: AccountingCaseBinding;
    } = {},
  ): Promise<XeroMutationPreparation> {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const caseBinding = options.binding ?? binding;
    const preparationId = durableId("xmp");
    preparationIds.add(preparationId);
    const canonicalPayload = {
      caseOperationId: operation.operationId,
      actionId: operation.actionId,
      nonce: preparationId,
    };
    const route = options.route ?? accountingCaseMutationRoute(operation);
    return repository.createXeroMutationPreparation({
      preparationId,
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
      sourceRef: options.sourceRef ?? `case:${compiled.caseId}`,
      sourceUnitKey: options.sourceUnitKey ?? operation.operationId,
      sourceSha256: hashObject({ caseId: compiled.caseId, operationId: operation.operationId, preparationId }),
      sourceEvidenceType: "SERVER_FINGERPRINTED_EXTRACTION",
      confirmationSummaryHash: hashObject({ preparationId, kind: "summary" }),
      confirmationPhraseHash: hashObject({ preparationId, kind: "phrase" }),
      expiresAt: options.expiresAt ?? new Date(createdAt.getTime() + 20 * 60_000),
      now: createdAt,
    });
  }

  async function prepareWholeCase(
    compiled: CompiledAccountingCase,
    options: { expiresAt?: Date; binding?: AccountingCaseBinding } = {},
  ): Promise<{ preparations: XeroMutationPreparation[]; operations: AccountingCaseOperationPreflight[] }> {
    const preparations: XeroMutationPreparation[] = [];
    for (const operation of compiled.operations) {
      preparations.push(await prepareOperation(compiled, operation, options));
    }
    return {
      preparations,
      operations: compiled.operations.map((operation, index) => ({
        operationId: operation.operationId,
        state: "PREPARED" as const,
        preparationId: preparations[index]!.preparationId,
        operationCanonicalPayloadHash: operation.canonicalPayloadHash,
        preparationCanonicalPayloadHash: preparations[index]!.canonicalPayloadHash,
        sourceSha256: preparations[index]!.sourceSha256,
      })),
    };
  }

  function preflightReceipt(
    compiled: CompiledAccountingCase,
    operations: AccountingCaseOperationPreflight[],
  ): Record<string, unknown> {
    return {
      receiptType: "TEST_ACCOUNTING_CASE_PREFLIGHT",
      operations: operations.map((operation) => {
        const durable = compiled.operations.find((candidate) => candidate.operationId === operation.operationId);
        if (!durable) throw new Error(`Unknown operation ${operation.operationId}`);
        if (operation.state === "NO_WRITE_REQUIRED") {
          return {
            operationId: operation.operationId,
            actionId: durable.actionId,
            operationCanonicalPayloadHash: durable.canonicalPayloadHash,
            state: operation.state,
            xeroObjectId: operation.xeroObjectId,
            readbackHash: hashObject(operation.readbackSnapshot),
          };
        }
        return {
          operationId: operation.operationId,
          actionId: durable.actionId,
          operationCanonicalPayloadHash: operation.operationCanonicalPayloadHash,
          state: operation.state,
          preparationId: operation.preparationId,
          preparationCanonicalPayloadHash: operation.preparationCanonicalPayloadHash,
          sourceSha256: operation.sourceSha256,
        };
      }),
    };
  }

  async function recordPreflight(
    compiled: CompiledAccountingCase,
    operations: AccountingCaseOperationPreflight[],
    requestId: string,
    now = createdAt,
    caseBinding = binding,
  ) {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiledPlanHash = accountingCasePlanHash(caseBinding, compiled);
    const receipt = preflightReceipt(compiled, operations);
    return repository.recordAccountingCasePreflight({
      binding: caseBinding,
      caseId: compiled.caseId,
      version: compiled.version,
      requestId,
      expectedPlanHash: compiledPlanHash,
      preflightReceipt: receipt,
      preflightReceiptHash: accountingCasePreflightReceiptHash({
        binding: caseBinding,
        caseId: compiled.caseId,
        version: compiled.version,
        compiledPlanHash,
        requestId,
        preflightReceipt: receipt,
      }),
      operations,
      now,
    });
  }

  function mutationConfirmationInput(preparation: XeroMutationPreparation, mutationRequestId: string) {
    return {
      mutationRequestId,
      preparationId: preparation.preparationId,
      requestId: `case-test:${mutationRequestId}`,
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
      now: createdAt,
    };
  }

  async function confirmMutation(preparation: XeroMutationPreparation) {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const mutationRequestId = durableId("xmr");
    mutationRequestIds.add(mutationRequestId);
    const result = await repository.confirmXeroMutationPreparation(
      mutationConfirmationInput(preparation, mutationRequestId),
    );
    if (!result) throw new Error("Mutation preparation was not confirmed");
    return { mutationRequestId, request: result.request };
  }

  async function saveTargetBinding(
    label: string,
    expiresAt: Date,
    targetCreatedAt = new Date(Date.now() - 1_000),
  ): Promise<AccountingCaseBinding> {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const targetSessionId = `case-target-${label}-${suffix}`;
    const targetSessionHash = hashObject({ suffix, label, kind: "recovery-target" });
    const caseBinding: AccountingCaseBinding = {
      ...binding,
      targetSessionId,
      targetSessionHash,
      targetSessionExpiresAt: expiresAt,
    };
    await repository.saveLedgerTargetSession({
      sessionId: targetSessionId,
      sessionHash: targetSessionHash,
      installationId: caseBinding.installationId,
      bindingId: caseBinding.bindingId,
      connectionId: caseBinding.connectionId,
      bindingRevision: caseBinding.bindingRevision,
      createdAt: targetCreatedAt,
      expiresAt,
    });
    targetSessionHashes.add(targetSessionHash);
    return caseBinding;
  }

  async function waitUntilAfter(instant: Date, marginMs = 80): Promise<void> {
    const delay = instant.getTime() - Date.now() + marginMs;
    if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }

  async function createContactCase(
    caseId: string,
    number: string,
    caseBinding: AccountingCaseBinding,
    jurisdiction = "SG",
    registryScheme = "ACRA",
    callerNow = createdAt,
  ): Promise<CompiledAccountingCase> {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiled = compileAccountingCase(contactOnlyInput({
      caseId,
      jurisdiction,
      registryScheme,
      number,
    }));
    caseIds.add(caseId);
    await repository.createOrAdvanceAccountingCase({
      binding: caseBinding,
      compiled,
      compiledPlanHash: accountingCasePlanHash(caseBinding, compiled),
      now: callerNow,
    });
    return compiled;
  }

  async function preflightContactCase(
    compiled: CompiledAccountingCase,
    caseBinding: AccountingCaseBinding,
    expiresAt: Date,
  ) {
    const prepared = await prepareWholeCase(compiled, { expiresAt, binding: caseBinding });
    const requestId = `contact-recovery-${compiled.caseId}-${suffix}`;
    await recordPreflight(compiled, prepared.operations, requestId, createdAt, caseBinding);
    return { ...prepared, requestId };
  }

  async function expirePreparation(
    preparation: XeroMutationPreparation,
    _callerNow: Date,
  ): Promise<XeroMutationPreparation> {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    // Expiry eligibility is database-owned now; a caller-supplied future Date
    // must not move the clock. This fixture directly materialises the already-
    // expired durable state so the reseal tests remain time-independent.
    const result = await repository.pool.query(
      `UPDATE xero_mutation_preparations
       SET state = 'EXPIRED', updated_at = GREATEST(updated_at, statement_timestamp())
       WHERE preparation_id = $1 AND state = 'PREPARED'
       RETURNING preparation_id`,
      [preparation.preparationId],
    );
    expect(result.rowCount).toBe(1);
    const expired = await repository.getXeroMutationPreparation(preparation.preparationId);
    if (!expired) throw new Error("Expired mutation preparation disappeared");
    expect(expired.state).toBe("EXPIRED");
    return expired;
  }

  async function resealInput(
    compiled: CompiledAccountingCase,
    requestId: string,
    resealedAt: Date,
    options: {
      replacementSourceSha256?: string;
      replacementBindingId?: string;
      swapReplacementIds?: boolean;
    } = {},
  ): Promise<ResealAndClaimAccountingCaseExecutionInput> {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const record = await repository.getBoundAccountingCase({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
    });
    if (!record?.preflightReceiptHash || !record.effectivePreflightSealHash ||
        record.preflightResealRevision === undefined) {
      throw new Error("Accounting Case is not preflighted");
    }

    const operations: AccountingCaseOperationReseal[] = [];
    for (const durableOperation of record.operations.filter((candidate) => candidate.state === "PREPARED")) {
      if (!durableOperation.preparationId) throw new Error("Prepared operation has no preparation");
      const oldPreparation = await repository.getXeroMutationPreparation(durableOperation.preparationId);
      if (!oldPreparation) throw new Error("Old mutation preparation disappeared");
      const newPreparationId = durableId("xmp");
      preparationIds.add(newPreparationId);
      const replacement = await repository.createXeroMutationPreparation({
        preparationId: newPreparationId,
        actorId: oldPreparation.actorId,
        workspaceId: oldPreparation.workspaceId,
        tenantId: oldPreparation.tenantId,
        installationId: oldPreparation.installationId,
        bindingId: options.replacementBindingId ?? oldPreparation.bindingId,
        bindingRevision: oldPreparation.bindingRevision,
        connectionId: oldPreparation.connectionId,
        targetSessionId: oldPreparation.targetSessionId,
        objectType: oldPreparation.objectType,
        operation: oldPreparation.operation,
        ...(oldPreparation.targetXeroObjectId
          ? { targetXeroObjectId: oldPreparation.targetXeroObjectId }
          : {}),
        canonicalPayload: structuredClone(oldPreparation.canonicalPayload),
        canonicalPayloadHash: oldPreparation.canonicalPayloadHash,
        ...(oldPreparation.sourceRef ? { sourceRef: oldPreparation.sourceRef } : {}),
        sourceUnitKey: oldPreparation.sourceUnitKey,
        sourceSha256: options.replacementSourceSha256 ?? oldPreparation.sourceSha256,
        sourceEvidenceType: oldPreparation.sourceEvidenceType,
        confirmationSummaryHash: oldPreparation.confirmationSummaryHash,
        confirmationPhraseHash: hashObject({ newPreparationId, kind: "phrase" }),
        expiresAt: new Date(resealedAt.getTime() + 5 * 60_000),
        now: resealedAt,
      });
      operations.push({
        operationId: durableOperation.operation.operationId,
        oldPreparationId: oldPreparation.preparationId,
        newPreparationId: replacement.preparationId,
        operationCanonicalPayloadHash: durableOperation.operation.canonicalPayloadHash,
        preparationCanonicalPayloadHash: durableOperation.preparationCanonicalPayloadHash!,
        sourceSha256: durableOperation.sourceSha256!,
        newPreparationExpiresAt: replacement.expiresAt.toISOString(),
      });
    }
    if (options.swapReplacementIds) {
      if (operations.length < 2) throw new Error("Fixture must compile at least two operations");
      const first = operations[0]!;
      const second = operations[1]!;
      [first.newPreparationId, second.newPreparationId] = [second.newPreparationId, first.newPreparationId];
      [first.newPreparationExpiresAt, second.newPreparationExpiresAt] = [
        second.newPreparationExpiresAt,
        first.newPreparationExpiresAt,
      ];
    }

    const minimumPreparationExpiresAt = new Date(resealedAt.getTime() + 30_000);
    const revision = record.preflightResealRevision + 1;
    const resealReceipt: AccountingCasePreflightResealReceipt = {
      receiptType: "XERO_ACCOUNTING_CASE_PREFLIGHT_RESEAL",
      receiptVersion: 1,
      caseId: compiled.caseId,
      caseVersion: compiled.version,
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
    return {
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      requestId,
      expectedPlanHash: record.compiledPlanHash,
      expectedOriginalPreflightReceiptHash: record.preflightReceiptHash,
      expectedEffectiveSealHash: record.effectivePreflightSealHash,
      expectedResealRevision: record.preflightResealRevision,
      resealReceipt,
      resealReceiptHash: accountingCasePreflightResealReceiptHash({
        binding,
        caseId: compiled.caseId,
        version: compiled.version,
        compiledPlanHash: record.compiledPlanHash,
        originalPreflightReceiptHash: record.preflightReceiptHash,
        previousEffectiveSealHash: record.effectivePreflightSealHash,
        revision,
        requestId,
        resealReceipt,
      }),
      operations,
      minimumPreparationExpiresAt,
      now: resealedAt,
    };
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
      now: createdAt,
    };
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

  async function markCaseEconomicMutation(
    preparation: XeroMutationPreparation,
    operation: CompiledAccountingCase["operations"][number],
    tamperTax = false,
  ): Promise<string> {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const { mutationRequestId } = await confirmMutation(preparation);
    const bound = boundMutationInput(preparation, mutationRequestId);
    const xeroObjectId = `xero-object-${mutationRequestId}`;
    const writeReceipt = { providerRequestId: `provider-${mutationRequestId}` };
    await repository.recordXeroMutationWriteEvidence({
      ...bound,
      xeroObjectId,
      writeReceipt,
    });
    const readbackSnapshot = {
      xeroObjectId,
      status: "DRAFT",
      canonicalPayload: preparation.canonicalPayload,
      evidence: economicReadbackEvidence(operation, xeroObjectId, tamperTax),
    };
    await repository.markXeroMutationReadbackVerified({
      ...bound,
      xeroObjectId,
      writeReceipt,
      readbackSnapshot,
      readbackSnapshotHash: hashObject(readbackSnapshot),
      readbackCanonicalPayload: preparation.canonicalPayload,
      readbackPayloadHash: preparation.canonicalPayloadHash,
      readbackStatus: "DRAFT",
    });
    return mutationRequestId;
  }

  beforeAll(async () => {
    if (!databaseUrl || !repository) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
    await expect(repository.readiness()).resolves.toBe(true);
    await repository.saveProviderAuthorization({
      authorizationId: ids.authorization,
      workspaceId: ids.workspace,
      authorizedBySubject: ids.subject,
      provider: "xero",
      grantedScopes: ["accounting.transactions"],
      tokenCiphertext: `encrypted-${suffix}`,
      tokenExpiresAt: new Date("2030-08-13T02:00:00.000Z"),
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    });
    await repository.upsertAuthorizedProviderConnection(ids.workspace, {
      connectionId: ids.connection,
      authorizationId: ids.authorization,
      provider: "xero",
      providerConnectionId: `provider-${suffix}`,
      tenantId: ids.tenant,
      tenantName: "Accounting Case PostgreSQL Test",
      status: "ACTIVE",
      lastVerifiedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
    await repository.saveOAuthInstallation({
      installationId: ids.installation,
      workspaceId: ids.workspace,
      subjectType: "USER",
      subjectId: ids.subject,
      agentId: ids.agent,
      clientId: ids.client,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    });
    await repository.saveAgentConnectionBinding({
      bindingId: ids.binding,
      installationId: ids.installation,
      workspaceId: ids.workspace,
      subjectType: "USER",
      subjectId: ids.subject,
      agentId: ids.agent,
      connectionId: ids.connection,
      policyId: ids.policy,
      status: "ACTIVE",
      createdAt,
      updatedAt: createdAt,
    });
    await repository.saveLedgerTargetSession({
      sessionId: ids.targetSession,
      sessionHash: ids.targetHash,
      installationId: ids.installation,
      bindingId: ids.binding,
      connectionId: ids.connection,
      bindingRevision: binding.bindingRevision,
      createdAt,
      expiresAt: targetExpiresAt,
    });
  });

  afterAll(async () => {
    if (!repository) return;
    if (retainsAppendOnlyRecoveryGrant) {
      await repository.close();
      return;
    }
    const cases = [...caseIds];
    const mutations = [...mutationRequestIds];
    const preparations = [...preparationIds];
    if (cases.length > 0) {
      const client = await repository.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE accounting_case_preflight_reseal_operations DISABLE TRIGGER USER");
        await client.query("ALTER TABLE accounting_case_preflight_reseals DISABLE TRIGGER USER");
        await client.query(
          "DELETE FROM accounting_case_preflight_reseal_operations WHERE case_id = ANY($1::text[])",
          [cases],
        );
        await client.query(
          "DELETE FROM accounting_case_preflight_reseals WHERE case_id = ANY($1::text[])",
          [cases],
        );
        await client.query("ALTER TABLE accounting_case_preflight_reseals ENABLE TRIGGER USER");
        await client.query("ALTER TABLE accounting_case_preflight_reseal_operations ENABLE TRIGGER USER");
        await client.query("DELETE FROM accounting_case_operations WHERE case_id = ANY($1::text[])", [cases]);
        await client.query("DELETE FROM accounting_case_versions WHERE case_id = ANY($1::text[])", [cases]);
        await client.query("DELETE FROM accounting_cases WHERE case_id = ANY($1::text[])", [cases]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    if (mutations.length > 0) {
      await repository.pool.query("DELETE FROM xero_mutation_requests WHERE mutation_request_id = ANY($1::text[])", [mutations]);
    }
    if (preparations.length > 0) {
      await repository.pool.query("DELETE FROM xero_mutation_preparations WHERE preparation_id = ANY($1::text[])", [preparations]);
    }
    await repository.pool.query(
      "DELETE FROM ledger_target_sessions WHERE session_hash = ANY($1::text[])",
      [[...targetSessionHashes]],
    );
    await repository.pool.query(
      "DELETE FROM oauth_installation_active_bindings WHERE oauth_installation_id = $1",
      [ids.installation],
    );
    await repository.pool.query("DELETE FROM agent_connection_bindings WHERE binding_id = $1", [ids.binding]);
    await repository.pool.query("DELETE FROM oauth_installations WHERE installation_id = $1", [ids.installation]);
    await repository.pool.query("DELETE FROM provider_connections WHERE connection_id = $1", [ids.connection]);
    await repository.pool.query("DELETE FROM provider_authorizations WHERE authorization_id = $1", [ids.authorization]);
    await repository.close();
  });

  it("durably awaits and advances a contact-dependent continuation without replaying the contact", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const caseId = `case-pg-continuation-${suffix}`;
    const compiledV1 = compileAccountingCase(continuationCaseInput(caseId, 0));
    caseIds.add(caseId);
    await repository.createOrAdvanceAccountingCase({
      binding,
      compiled: compiledV1,
      compiledPlanHash: accountingCasePlanHash(binding, compiledV1),
      now: createdAt,
    });
    expect(compiledV1.operations).toHaveLength(1);
    expect(compiledV1.operations[0]?.actionId).toBe("contact.create_basic");
    const prepared = await prepareWholeCase(compiledV1);
    const requestId = `continuation-v1-${suffix}`;
    await recordPreflight(compiledV1, prepared.operations, requestId);
    await repository.claimAccountingCaseExecution({
      binding,
      caseId,
      version: 1,
      requestId,
      expectedPlanHash: accountingCasePlanHash(binding, compiledV1),
      now: createdAt,
    });
    const preparation = prepared.preparations[0]!;
    const { mutationRequestId } = await confirmMutation(preparation);
    const bound = boundMutationInput(preparation, mutationRequestId);
    const xeroObjectId = continuationContactId;
    const writeReceipt = { providerRequestId: `provider-${mutationRequestId}` };
    await repository.recordXeroMutationWriteEvidence({ ...bound, xeroObjectId, writeReceipt });
    const readbackSnapshot = {
      xeroObjectId,
      status: "ACTIVE",
      canonicalPayload: preparation.canonicalPayload,
    };
    await repository.markXeroMutationReadbackVerified({
      ...bound,
      xeroObjectId,
      writeReceipt,
      readbackSnapshot,
      readbackSnapshotHash: hashObject(readbackSnapshot),
      readbackCanonicalPayload: preparation.canonicalPayload,
      readbackPayloadHash: preparation.canonicalPayloadHash,
      readbackStatus: "ACTIVE",
    });
    await repository.projectAccountingCaseOperationFromMutation({
      binding,
      caseId,
      version: 1,
      operationId: compiledV1.operations[0]!.operationId,
      requestId,
      expectedStates: ["PREPARED"],
      desiredState: "READBACK_VERIFIED",
      mutationRequestId,
      now: createdAt,
    });
    const registeredTupleHash = compiledV1.operations[0]!.businessIdentityHash;
    await expect(repository.findVerifiedAccountingCaseContactIdentity({
      tenantId: ids.tenant,
      businessIdentityHash: registeredTupleHash,
    })).resolves.toEqual({ contactId: xeroObjectId });
    await expect(repository.listVerifiedAccountingCaseContactIdentityHashes({
      tenantId: ids.tenant,
      contactId: xeroObjectId,
    })).resolves.toEqual([registeredTupleHash]);
    await expect(repository.findVerifiedAccountingCaseContactIdentity({
      tenantId: ids.tenant,
      businessIdentityHash: xeroContactDurableBusinessIdentityHash({
        kind: "LEGAL_REGISTRY",
        jurisdiction: "US",
        registryScheme: "IRS_EIN",
        number: `REG-${suffix}`,
      }),
    })).resolves.toBeUndefined();
    const awaiting = await repository.awaitAccountingCaseContinuation({
      binding,
      caseId,
      version: 1,
      requestId,
      now: createdAt,
    });
    expect(awaiting).toMatchObject({
      state: "AWAITING_CONTINUATION",
      operations: [expect.objectContaining({ state: "READBACK_VERIFIED" })],
    });
    expect(awaiting).not.toHaveProperty("terminalSummary");

    const compiledV2 = compileAccountingCase(continuationCaseInput(caseId, 1, true));
    expect(compiledV2.operations.map((operation) => operation.actionId)).toEqual([
      "customer_invoice.create_draft",
    ]);
    const templateHash = accountingCaseContinuationTemplateHash(
      accountingCaseDependentContinuationTemplate(compiledV1),
    );
    const repeatedContinuation = await Promise.all([1_000, 2_000].map((offset) =>
      repository.createOrAdvanceAccountingCase({
        binding,
        compiled: compiledV2,
        compiledPlanHash: accountingCasePlanHash(binding, compiledV2),
        continuationAuthorization: { sourceVersion: 1, templateHash },
        now: new Date(createdAt.getTime() + offset),
      })));
    expect(repeatedContinuation.map(({ mode }) => mode).sort()).toEqual([
      "ADVANCED",
      "IDEMPOTENT_REPLAY",
    ]);
    expect(repeatedContinuation).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: "ADVANCED",
        record: expect.objectContaining({
          compiled: expect.objectContaining({ version: 2 }),
          operations: [expect.objectContaining({
            operation: expect.objectContaining({ actionId: "customer_invoice.create_draft" }),
            state: "PENDING",
          })],
        }),
      }),
      expect.objectContaining({
        mode: "IDEMPOTENT_REPLAY",
        record: expect.objectContaining({ compiled: expect.objectContaining({ version: 2 }) }),
      }),
    ]));
    await expect(repository.createOrAdvanceAccountingCase({
      binding,
      compiled: compiledV2,
      compiledPlanHash: accountingCasePlanHash(binding, compiledV2),
      now: new Date(createdAt.getTime() + 3_000),
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("claims a provider bare number atomically at Case creation across two PostgreSQL connections", async () => {
    if (!repository || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const firstCaseId = `case-pg-contact-race-sg-${suffix}`;
    const secondCaseId = `case-pg-contact-race-us-${suffix}`;
    const otherNumberCaseId = `case-pg-contact-race-other-${suffix}`;
    const exactReplayCaseId = `case-pg-contact-race-exact-${suffix}`;
    caseIds.add(firstCaseId);
    caseIds.add(secondCaseId);
    caseIds.add(otherNumberCaseId);
    caseIds.add(exactReplayCaseId);
    const firstCompiled = compileAccountingCase(contactOnlyInput({
      caseId: firstCaseId,
      jurisdiction: "SG",
      registryScheme: "ACRA",
      number: `RACE-${suffix}`,
    }));
    const secondCompiled = compileAccountingCase(contactOnlyInput({
      caseId: secondCaseId,
      jurisdiction: "US",
      registryScheme: "IRS",
      number: `RACE-${suffix}`,
    }));
    expect(firstCompiled.operations[0]?.businessIdentityHash)
      .not.toBe(secondCompiled.operations[0]?.businessIdentityHash);
    expect(firstCompiled.operations[0]?.businessReservation)
      .toEqual(secondCompiled.operations[0]?.businessReservation);

    const secondRepository = new PostgresAccountingRepository(databaseUrl);
    try {
      const outcomes = await Promise.allSettled([
        repository.createOrAdvanceAccountingCase({
          binding,
          compiled: firstCompiled,
          compiledPlanHash: accountingCasePlanHash(binding, firstCompiled),
          now: createdAt,
        }),
        secondRepository.createOrAdvanceAccountingCase({
          binding,
          compiled: secondCompiled,
          compiledPlanHash: accountingCasePlanHash(binding, secondCompiled),
          now: createdAt,
        }),
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

      const owner = outcomes[0]?.status === "fulfilled" ? firstCompiled : secondCompiled;
      const replayRepository = outcomes[0]?.status === "fulfilled" ? repository : secondRepository;
      await expect(replayRepository.createOrAdvanceAccountingCase({
        binding,
        compiled: owner,
        compiledPlanHash: accountingCasePlanHash(binding, owner),
        now: createdAt,
      })).resolves.toMatchObject({ mode: "IDEMPOTENT_REPLAY" });

      const otherNumber = compileAccountingCase(contactOnlyInput({
        caseId: otherNumberCaseId,
        jurisdiction: "US",
        registryScheme: "IRS",
        number: `OTHER-${suffix}`,
      }));
      await expect(repository.createOrAdvanceAccountingCase({
        binding,
        compiled: otherNumber,
        compiledPlanHash: accountingCasePlanHash(binding, otherNumber),
        now: createdAt,
      })).resolves.toMatchObject({ mode: "CREATED" });

      const exactReplay = compileAccountingCase(contactOnlyInput({
        caseId: exactReplayCaseId,
        jurisdiction: "SG",
        registryScheme: "ACRA",
        number: `EXACT-${suffix}`,
      }));
      const exactOutcomes = await Promise.all([
        repository.createOrAdvanceAccountingCase({
          binding,
          compiled: exactReplay,
          compiledPlanHash: accountingCasePlanHash(binding, exactReplay),
          now: createdAt,
        }),
        secondRepository.createOrAdvanceAccountingCase({
          binding,
          compiled: exactReplay,
          compiledPlanHash: accountingCasePlanHash(binding, exactReplay),
          now: createdAt,
        }),
      ]);
      expect(exactOutcomes.map((outcome) => outcome.mode).sort())
        .toEqual(["CREATED", "IDEMPOTENT_REPLAY"]);
    } finally {
      await secondRepository.close();
    }
  });

  it("claims an untrusted ALL_OCCURRENCES native reference atomically at Case creation across two PostgreSQL connections", async () => {
    if (!repository || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const first = compileNativeReservationCase({
      caseId: `case-pg-native-pending-july-${suffix}`,
      reference: `MONTHLY-UNTRUSTED-${suffix}`,
      documentDate: "2026-07-20",
      dueDate: "2026-08-20",
    });
    const second = compileNativeReservationCase({
      caseId: `case-pg-native-pending-august-${suffix}`,
      reference: `MONTHLY-UNTRUSTED-${suffix}`,
      documentDate: "2026-08-20",
      dueDate: "2026-09-20",
    });
    caseIds.add(first.caseId);
    caseIds.add(second.caseId);
    expect(first.operations).toHaveLength(1);
    expect(second.operations).toHaveLength(1);
    expect(first.operations[0]?.businessReservation).toMatchObject({ scope: "ALL_OCCURRENCES" });
    expect(second.operations[0]?.businessReservation).toEqual(first.operations[0]?.businessReservation);

    const secondRepository = new PostgresAccountingRepository(databaseUrl);
    try {
      const outcomes = await Promise.allSettled([first, second].map((compiled, index) =>
        (index === 0 ? repository : secondRepository).createOrAdvanceAccountingCase({
          binding,
          compiled,
          compiledPlanHash: accountingCasePlanHash(binding, compiled),
          now: createdAt,
        })));
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")?.reason)
        .toMatchObject({
          code: "CONFLICT",
          details: {
            reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
            providerMutationPossible: false,
          },
        });
      const durable = await Promise.all([first, second].map((compiled) => repository.getBoundAccountingCase({
        binding,
        caseId: compiled.caseId,
        version: 1,
      })));
      expect(durable.filter(Boolean)).toHaveLength(1);
    } finally {
      await secondRepository.close();
    }
  });

  it("persists only action-bound exact existing-document no-write evidence", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiled = compileNativeReservationCase({
      caseId: `case-pg-native-no-write-${suffix}`,
      reference: `EXISTING-NATIVE-${suffix}`,
      documentDate: "2026-07-20",
      dueDate: "2026-08-20",
    });
    caseIds.add(compiled.caseId);
    await repository.createOrAdvanceAccountingCase({
      binding,
      compiled,
      compiledPlanHash: accountingCasePlanHash(binding, compiled),
      now: createdAt,
    });
    const operation = compiled.operations[0]!;
    const invoiceId = randomUUID();
    const evidence = exactExistingInvoiceEvidence(operation, invoiceId);
    const tampered = structuredClone(evidence);
    (tampered.exactReadback as Record<string, unknown>).total = "999.0000";
    await expect(recordPreflight(compiled, [{
      operationId: operation.operationId,
      state: "NO_WRITE_REQUIRED",
      xeroObjectId: invoiceId,
      readbackSnapshot: tampered,
    }], `native-no-write-invalid-${suffix}`)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(recordPreflight(compiled, [{
      operationId: operation.operationId,
      state: "NO_WRITE_REQUIRED",
      xeroObjectId: invoiceId,
      readbackSnapshot: evidence,
    }], `native-no-write-exact-${suffix}`)).resolves.toMatchObject({
      mode: "PREFLIGHTED",
      record: {
        operations: [expect.objectContaining({
          state: "NO_WRITE_REQUIRED",
          xeroObjectId: invoiceId,
        })],
      },
    });
  });

  it("orders same-Case advance behind preflight head locks without a native-coordinate deadlock", async () => {
    if (!repository || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const caseId = `case-pg-native-advance-preflight-${suffix}`;
    const first = compile(caseId, 1);
    const second = compile(caseId, 2);
    caseIds.add(caseId);
    await repository.createOrAdvanceAccountingCase({
      binding,
      compiled: first,
      compiledPlanHash: accountingCasePlanHash(binding, first),
      now: createdAt,
    });
    const prepared = await prepareWholeCase(first);
    const preflightRequestId = `native-order-preflight-${suffix}`;
    const receipt = preflightReceipt(first, prepared.operations);
    const preflightInput = {
      binding,
      caseId,
      version: 1,
      requestId: preflightRequestId,
      expectedPlanHash: accountingCasePlanHash(binding, first),
      preflightReceipt: receipt,
      preflightReceiptHash: accountingCasePreflightReceiptHash({
        binding,
        caseId,
        version: 1,
        compiledPlanHash: accountingCasePlanHash(binding, first),
        requestId: preflightRequestId,
        preflightReceipt: receipt,
      }),
      operations: prepared.operations,
      now: createdAt,
    };

    const applicationA = `native-order-preflight-${suffix.slice(0, 16)}`;
    const applicationB = `native-order-advance-${suffix.slice(0, 16)}`;
    const connectionUrl = (applicationName: string) => {
      const url = new URL(databaseUrl);
      url.searchParams.set("application_name", applicationName);
      return url.toString();
    };
    const repositoryA = new PostgresAccountingRepository(connectionUrl(applicationA));
    const repositoryB = new PostgresAccountingRepository(connectionUrl(applicationB));
    const barrierFunction = `aaa_native_order_barrier_fn_${suffix.slice(0, 16)}`;
    const barrierTrigger = `aaa_native_order_barrier_${suffix.slice(0, 16)}`;
    const barrierOperationId = first.operations[0]!.operationId;
    if (!/^[a-z0-9_:-]+$/u.test(barrierOperationId)) throw new Error("unsafe barrier operation ID");
    await repository.pool.query(`
      CREATE FUNCTION ${barrierFunction}() RETURNS trigger
      LANGUAGE plpgsql AS $barrier$
      BEGIN
        PERFORM pg_sleep(1.5);
        RETURN NEW;
      END;
      $barrier$;
      CREATE TRIGGER ${barrierTrigger}
      BEFORE UPDATE ON accounting_case_operations
      FOR EACH ROW
      WHEN (OLD.state = 'PENDING' AND NEW.state = 'PREPARED'
        AND OLD.operation_id = '${barrierOperationId}')
      EXECUTE FUNCTION ${barrierFunction}();
    `);
    const waitForSleep = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const activity = await repository.pool.query<{ wait_event: string | null }>(
          `SELECT wait_event FROM pg_stat_activity
           WHERE application_name = $1 AND state = 'active'`,
          [applicationA],
        );
        if (activity.rows.some((row) => row.wait_event === "PgSleep")) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      throw new Error("native preflight barrier was not reached");
    };
    let preflightPromise: ReturnType<PostgresAccountingRepository["recordAccountingCasePreflight"]> | undefined;
    let advancePromise: ReturnType<PostgresAccountingRepository["createOrAdvanceAccountingCase"]> | undefined;
    try {
      preflightPromise = repositoryA.recordAccountingCasePreflight(preflightInput);
      await waitForSleep();
      advancePromise = repositoryB.createOrAdvanceAccountingCase({
        binding,
        compiled: second,
        compiledPlanHash: accountingCasePlanHash(binding, second),
        now: createdAt,
      });
      const outcomes = await Promise.allSettled([preflightPromise, advancePromise]);
      expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { mode: "PREFLIGHTED" } });
      expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
      expect(JSON.stringify(outcomes)).not.toContain("40P01");
      await expect(repository.getBoundAccountingCase({ binding, caseId })).resolves.toMatchObject({
        compiled: { version: 1 },
        state: "PREFLIGHTED",
      });
    } finally {
      await Promise.allSettled([
        ...(preflightPromise ? [preflightPromise] : []),
        ...(advancePromise ? [advancePromise] : []),
      ]);
      await repositoryA.close();
      await repositoryB.close();
      await repository.pool.query(`DROP TRIGGER IF EXISTS ${barrierTrigger} ON accounting_case_operations`);
      await repository.pool.query(`DROP FUNCTION IF EXISTS ${barrierFunction}()`);
    }
  }, 10_000);

  it("atomically transfers an expired zero-request PREPARED contact using only PostgreSQL time", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const number = `RECOVER-${suffix}`;
    const oldBinding = await saveTargetBinding(
      "expired-preparation-owner",
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const successorBinding = await saveTargetBinding(
      "expired-preparation-successor",
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const oldCase = await createContactCase(
      `case-pg-contact-expired-owner-${suffix}`,
      number,
      oldBinding,
    );
    const preparationExpiresAt = new Date(Date.now() + 600);
    const oldPreflight = await preflightContactCase(oldCase, oldBinding, preparationExpiresAt);
    await waitUntilAfter(preparationExpiresAt);

    const successor = await createContactCase(
      `case-pg-contact-expired-successor-${suffix}`,
      number,
      successorBinding,
      "US",
      "IRS",
      // A backdated caller cannot influence the database-owned abandonment clock.
      createdAt,
    );
    expect(successor.operations[0]?.businessIdentityHash)
      .not.toBe(oldCase.operations[0]?.businessIdentityHash);
    expect(successor.operations[0]?.businessReservation)
      .toEqual(oldCase.operations[0]?.businessReservation);

    await expect(repository.getBoundAccountingCase({
      binding: oldBinding,
      caseId: oldCase.caseId,
      version: oldCase.version,
    })).resolves.toMatchObject({
      state: "TERMINAL",
      executionRequestId: oldPreflight.requestId,
      operations: [expect.objectContaining({
        state: "BLOCKED_VALIDATION",
        errorReceipt: expect.objectContaining({
          receiptType: "ACCOUNTING_CASE_NO_WRITE_STARTED",
          disposition: "ABANDONED",
          mutationRequestAbsent: true,
          writeClaimAbsent: true,
          providerPermitAbsentByDurableClaimInvariant: true,
          providerCallAbsentByPermitInvariant: true,
          successorCaseId: successor.caseId,
        }),
      })],
    });
    await expect(repository.getXeroMutationPreparation(
      oldPreflight.preparations[0]!.preparationId,
    )).resolves.toMatchObject({ state: "EXPIRED" });
    const requestCount = await repository.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM xero_mutation_requests WHERE preparation_id = $1",
      [oldPreflight.preparations[0]!.preparationId],
    );
    expect(requestCount.rows[0]?.count).toBe("0");
  });

  it("rejects backdated PREPARED insertion and ignores a future caller clock for transfer eligibility", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const livenessBinding = await saveTargetBinding(
      "backdated-preflight",
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const expiredCase = await createContactCase(
      `case-pg-contact-backdated-preflight-${suffix}`,
      `BACKDATED-${suffix}`,
      livenessBinding,
    );
    const expiredAt = new Date(Date.now() + 500);
    const expiredPreparation = await prepareWholeCase(expiredCase, {
      binding: livenessBinding,
      expiresAt: expiredAt,
    });
    await waitUntilAfter(expiredAt);
    await expect(recordPreflight(
      expiredCase,
      expiredPreparation.operations,
      `backdated-preflight-${suffix}`,
      createdAt,
      livenessBinding,
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const futureOwnerBinding = await saveTargetBinding(
      "future-owner",
      new Date(Date.now() + 3 * 60 * 60_000),
    );
    const futureSuccessorBinding = await saveTargetBinding(
      "future-successor",
      new Date(Date.now() + 3 * 60 * 60_000),
    );
    const number = `FUTURE-${suffix}`;
    const futureOwner = await createContactCase(
      `case-pg-contact-future-owner-${suffix}`,
      number,
      futureOwnerBinding,
    );
    const futurePreflight = await preflightContactCase(
      futureOwner,
      futureOwnerBinding,
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const futureSuccessor = compileAccountingCase(contactOnlyInput({
      caseId: `case-pg-contact-future-successor-${suffix}`,
      jurisdiction: "US",
      registryScheme: "IRS",
      number,
    }));
    caseIds.add(futureSuccessor.caseId);
    await expect(repository.createOrAdvanceAccountingCase({
      binding: futureSuccessorBinding,
      compiled: futureSuccessor,
      compiledPlanHash: accountingCasePlanHash(futureSuccessorBinding, futureSuccessor),
      // The caller claims one hour has elapsed, while PostgreSQL has not crossed
      // either the preparation or target lease boundary.
      now: new Date(Date.now() + 60 * 60_000),
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reasonCodes: ["ACCOUNTING_CASE_CONTACT_BARE_NUMBER_ALREADY_RESERVED"] },
    });
    await expect(repository.getXeroMutationPreparation(
      futurePreflight.preparations[0]!.preparationId,
    )).resolves.toMatchObject({ state: "PREPARED" });
  });

  it("serializes expired cleanup against provider-write claim across two PostgreSQL connections", async () => {
    if (!repository || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const targetExpiresAt = new Date(Date.now() + 700);
    const oldBinding = await saveTargetBinding("cleanup-claim-race-owner", targetExpiresAt);
    const successorBinding = await saveTargetBinding(
      "cleanup-claim-race-successor",
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const number = `CLEANUP-CLAIM-${suffix}`;
    const oldCase = await createContactCase(
      `case-pg-contact-cleanup-claim-owner-${suffix}`,
      number,
      oldBinding,
    );
    const oldPreflight = await preflightContactCase(
      oldCase,
      oldBinding,
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const preparation = oldPreflight.preparations[0]!;
    const mutationRequestId = durableId("xmr");
    mutationRequestIds.add(mutationRequestId);
    const successor = compileAccountingCase(contactOnlyInput({
      caseId: `case-pg-contact-cleanup-claim-successor-${suffix}`,
      jurisdiction: "US",
      registryScheme: "IRS",
      number,
    }));
    caseIds.add(successor.caseId);
    const secondRepository = new PostgresAccountingRepository(databaseUrl);
    await waitUntilAfter(targetExpiresAt);
    try {
      const [transfer, claim] = await Promise.all([
        repository.createOrAdvanceAccountingCase({
          binding: successorBinding,
          compiled: successor,
          compiledPlanHash: accountingCasePlanHash(successorBinding, successor),
          now: createdAt,
        }),
        secondRepository.confirmXeroMutationPreparation(
          mutationConfirmationInput(preparation, mutationRequestId),
        ),
      ]);
      expect(transfer).toMatchObject({ mode: "CREATED" });
      expect(claim).toBeUndefined();
      await expect(repository.getXeroMutationRequest(mutationRequestId)).resolves.toBeUndefined();
      await expect(repository.getBoundAccountingCase({
        binding: oldBinding,
        caseId: oldCase.caseId,
        version: oldCase.version,
      })).resolves.toMatchObject({
        state: "TERMINAL",
        operations: [expect.objectContaining({
          state: "BLOCKED_VALIDATION",
          errorReceipt: expect.objectContaining({
            receiptType: "ACCOUNTING_CASE_NO_WRITE_STARTED",
          }),
        })],
      });
    } finally {
      await secondRepository.close();
    }
  });

  it("orders reseal and expired cleanup without a coordinate/version deadlock", async () => {
    if (!repository || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const number = `RESEAL-CLEANUP-${suffix}`;
    const oldCase = await createContactCase(
      `case-pg-contact-reseal-cleanup-owner-${suffix}`,
      number,
      binding,
    );
    const oldExpiresAt = new Date(Date.now() + 600);
    const oldPreflight = await preflightContactCase(oldCase, binding, oldExpiresAt);
    await waitUntilAfter(oldExpiresAt);
    await expirePreparation(oldPreflight.preparations[0]!, new Date());
    const resealedAt = new Date(oldExpiresAt.getTime() + 1_000);
    const reseal = await resealInput(oldCase, oldPreflight.requestId, resealedAt);

    const successor = compileAccountingCase(contactOnlyInput({
      caseId: `case-pg-contact-reseal-cleanup-successor-${suffix}`,
      jurisdiction: "US",
      registryScheme: "IRS",
      number,
    }));
    caseIds.add(successor.caseId);

    const barrierFunction = `aaa_contact_reseal_barrier_fn_${suffix.slice(0, 20)}`;
    const barrierTrigger = `aaa_contact_reseal_barrier_${suffix.slice(0, 20)}`;
    const resealApplication = `contact-reseal-${suffix.slice(0, 20)}`;
    const cleanupApplication = `contact-cleanup-${suffix.slice(0, 20)}`;
    const connectionUrl = (applicationName: string) => {
      const url = new URL(databaseUrl);
      url.searchParams.set("application_name", applicationName);
      return url.toString();
    };
    const resealRepository = new PostgresAccountingRepository(connectionUrl(resealApplication));
    const cleanupRepository = new PostgresAccountingRepository(connectionUrl(cleanupApplication));

    await repository.pool.query(`
      CREATE FUNCTION ${barrierFunction}() RETURNS trigger
      LANGUAGE plpgsql AS $barrier$
      BEGIN
        PERFORM pg_sleep(1.0);
        RETURN NEW;
      END;
      $barrier$;
      CREATE TRIGGER ${barrierTrigger}
      BEFORE UPDATE ON accounting_case_operations
      FOR EACH ROW
      WHEN (
        OLD.state = 'PREPARED' AND NEW.state = 'PREPARED'
        AND OLD.preparation_id IS DISTINCT FROM NEW.preparation_id
      )
      EXECUTE FUNCTION ${barrierFunction}();
    `);

    const waitForActivity = async (
      applicationName: string,
      predicate: (row: { wait_event_type: string | null; wait_event: string | null }) => boolean,
    ) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await repository.pool.query<{
          wait_event_type: string | null;
          wait_event: string | null;
        }>(
          `SELECT wait_event_type, wait_event
           FROM pg_stat_activity
           WHERE application_name = $1 AND state = 'active'`,
          [applicationName],
        );
        if (activity.rows.some(predicate)) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      throw new Error(`PostgreSQL barrier was not reached by ${applicationName}`);
    };

    let resealPromise: Promise<Awaited<ReturnType<typeof resealRepository.resealAndClaimAccountingCaseExecution>>> | undefined;
    let cleanupPromise: Promise<CreateOrAdvanceAccountingCaseResult> | undefined;
    try {
      resealPromise = resealRepository.resealAndClaimAccountingCaseExecution(reseal);
      await waitForActivity(resealApplication, (row) => row.wait_event === "PgSleep");

      cleanupPromise = cleanupRepository.createOrAdvanceAccountingCase({
        binding,
        compiled: successor,
        compiledPlanHash: accountingCasePlanHash(binding, successor),
        now: createdAt,
      });
      await waitForActivity(cleanupApplication, (row) => row.wait_event_type === "Lock");

      const [resealResult, cleanupResult] = await Promise.allSettled([resealPromise, cleanupPromise]);
      expect(resealResult).toMatchObject({
        status: "fulfilled",
        value: { mode: "RESEALED_AND_CLAIMED", record: { state: "EXECUTING" } },
      });
      expect(cleanupResult).toMatchObject({
        status: "rejected",
        reason: { code: "CONFLICT" },
      });
      const databaseErrorCodes = JSON.stringify([resealResult, cleanupResult]);
      expect(databaseErrorCodes).not.toContain("40P01");
      expect(databaseErrorCodes).not.toContain("55P03");

      await expect(repository.getBoundAccountingCase({
        binding,
        caseId: oldCase.caseId,
        version: oldCase.version,
      })).resolves.toMatchObject({
        state: "EXECUTING",
        operations: [expect.objectContaining({
          state: "PREPARED",
          originalPreparationId: oldPreflight.preparations[0]!.preparationId,
          preparationId: reseal.operations[0]!.newPreparationId,
        })],
      });
      await expect(repository.getBoundAccountingCase({
        binding,
        caseId: successor.caseId,
        version: successor.version,
      })).resolves.toBeUndefined();
    } finally {
      await Promise.allSettled([
        ...(resealPromise ? [resealPromise] : []),
        ...(cleanupPromise ? [cleanupPromise] : []),
      ]);
      await resealRepository.close();
      await cleanupRepository.close();
      await repository.pool.query(`DROP TRIGGER IF EXISTS ${barrierTrigger} ON accounting_case_operations`);
      await repository.pool.query(`DROP FUNCTION IF EXISTS ${barrierFunction}()`);
    }
  }, 15_000);

  it("sorts multi-contact cleanup coordinates so reversed successor plans cannot deadlock", async () => {
    if (!repository || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const numberA = `MULTI-A-${suffix}`;
    const numberB = `MULTI-B-${suffix}`;
    const ownerA = await createContactCase(
      `case-pg-contact-multi-owner-a-${suffix}`,
      numberA,
      binding,
    );
    const ownerB = await createContactCase(
      `case-pg-contact-multi-owner-b-${suffix}`,
      numberB,
      binding,
    );
    const expiresAt = new Date(Date.now() + 600);
    await preflightContactCase(ownerA, binding, expiresAt);
    await preflightContactCase(ownerB, binding, expiresAt);
    await waitUntilAfter(expiresAt);

    const candidates = Array.from({ length: 64 }, (_, index) => compileAccountingCase(twoContactInput(
      `case-pg-contact-multi-successor-${index}-${suffix}`,
      { jurisdiction: "US", registryScheme: "IRS", number: numberA },
      { jurisdiction: "HK", registryScheme: "CR", number: numberB },
    )));
    const successorA = candidates[0]!;
    const successorAOrder = successorA.operations.map(
      (operation) => operation.businessReservation.coordinateHash,
    );
    const successorB = candidates.find((candidate) => {
      const order = candidate.operations.map(
        (operation) => operation.businessReservation.coordinateHash,
      );
      return order.length === 2 && order[0] === successorAOrder[1] && order[1] === successorAOrder[0];
    });
    if (!successorB) throw new Error("Fixture could not find two Case-bound reverse operation orders");
    caseIds.add(successorA.caseId);
    caseIds.add(successorB.caseId);
    expect(successorB.operations.map((operation) => operation.businessReservation.coordinateHash))
      .toEqual([...successorAOrder].reverse());
    expect(successorA.operations.map((operation) => operation.businessReservation.coordinateHash).sort())
      .toEqual(successorB.operations.map((operation) => operation.businessReservation.coordinateHash).sort());

    const applicationA = `multi-cleanup-a-${suffix.slice(0, 20)}`;
    const applicationB = `multi-cleanup-b-${suffix.slice(0, 20)}`;
    const connectionUrl = (applicationName: string) => {
      const url = new URL(databaseUrl);
      url.searchParams.set("application_name", applicationName);
      return url.toString();
    };
    const repositoryA = new PostgresAccountingRepository(connectionUrl(applicationA));
    const repositoryB = new PostgresAccountingRepository(connectionUrl(applicationB));
    const barrierFunction = `aaa_contact_multi_barrier_fn_${suffix.slice(0, 20)}`;
    const barrierTrigger = `aaa_contact_multi_barrier_${suffix.slice(0, 20)}`;
    await repository.pool.query(`
      CREATE FUNCTION ${barrierFunction}() RETURNS trigger
      LANGUAGE plpgsql AS $barrier$
      BEGIN
        PERFORM pg_sleep(2.0);
        RETURN NEW;
      END;
      $barrier$;
      CREATE TRIGGER ${barrierTrigger}
      BEFORE UPDATE ON accounting_case_versions
      FOR EACH ROW
      WHEN (OLD.state = 'PREFLIGHTED' AND NEW.state = 'EXECUTING')
      EXECUTE FUNCTION ${barrierFunction}();
    `);
    const waitForActivity = async (
      applicationName: string,
      predicate: (row: { wait_event_type: string | null; wait_event: string | null }) => boolean,
    ) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const activity = await repository.pool.query<{
          wait_event_type: string | null;
          wait_event: string | null;
        }>(
          `SELECT wait_event_type, wait_event
           FROM pg_stat_activity
           WHERE application_name = $1 AND state = 'active'`,
          [applicationName],
        );
        if (activity.rows.some(predicate)) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      throw new Error(`PostgreSQL multi-coordinate barrier was not reached by ${applicationName}`);
    };
    let promiseA: Promise<CreateOrAdvanceAccountingCaseResult> | undefined;
    let promiseB: Promise<CreateOrAdvanceAccountingCaseResult> | undefined;
    try {
      promiseA = repositoryA.createOrAdvanceAccountingCase({
        binding,
        compiled: successorA,
        compiledPlanHash: accountingCasePlanHash(binding, successorA),
        now: createdAt,
      });
      await waitForActivity(applicationA, (row) => row.wait_event === "PgSleep");
      promiseB = repositoryB.createOrAdvanceAccountingCase({
        binding,
        compiled: successorB,
        compiledPlanHash: accountingCasePlanHash(binding, successorB),
        now: createdAt,
      });
      await waitForActivity(applicationB, (row) => row.wait_event_type === "Lock");
      const results = await Promise.allSettled([promiseA, promiseB]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const serialized = JSON.stringify(results);
      expect(serialized).not.toContain("40P01");
      expect(serialized).not.toContain("55P03");
      const winner = results.find((result) => result.status === "fulfilled");
      const loser = results.find((result) => result.status === "rejected");
      expect(winner).toMatchObject({ status: "fulfilled", value: { mode: "CREATED" } });
      expect(loser).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });

      const durableSuccessors = await Promise.all([successorA, successorB].map((compiled) =>
        repository.getBoundAccountingCase({
          binding,
          caseId: compiled.caseId,
          version: compiled.version,
        })));
      expect(durableSuccessors.filter(Boolean)).toHaveLength(1);
      await expect(repository.getBoundAccountingCase({
        binding,
        caseId: ownerA.caseId,
        version: ownerA.version,
      })).resolves.toMatchObject({ state: "TERMINAL" });
      await expect(repository.getBoundAccountingCase({
        binding,
        caseId: ownerB.caseId,
        version: ownerB.version,
      })).resolves.toMatchObject({ state: "TERMINAL" });
    } finally {
      await Promise.allSettled([
        ...(promiseA ? [promiseA] : []),
        ...(promiseB ? [promiseB] : []),
      ]);
      await repositoryA.close();
      await repositoryB.close();
      await repository.pool.query(`DROP TRIGGER IF EXISTS ${barrierTrigger} ON accounting_case_versions`);
      await repository.pool.query(`DROP FUNCTION IF EXISTS ${barrierFunction}()`);
    }
  }, 15_000);

  it("permanently blocks transfer after IN_FLIGHT, UNKNOWN, MISMATCH, or VERIFIED durable claims", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const targetExpiresAt = new Date(Date.now() + 1_000);
    const oldBinding = await saveTargetBinding("durable-claim-owner", targetExpiresAt);
    const successorBinding = await saveTargetBinding(
      "durable-claim-successor",
      new Date(Date.now() + 3 * 60 * 60_000),
    );
    const claims: Array<{
      label: "in-flight" | "unknown" | "mismatch" | "verified";
      expectedState: "WRITE_IN_FLIGHT" | "WRITE_UNCERTAIN" | "READBACK_MISMATCH" | "READBACK_VERIFIED";
      number: string;
      oldCase: CompiledAccountingCase;
      mutationRequestId: string;
    }> = [];

    for (const label of ["in-flight", "unknown", "mismatch", "verified"] as const) {
      const number = `DURABLE-${label}-${suffix}`;
      const oldCase = await createContactCase(
        `case-pg-contact-durable-${label}-${suffix}`,
        number,
        oldBinding,
      );
      const preflight = await preflightContactCase(
        oldCase,
        oldBinding,
        new Date(Date.now() + 2 * 60 * 60_000),
      );
      const preparation = preflight.preparations[0]!;
      const { mutationRequestId } = await confirmMutation(preparation);
      const bound = boundMutationInput(preparation, mutationRequestId);
      const xeroObjectId = `contact-${label}-${suffix}`;
      const writeReceipt = { providerRequestId: `provider-${label}-${suffix}` };
      if (label === "unknown") {
        await repository.markXeroMutationWriteUnknown({ ...bound, xeroObjectId, writeReceipt });
      } else if (label === "mismatch" || label === "verified") {
        await repository.recordXeroMutationWriteEvidence({ ...bound, xeroObjectId, writeReceipt });
        const canonicalPayload = label === "mismatch"
          ? { ...preparation.canonicalPayload, deliberatelyDifferent: true }
          : preparation.canonicalPayload;
        const readbackSnapshot = { xeroObjectId, status: "ACTIVE", canonicalPayload };
        const complete = {
          ...bound,
          xeroObjectId,
          writeReceipt,
          readbackSnapshot,
          readbackSnapshotHash: hashObject(readbackSnapshot),
          readbackCanonicalPayload: canonicalPayload,
          readbackPayloadHash: hashObject(canonicalPayload),
          readbackStatus: "ACTIVE",
        };
        if (label === "mismatch") {
          await repository.markXeroMutationReadbackMismatch(complete);
        } else {
          await repository.markXeroMutationReadbackVerified(complete);
        }
      }
      claims.push({
        label,
        expectedState: label === "in-flight" ? "WRITE_IN_FLIGHT"
          : label === "unknown" ? "WRITE_UNCERTAIN"
          : label === "mismatch" ? "READBACK_MISMATCH"
          : "READBACK_VERIFIED",
        number,
        oldCase,
        mutationRequestId,
      });
    }

    await waitUntilAfter(targetExpiresAt);
    for (const claim of claims) {
      const successor = compileAccountingCase(contactOnlyInput({
        caseId: `case-pg-contact-durable-successor-${claim.label}-${suffix}`,
        jurisdiction: "US",
        registryScheme: "IRS",
        number: claim.number,
      }));
      caseIds.add(successor.caseId);
      await expect(repository.createOrAdvanceAccountingCase({
        binding: successorBinding,
        compiled: successor,
        compiledPlanHash: accountingCasePlanHash(successorBinding, successor),
        now: createdAt,
      })).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reasonCodes: ["ACCOUNTING_CASE_CONTACT_BARE_NUMBER_ALREADY_RESERVED"] },
      });
      await expect(repository.getXeroMutationRequest(claim.mutationRequestId))
        .resolves.toMatchObject({ state: claim.expectedState });
      await expect(repository.getBoundAccountingCase({
        binding: oldBinding,
        caseId: claim.oldCase.caseId,
        version: claim.oldCase.version,
      })).resolves.toMatchObject({
        state: "PREFLIGHTED",
        operations: [expect.objectContaining({ state: "PREPARED" })],
      });
    }
  });

  it("rolls back an eligible abandonment when another operation in the successor plan is still reserved", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const staleNumber = `MIXED-STALE-${suffix}`;
    const liveNumber = `MIXED-LIVE-${suffix}`;
    const staleBinding = await saveTargetBinding(
      "mixed-stale-owner",
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const liveBinding = await saveTargetBinding(
      "mixed-live-owner",
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const successorBinding = await saveTargetBinding(
      "mixed-successor",
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    const staleCase = await createContactCase(
      `case-pg-contact-mixed-stale-${suffix}`,
      staleNumber,
      staleBinding,
    );
    const staleExpiresAt = new Date(Date.now() + 600);
    const stalePreflight = await preflightContactCase(staleCase, staleBinding, staleExpiresAt);
    const liveCase = await createContactCase(
      `case-pg-contact-mixed-live-${suffix}`,
      liveNumber,
      liveBinding,
    );
    await waitUntilAfter(staleExpiresAt);

    const successor = compileAccountingCase(twoContactInput(
      `case-pg-contact-mixed-successor-${suffix}`,
      { jurisdiction: "US", registryScheme: "IRS", number: staleNumber },
      { jurisdiction: "HK", registryScheme: "CR", number: liveNumber },
    ));
    expect(successor.operations).toHaveLength(2);
    caseIds.add(successor.caseId);
    await expect(repository.createOrAdvanceAccountingCase({
      binding: successorBinding,
      compiled: successor,
      compiledPlanHash: accountingCasePlanHash(successorBinding, successor),
      now: createdAt,
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reasonCodes: ["ACCOUNTING_CASE_CONTACT_BARE_NUMBER_ALREADY_RESERVED"] },
    });

    await expect(repository.getBoundAccountingCase({
      binding: staleBinding,
      caseId: staleCase.caseId,
      version: staleCase.version,
    })).resolves.toMatchObject({
      state: "PREFLIGHTED",
      operations: [expect.objectContaining({ state: "PREPARED" })],
    });
    await expect(repository.getXeroMutationPreparation(
      stalePreflight.preparations[0]!.preparationId,
    )).resolves.toMatchObject({ state: "PREPARED" });
    await expect(repository.getBoundAccountingCase({
      binding: liveBinding,
      caseId: liveCase.caseId,
      version: liveCase.version,
    })).resolves.toMatchObject({
      state: "PLANNED_NEEDS_PREFLIGHT",
      operations: [expect.objectContaining({ state: "PENDING" })],
    });
    await expect(repository.getBoundAccountingCase({
      binding: successorBinding,
      caseId: successor.caseId,
      version: successor.version,
    })).resolves.toBeUndefined();
  });

  it("hydrates a migrated 034 Case sidecar through get, preflight, and execution claim", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const caseId = `case-pg-legacy-034-${suffix}`;
    const current = await createCase(caseId);
    const legacy = structuredClone(current) as CompiledAccountingCase;
    for (const operation of legacy.operations) {
      delete (operation as unknown as { businessReservation?: unknown }).businessReservation;
    }
    const legacyPlanHash = accountingCasePlanHash(binding, legacy);
    const migrationFixtureClient = await repository.pool.connect();
    try {
      await migrationFixtureClient.query("BEGIN");
      // Simulate the immutable JSON shape that was legitimately inserted before
      // migration 035. Replica mode is transaction-local and bypasses the
      // ordinary plan-immutability guards; the reservation overlap trigger is
      // ENABLE ALWAYS, so the new durable collision boundary remains active.
      await migrationFixtureClient.query("SET LOCAL session_replication_role = replica");
      await migrationFixtureClient.query(
        `UPDATE accounting_case_versions
         SET compiled_case = $3::jsonb, compiled_plan_hash = $4
         WHERE case_id = $1 AND version = $2`,
        [caseId, legacy.version, legacy, legacyPlanHash],
      );
      for (const operation of legacy.operations) {
        await migrationFixtureClient.query(
          `UPDATE accounting_case_operations SET operation_json = $4::jsonb
           WHERE case_id = $1 AND case_version = $2 AND operation_id = $3`,
          [caseId, legacy.version, operation.operationId, operation],
        );
      }
      await migrationFixtureClient.query("COMMIT");
    } catch (error) {
      await migrationFixtureClient.query("ROLLBACK");
      throw error;
    } finally {
      migrationFixtureClient.release();
    }

    const hydrated = await repository.getBoundAccountingCase({
      binding,
      caseId,
      version: legacy.version,
    });
    expect(hydrated?.compiled.operations.every((operation) =>
      !("businessReservation" in operation))).toBe(true);
    expect(hydrated?.operations.every((record) =>
      record.operation.businessReservation.coordinateHash.length === 64)).toBe(true);

    const prepared = await prepareWholeCase(legacy);
    const requestId = `legacy-034-execute-${suffix}`;
    await expect(recordPreflight(legacy, prepared.operations, requestId))
      .resolves.toMatchObject({ mode: "PREFLIGHTED", record: { state: "PREFLIGHTED" } });
    await expect(repository.claimAccountingCaseExecution({
      binding,
      caseId,
      version: legacy.version,
      requestId,
      expectedPlanHash: legacyPlanHash,
      now: createdAt,
    })).resolves.toMatchObject({ mode: "CLAIMED", record: { state: "EXECUTING" } });
  });

  it("rejects swapped, cross-Case, wrong-route, wrong-hash, wrong-source, and expired preparations", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");

    const swappedCase = await createCase(`case-pg-swapped-${suffix}`);
    const swapped = await prepareWholeCase(swappedCase);
    if (swapped.operations.length < 2) throw new Error("Fixture must compile at least two operations");
    [swapped.operations[0], swapped.operations[1]] = [swapped.operations[1]!, swapped.operations[0]!];
    swapped.operations[0] = { ...swapped.operations[0]!, operationId: swappedCase.operations[0]!.operationId };
    swapped.operations[1] = { ...swapped.operations[1]!, operationId: swappedCase.operations[1]!.operationId };
    await expect(recordPreflight(swappedCase, swapped.operations, `swap-${suffix}`))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const foreignCase = await createCase(`case-pg-foreign-${suffix}`);
    const foreign = await prepareWholeCase(foreignCase);
    const victimCase = await createCase(`case-pg-cross-victim-${suffix}`);
    const victim = await prepareWholeCase(victimCase);
    victim.operations[0] = {
      ...victim.operations[0]!,
      preparationId: foreign.preparations[0]!.preparationId,
      preparationCanonicalPayloadHash: foreign.preparations[0]!.canonicalPayloadHash,
      sourceSha256: foreign.preparations[0]!.sourceSha256,
    };
    await expect(recordPreflight(victimCase, victim.operations, `cross-${suffix}`))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const routeCase = await createCase(`case-pg-route-${suffix}`);
    const routePrepared = await prepareWholeCase(routeCase);
    const wrongRoute = await prepareOperation(routeCase, routeCase.operations[0]!, {
      route: { objectType: "ITEM", operation: "CREATE" },
    });
    routePrepared.operations[0] = {
      ...routePrepared.operations[0]!,
      preparationId: wrongRoute.preparationId,
      preparationCanonicalPayloadHash: wrongRoute.canonicalPayloadHash,
      sourceSha256: wrongRoute.sourceSha256,
    };
    await expect(recordPreflight(routeCase, routePrepared.operations, `route-${suffix}`))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const hashCase = await createCase(`case-pg-hash-${suffix}`);
    const wrongOperationHash = await prepareWholeCase(hashCase);
    wrongOperationHash.operations[0] = {
      ...wrongOperationHash.operations[0]!,
      operationCanonicalPayloadHash: "f".repeat(64),
    };
    await expect(recordPreflight(hashCase, wrongOperationHash.operations, `operation-hash-${suffix}`))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const preparationHashCase = await createCase(`case-pg-prep-hash-${suffix}`);
    const wrongPreparationHash = await prepareWholeCase(preparationHashCase);
    wrongPreparationHash.operations[0] = {
      ...wrongPreparationHash.operations[0]!,
      preparationCanonicalPayloadHash: "e".repeat(64),
    };
    await expect(recordPreflight(
      preparationHashCase,
      wrongPreparationHash.operations,
      `preparation-hash-${suffix}`,
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const sourceCase = await createCase(`case-pg-source-${suffix}`);
    const wrongSource = await prepareWholeCase(sourceCase);
    wrongSource.operations[0] = { ...wrongSource.operations[0]!, sourceSha256: "d".repeat(64) };
    await expect(recordPreflight(sourceCase, wrongSource.operations, `source-${suffix}`))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const expiredCase = await createCase(`case-pg-expired-${suffix}`);
    const expired = await prepareWholeCase(expiredCase, {
      expiresAt: new Date(createdAt.getTime() + 60_000),
    });
    await expect(recordPreflight(
      expiredCase,
      expired.operations,
      `expired-${suffix}`,
      new Date(createdAt.getTime() + 60_001),
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("atomically reseals expired PREFLIGHTED operations while preserving the original seal", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiled = await createCase(`case-pg-reseal-expired-${suffix}`);
    const requestId = `reseal-expired-${suffix}`;
    const originalExpiresAt = new Date(Date.now() + 60_000);
    const prepared = await prepareWholeCase(compiled, {
      expiresAt: originalExpiresAt,
    });
    const preflight = await recordPreflight(compiled, prepared.operations, requestId);
    const originalReceipt = structuredClone(preflight.record.preflightReceipt);
    const originalReceiptHash = preflight.record.preflightReceiptHash;
    const originalPreparationIds = prepared.preparations.map((candidate) => candidate.preparationId);
    const resealedAt = new Date(originalExpiresAt.getTime() + 1_000);
    for (const preparation of prepared.preparations) {
      await expirePreparation(preparation, resealedAt);
    }
    const mutationRequestsBeforeReseal = await repository.pool.query(
      "SELECT count(*)::int AS count FROM xero_mutation_requests WHERE preparation_id = ANY($1::text[])",
      [originalPreparationIds],
    );
    expect(mutationRequestsBeforeReseal.rows[0]).toMatchObject({ count: 0 });

    const input = await resealInput(compiled, requestId, resealedAt);
    const result = await repository.resealAndClaimAccountingCaseExecution(input);

    expect(result).toMatchObject({
      mode: "RESEALED_AND_CLAIMED",
      record: {
        state: "EXECUTING",
        executionRequestId: requestId,
        preflightReceipt: originalReceipt,
        preflightReceiptHash: originalReceiptHash,
        originalPreflightReceiptHash: originalReceiptHash,
        effectivePreflightSealHash: input.resealReceiptHash,
        preflightResealRevision: 1,
        preflightReseals: [expect.objectContaining({
          revision: 1,
          previousEffectiveSealHash: originalReceiptHash,
          effectiveSealHash: input.resealReceiptHash,
        })],
      },
    });
    expect(result.record.operations.map((operation) => operation.originalPreparationId))
      .toEqual(originalPreparationIds);
    expect(result.record.operations.map((operation) => operation.preparationId))
      .toEqual(input.operations.map((operation) => operation.newPreparationId));
    for (const originalPreparationId of originalPreparationIds) {
      await expect(repository.getXeroMutationPreparation(originalPreparationId))
        .resolves.toMatchObject({ state: "EXPIRED" });
    }
  });

  it("rejects reseal when an old preparation already has a mutation request", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiled = await createCase(`case-pg-reseal-request-${suffix}`);
    const requestId = `reseal-request-${suffix}`;
    const prepared = await prepareWholeCase(compiled);
    await recordPreflight(compiled, prepared.operations, requestId);
    await confirmMutation(prepared.preparations[0]!);
    const input = await resealInput(
      compiled,
      requestId,
      new Date(createdAt.getTime() + 21 * 60_000),
    );

    await expect(repository.resealAndClaimAccountingCaseExecution(input))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(repository.getBoundAccountingCase({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
    })).resolves.toMatchObject({
      state: "PREFLIGHTED",
      preflightResealRevision: 0,
    });
  });

  it("rejects wrong receipt hash, source, binding, and swapped reseal replacements", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const originalExpiresAt = new Date(Date.now() + 60_000);
    const resealedAt = new Date(originalExpiresAt.getTime() + 1_000);

    async function expiredPreflight(label: string) {
      const compiled = await createCase(`case-pg-reseal-${label}-${suffix}`);
      const requestId = `reseal-${label}-${suffix}`;
      const prepared = await prepareWholeCase(compiled, {
        expiresAt: originalExpiresAt,
      });
      await recordPreflight(compiled, prepared.operations, requestId);
      for (const preparation of prepared.preparations) {
        await expirePreparation(preparation, resealedAt);
      }
      return { compiled, requestId };
    }

    const wrongHashCase = await expiredPreflight("wrong-hash");
    const wrongHash = await resealInput(wrongHashCase.compiled, wrongHashCase.requestId, resealedAt);
    wrongHash.resealReceiptHash = "f".repeat(64);
    await expect(repository.resealAndClaimAccountingCaseExecution(wrongHash))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const wrongSourceCase = await expiredPreflight("wrong-source");
    const wrongSource = await resealInput(wrongSourceCase.compiled, wrongSourceCase.requestId, resealedAt, {
      replacementSourceSha256: "d".repeat(64),
    });
    await expect(repository.resealAndClaimAccountingCaseExecution(wrongSource))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const wrongBindingCase = await expiredPreflight("wrong-binding");
    const wrongBinding = await resealInput(wrongBindingCase.compiled, wrongBindingCase.requestId, resealedAt, {
      replacementBindingId: `wrong-binding-${suffix}`,
    });
    await expect(repository.resealAndClaimAccountingCaseExecution(wrongBinding))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const swappedCase = await expiredPreflight("swapped");
    const swapped = await resealInput(swappedCase.compiled, swappedCase.requestId, resealedAt, {
      swapReplacementIds: true,
    });
    await expect(repository.resealAndClaimAccountingCaseExecution(swapped))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    for (const testCase of [wrongHashCase, wrongSourceCase, wrongBindingCase, swappedCase]) {
      await expect(repository.getBoundAccountingCase({
        binding,
        caseId: testCase.compiled.caseId,
        version: testCase.compiled.version,
      })).resolves.toMatchObject({ state: "PREFLIGHTED", preflightResealRevision: 0 });
    }
  });

  it("makes concurrent identical reseals one claim and one resume", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiled = await createCase(`case-pg-reseal-race-${suffix}`);
    const requestId = `reseal-race-${suffix}`;
    const originalExpiresAt = new Date(Date.now() + 60_000);
    const prepared = await prepareWholeCase(compiled, {
      expiresAt: originalExpiresAt,
    });
    await recordPreflight(compiled, prepared.operations, requestId);
    const resealedAt = new Date(originalExpiresAt.getTime() + 1_000);
    for (const preparation of prepared.preparations) {
      await expirePreparation(preparation, resealedAt);
    }
    const input = await resealInput(compiled, requestId, resealedAt);

    const results = await Promise.all([
      repository.resealAndClaimAccountingCaseExecution(input),
      repository.resealAndClaimAccountingCaseExecution(structuredClone(input)),
    ]);
    expect(results.map((result) => result.mode).sort()).toEqual(["RESEALED_AND_CLAIMED", "RESUME"]);
    for (const result of results) {
      expect(result.record).toMatchObject({
        state: "EXECUTING",
        executionRequestId: requestId,
        preflightResealRevision: 1,
        effectivePreflightSealHash: input.resealReceiptHash,
        preflightReseals: [expect.objectContaining({ revision: 1 })],
      });
    }
  });

  it("enforces exact invoice and credit economics in the PostgreSQL success projection", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiled = await createCase(`case-pg-economic-readback-${suffix}`);
    const prepared = await prepareWholeCase(compiled);
    const executionRequestId = `economic-readback-${suffix}`;
    await recordPreflight(compiled, prepared.operations, executionRequestId);
    await repository.claimAccountingCaseExecution({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      requestId: executionRequestId,
      expectedPlanHash: accountingCasePlanHash(binding, compiled),
      now: createdAt,
    });

    for (const [route, tampered] of [
      ["SALES_INVOICE", true],
      ["CUSTOMER_CREDIT", true],
      ["SUPPLIER_BILL", false],
      ["SUPPLIER_CREDIT", false],
    ] as const) {
      const operationIndex = compiled.operations.findIndex((candidate) => candidate.nativeRoute === route);
      if (operationIndex < 0) throw new Error(`Fixture has no ${route} operation`);
      const operation = compiled.operations[operationIndex]!;
      const preparation = prepared.preparations[operationIndex]!;
      const mutationRequestId = await markCaseEconomicMutation(preparation, operation, tampered);
      const projection = repository.projectAccountingCaseOperationFromMutation({
        binding,
        caseId: compiled.caseId,
        version: compiled.version,
        operationId: operation.operationId,
        requestId: executionRequestId,
        expectedStates: ["PREPARED"],
        desiredState: "READBACK_VERIFIED",
        mutationRequestId,
        now: createdAt,
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
        await repository.finalizeAccountingCase({
          binding,
          caseId: compiled.caseId,
          version: compiled.version,
          requestId: executionRequestId,
          state: "RECOVERY_REQUIRED",
          terminalSummary: {},
          now: createdAt,
        });
        if (!durableMutation?.xeroObjectId || !durableMutation.writeReceipt) {
          throw new Error("Economic mismatch lost its exact provider write evidence");
        }
        const recoveryAt = new Date(createdAt.getTime() + 1_000);
        const correctedSnapshot = {
          xeroObjectId: durableMutation.xeroObjectId,
          status: "DRAFT",
          canonicalPayload: preparation.canonicalPayload,
          evidence: economicReadbackEvidence(operation, durableMutation.xeroObjectId, false),
        };
        await expect(repository.markXeroMutationReadbackVerified({
          ...boundMutationInput(preparation, mutationRequestId),
          xeroObjectId: durableMutation.xeroObjectId,
          writeReceipt: durableMutation.writeReceipt,
          readbackSnapshot: correctedSnapshot,
          readbackSnapshotHash: hashObject(correctedSnapshot),
          readbackCanonicalPayload: preparation.canonicalPayload,
          readbackPayloadHash: preparation.canonicalPayloadHash,
          readbackStatus: "DRAFT",
          now: recoveryAt,
        })).resolves.toMatchObject({
          mutationRequestId,
          state: "READBACK_VERIFIED",
          xeroObjectId: durableMutation.xeroObjectId,
        });
        const recovered = await repository.projectAccountingCaseOperationFromMutation({
          binding,
          caseId: compiled.caseId,
          version: compiled.version,
          operationId: operation.operationId,
          requestId: executionRequestId,
          expectedStates: ["READBACK_MISMATCH"],
          desiredState: "READBACK_VERIFIED",
          mutationRequestId,
          accessMode: "RECOVERY_GET_ONLY",
          now: recoveryAt,
        });
        expect(recovered.operations).toEqual(expect.arrayContaining([
          expect.objectContaining({
            operation: expect.objectContaining({ operationId: operation.operationId }),
            state: "READBACK_VERIFIED",
            mutationRequestId,
            xeroObjectId: durableMutation.xeroObjectId,
          }),
        ]));
        const mutationCount = await repository.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM xero_mutation_requests
           WHERE source_ref = $1 AND source_unit_key = $2`,
          [`case:${compiled.caseId}`, operation.operationId],
        );
        expect(mutationCount.rows[0]?.count).toBe("1");
      } else {
        await expect(projection).resolves.toMatchObject({
          operations: expect.arrayContaining([
            expect.objectContaining({
              operation: expect.objectContaining({ operationId: operation.operationId }),
              state: "READBACK_VERIFIED",
            }),
          ]),
        });
      }
    }
  });

  it("projects only durable mutation evidence and deterministically seals recovery", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const compiled = await createCase(ids.primaryCase);
    const prepared = await prepareWholeCase(compiled);
    const executionRequestId = `execute-${suffix}`;
    await expect(recordPreflight(compiled, prepared.operations, executionRequestId))
      .resolves.toMatchObject({ mode: "PREFLIGHTED" });
    await expect(repository.claimAccountingCaseExecution({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      requestId: executionRequestId,
      expectedPlanHash: accountingCasePlanHash(binding, compiled),
      now: createdAt,
    })).resolves.toMatchObject({ mode: "CLAIMED", record: { state: "EXECUTING" } });

    const operation = compiled.operations[0]!;
    const preparation = prepared.preparations[0]!;
    const fakeMutationRequestId = durableId("xmr");
    await expect(repository.updateAccountingCaseOperation({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      operationId: operation.operationId,
      requestId: executionRequestId,
      expectedStates: ["PREPARED"],
      state: "WRITE_IN_FLIGHT",
      mutationRequestId: fakeMutationRequestId,
      xeroObjectId: `caller-object-${suffix}`,
      writeReceipt: { forged: true },
      now: createdAt,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const { mutationRequestId } = await confirmMutation(preparation);
    await expect(repository.projectAccountingCaseOperationFromMutation({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      operationId: operation.operationId,
      requestId: executionRequestId,
      expectedStates: ["PREPARED"],
      desiredState: "WRITE_IN_FLIGHT",
      mutationRequestId,
      now: createdAt,
    })).resolves.toMatchObject({
      operations: expect.arrayContaining([
        expect.objectContaining({
          state: "WRITE_IN_FLIGHT",
          mutationRequestId,
          preparationCanonicalPayloadHash: preparation.canonicalPayloadHash,
          sourceSha256: preparation.sourceSha256,
        }),
      ]),
    });

    const recovery = await repository.finalizeAccountingCase({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      requestId: executionRequestId,
      state: "RECOVERY_REQUIRED",
      terminalSummary: { forgedByCaller: true, uncertainOperationIds: [] },
      now: createdAt,
    });
    expect(recovery.state).toBe("RECOVERY_REQUIRED");
    expect(recovery.terminalSummary).toEqual(accountingCaseTerminalSummary(recovery, "RECOVERY_REQUIRED"));
    expect(recovery.terminalSummary).not.toHaveProperty("forgedByCaller");
    expect(recovery.terminalSummary).toMatchObject({
      uncertainOperationIds: [operation.operationId],
    });

    const bound = boundMutationInput(preparation, mutationRequestId);
    const xeroObjectId = `xero-object-${suffix}`;
    const writeReceipt = { providerRequestId: `provider-request-${suffix}` };
    await repository.markXeroMutationWriteUnknown({ ...bound, xeroObjectId, writeReceipt });
    const uncertain = await repository.projectAccountingCaseOperationFromMutation({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      operationId: operation.operationId,
      requestId: executionRequestId,
      expectedStates: ["WRITE_IN_FLIGHT"],
      desiredState: "WRITE_UNCERTAIN",
      mutationRequestId,
      accessMode: "RECOVERY_GET_ONLY",
      now: createdAt,
    });
    const uncertainOperation = uncertain.operations.find(
      (candidate) => candidate.operation.operationId === operation.operationId,
    );
    expect(uncertainOperation).toMatchObject({
      state: "WRITE_UNCERTAIN",
      errorReceipt: {
        receiptType: "XERO_MUTATION_STATE_PROJECTION",
        mutationRequestId,
        mutationState: "WRITE_UNCERTAIN",
      },
    });

    const readbackSnapshot = {
      xeroObjectId,
      status: XERO_MUTATION_EXPECTED_READBACK_STATUS[preparation.objectType],
      canonicalPayload: preparation.canonicalPayload,
      evidence: economicReadbackEvidence(operation, xeroObjectId),
    };
    await repository.markXeroMutationReadbackVerified({
      ...bound,
      xeroObjectId,
      writeReceipt,
      readbackSnapshot,
      readbackSnapshotHash: hashObject(readbackSnapshot),
      readbackCanonicalPayload: preparation.canonicalPayload,
      readbackPayloadHash: preparation.canonicalPayloadHash,
      readbackStatus: XERO_MUTATION_EXPECTED_READBACK_STATUS[preparation.objectType],
    });
    const verified = await repository.projectAccountingCaseOperationFromMutation({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      operationId: operation.operationId,
      requestId: executionRequestId,
      expectedStates: ["WRITE_UNCERTAIN"],
      desiredState: "READBACK_VERIFIED",
      mutationRequestId,
      accessMode: "RECOVERY_GET_ONLY",
      now: createdAt,
    });
    const verifiedOperation = verified.operations.find(
      (candidate) => candidate.operation.operationId === operation.operationId,
    );
    expect(verifiedOperation).toMatchObject({
      state: "READBACK_VERIFIED",
      xeroObjectId,
      writeReceipt,
      readbackSnapshot,
    });
    expect(verifiedOperation?.errorReceipt).toBeUndefined();

    for (const residual of compiled.operations.slice(1)) {
      await repository.updateAccountingCaseOperation({
        binding,
        caseId: compiled.caseId,
        version: compiled.version,
        operationId: residual.operationId,
        requestId: executionRequestId,
        expectedStates: ["PREPARED"],
        state: "BLOCKED_VALIDATION",
        errorReceipt: { code: "DEFINITE_TEST_FAILURE", operationId: residual.operationId },
        now: createdAt,
      });
    }
    const beforeFinal = await repository.getBoundAccountingCase({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
    });
    if (!beforeFinal) throw new Error("Case disappeared before finalization");
    const terminal = await repository.finalizeAccountingCase({
      binding,
      caseId: compiled.caseId,
      version: compiled.version,
      requestId: executionRequestId,
      accessMode: "RECOVERY_GET_ONLY",
      state: "PARTIALLY_COMMITTED",
      terminalSummary: { forgedByCaller: true, completed: 999, failed: 0 },
      now: createdAt,
    });
    expect(terminal.terminalSummary).toEqual(accountingCaseTerminalSummary(beforeFinal, "PARTIALLY_COMMITTED"));
    expect(terminal.terminalSummary).not.toHaveProperty("forgedByCaller");
    expect(terminal.terminalSummary).toMatchObject({
      state: "PARTIALLY_COMMITTED",
      completedOperationIds: [operation.operationId],
      definiteFailureOperationIds: compiled.operations.slice(1).map((candidate) => candidate.operationId),
      uncertainOperationIds: [],
      residualOperationIds: [],
    });
  });

  it("atomically adopts an expired-target EXECUTING crash window from durable mutation evidence", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const originalExpiry = new Date(Date.now() + 1_500);
    const originalBinding = await saveTargetBinding(`expired-crash-${suffix}`, originalExpiry);
    const renewedBinding = await saveTargetBinding(
      `renewed-crash-${suffix}`,
      new Date(Date.now() + 30 * 60_000),
    );
    const caseId = `case-pg-expired-target-crash-${suffix}`;
    const compiled = compile(caseId);
    caseIds.add(caseId);
    await repository.createOrAdvanceAccountingCase({
      binding: originalBinding,
      compiled,
      compiledPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: createdAt,
    });
    const prepared = await prepareWholeCase(compiled, { binding: originalBinding });
    const requestId = `expired-target-crash-${suffix}`;
    await recordPreflight(compiled, prepared.operations, requestId, createdAt, originalBinding);
    await repository.claimAccountingCaseExecution({
      binding: originalBinding,
      caseId,
      version: compiled.version,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: createdAt,
    });
    const operation = compiled.operations[0]!;
    const { mutationRequestId, request } = await confirmMutation(prepared.preparations[0]!);
    expect(request.state).toBe("WRITE_IN_FLIGHT");
    const plainCaseId = `case-pg-expired-target-plain-${suffix}`;
    const plainCompiled = compile(plainCaseId);
    caseIds.add(plainCaseId);
    await repository.createOrAdvanceAccountingCase({
      binding: originalBinding,
      compiled: plainCompiled,
      compiledPlanHash: accountingCasePlanHash(originalBinding, plainCompiled),
      now: createdAt,
    });
    const plainPrepared = await prepareWholeCase(plainCompiled, { binding: originalBinding });
    const plainRequestId = `expired-target-plain-${suffix}`;
    await recordPreflight(plainCompiled, plainPrepared.operations, plainRequestId, createdAt, originalBinding);
    await repository.claimAccountingCaseExecution({
      binding: originalBinding,
      caseId: plainCaseId,
      version: plainCompiled.version,
      requestId: plainRequestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, plainCompiled),
      now: createdAt,
    });
    const before = await repository.getBoundAccountingCase({
      binding: originalBinding,
      caseId,
      version: compiled.version,
    });
    expect(before).toMatchObject({
      state: "EXECUTING",
      operations: expect.arrayContaining([
        expect.objectContaining({
          operation: expect.objectContaining({ operationId: operation.operationId }),
          state: "PREPARED",
        }),
      ]),
    });
    await waitUntilAfter(originalExpiry);

    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: renewedBinding,
      caseId,
      version: compiled.version,
      requestId: `${requestId}-wrong`,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: new Date(),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: { ...renewedBinding, tenantId: `${ids.tenant}-other` },
      caseId,
      version: compiled.version,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: new Date(),
    })).rejects.toMatchObject({ code: expect.stringMatching(/^(?:NOT_FOUND|TARGET_SESSION_EXPIRED)$/u) });
    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: {
        ...renewedBinding,
        targetSessionId: `missing-renewed-target-${suffix}`,
        targetSessionHash: hashObject({ suffix, kind: "missing-renewed-target" }),
      },
      caseId,
      version: compiled.version,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: new Date(),
    })).rejects.toMatchObject({ code: "TARGET_SESSION_EXPIRED" });
    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: renewedBinding,
      caseId: plainCaseId,
      version: plainCompiled.version,
      requestId: plainRequestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, plainCompiled),
      now: new Date(),
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reasonCodes: ["NO_POTENTIALLY_WRITTEN_MUTATION_REQUEST"] },
    });
    await expect(repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: renewedBinding,
      caseId,
      version: compiled.version,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: new Date(),
    })).resolves.toMatchObject({
      mode: "ADOPTED",
      record: {
        state: "RECOVERY_REQUIRED",
        executionRequestId: requestId,
        operations: expect.arrayContaining([
          expect.objectContaining({
            operation: expect.objectContaining({ operationId: operation.operationId }),
            state: "WRITE_IN_FLIGHT",
            mutationRequestId,
          }),
        ]),
      },
    });
  }, 10_000);

  it("atomically terminalizes expired-target residual work, reserves it, and consumes it only into a fresh successor", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const originalExpiry = new Date(Date.now() + 1_500);
    const originalBinding = await saveTargetBinding(`expired-residual-${suffix}`, originalExpiry);
    const renewedBinding = await saveTargetBinding(
      `renewed-residual-${suffix}`,
      new Date(Date.now() + 30 * 60_000),
    );
    const caseId = `case-pg-expired-residual-${suffix}`;
    const compiled = compileTwoInvoiceCase(caseId);
    caseIds.add(caseId);
    await repository.createOrAdvanceAccountingCase({
      binding: originalBinding,
      compiled,
      compiledPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: createdAt,
    });
    expect(compiled.operations).toHaveLength(2);
    const prepared = await prepareWholeCase(compiled, { binding: originalBinding });
    const requestId = `expired-residual-${suffix}`;
    await recordPreflight(compiled, prepared.operations, requestId, createdAt, originalBinding);
    await repository.claimAccountingCaseExecution({
      binding: originalBinding,
      caseId,
      version: 1,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: createdAt,
    });
    const firstOperation = compiled.operations[0]!;
    const residualOperation = compiled.operations[1]!;
    const firstPreparation = prepared.preparations[0]!;
    const residualPreparation = prepared.preparations[1]!;
    const { mutationRequestId } = await confirmMutation(firstPreparation);
    await waitUntilAfter(originalExpiry);
    await repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: renewedBinding,
      caseId,
      version: 1,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: new Date(),
    });

    const bound = boundMutationInput(firstPreparation, mutationRequestId);
    const xeroObjectId = `xero-recovered-${suffix}`;
    const writeReceipt = { providerRequestId: `provider-recovered-${suffix}` };
    await repository.recordXeroMutationWriteEvidence({ ...bound, xeroObjectId, writeReceipt });
    const readbackSnapshot = {
      xeroObjectId,
      status: XERO_MUTATION_EXPECTED_READBACK_STATUS[firstPreparation.objectType],
      canonicalPayload: firstPreparation.canonicalPayload,
      evidence: economicReadbackEvidence(firstOperation, xeroObjectId),
    };
    await repository.markXeroMutationReadbackVerified({
      ...bound,
      xeroObjectId,
      writeReceipt,
      readbackSnapshot,
      readbackSnapshotHash: hashObject(readbackSnapshot),
      readbackCanonicalPayload: firstPreparation.canonicalPayload,
      readbackPayloadHash: firstPreparation.canonicalPayloadHash,
      readbackStatus: XERO_MUTATION_EXPECTED_READBACK_STATUS[firstPreparation.objectType],
    });
    await repository.projectAccountingCaseOperationFromMutation({
      binding: renewedBinding,
      caseId,
      version: 1,
      operationId: firstOperation.operationId,
      requestId,
      expectedStates: ["WRITE_IN_FLIGHT"],
      desiredState: "READBACK_VERIFIED",
      mutationRequestId,
      accessMode: "RECOVERY_GET_ONLY",
      now: new Date(),
    });

    const successorCaseId = `recovery-${hashObject({ caseId, requestId, kind: "successor" })}`;
    const grantId = `acrg_${hashObject({ caseId, requestId, kind: "grant" })}`;
    const template = accountingCaseRecoveryResidualContinuationTemplate({
      source: compiled,
      successorCaseId,
      residualOperationIds: [residualOperation.operationId],
    });
    const templateHash = accountingCaseContinuationTemplateHash(template);
    retainsAppendOnlyRecoveryGrant = true;
    const completed = await repository.completeExpiredTargetAccountingCaseRecovery({
      currentAccessBinding: renewedBinding,
      caseId,
      version: 1,
      requestId,
      continuation: { grantId, successorCaseId, template, templateHash },
      reasonReceipt: { receiptType: "TEST_EXPIRED_TARGET_RECOVERY_COMPLETED" },
      now: new Date(),
    });
    expect(completed).toMatchObject({
      state: "TERMINAL",
      operations: [
        expect.objectContaining({ state: "READBACK_VERIFIED" }),
        expect.objectContaining({
          operation: expect.objectContaining({ operationId: residualOperation.operationId }),
          state: "NOT_EXECUTED_AFTER_TARGET_EXPIRY",
        }),
      ],
      recoveryResidualGrant: {
        grantId,
        state: "ISSUED",
        successorCaseId,
      },
    });
    expect(completed.operations[1]?.mutationRequestId).toBeUndefined();
    await expect(repository.getXeroMutationPreparation(residualPreparation.preparationId))
      .resolves.toMatchObject({ state: "EXPIRED" });

    await expect(repository.getAccessibleAccountingCase({
      currentAccessBinding: renewedBinding,
      caseId,
      version: 1,
      mode: "STATUS",
      now: new Date(),
    })).resolves.toMatchObject({
      recoveryResidualGrant: { grantId, successorCaseId },
    });
    const otherBinding = await saveTargetBinding(
      `other-residual-${suffix}`,
      new Date(Date.now() + 20 * 60_000),
    );
    await expect(repository.getAccountingCaseRecoveryResidualGrant({
      currentAccessBinding: otherBinding,
      successorCaseId,
      now: new Date(),
    })).resolves.toBeUndefined();

    const successor = compileResidualSuccessor(compiled, successorCaseId, residualOperation.operationId);
    const authorization = {
      grantId,
      sourceCaseId: caseId,
      sourceVersion: 1,
      successorCaseId,
      templateHash,
    };
    await expect(repository.createOrAdvanceAccountingCase({
      binding: otherBinding,
      compiled: successor,
      compiledPlanHash: accountingCasePlanHash(otherBinding, successor),
      recoveryResidualAuthorization: authorization,
      now: new Date(),
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const unrelatedCaseId = `case-pg-expired-residual-unrelated-${suffix}`;
    const unrelated = compileResidualSuccessor(compiled, unrelatedCaseId, residualOperation.operationId);
    caseIds.add(unrelatedCaseId);
    await expect(repository.createOrAdvanceAccountingCase({
      binding: renewedBinding,
      compiled: unrelated,
      compiledPlanHash: accountingCasePlanHash(renewedBinding, unrelated),
      now: new Date(),
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reasonCodes: ["ACCOUNTING_CASE_BUSINESS_COORDINATE_ALREADY_RESERVED"],
        providerMutationPossible: false,
      },
    });
    await expect(repository.getBoundAccountingCase({
      binding: renewedBinding,
      caseId: unrelatedCaseId,
      version: 1,
    })).resolves.toBeUndefined();

    caseIds.add(successorCaseId);
    const createdSuccessor = await repository.createOrAdvanceAccountingCase({
      binding: renewedBinding,
      compiled: successor,
      compiledPlanHash: accountingCasePlanHash(renewedBinding, successor),
      recoveryResidualAuthorization: authorization,
      now: new Date(),
    });
    expect(createdSuccessor).toMatchObject({ mode: "CREATED", record: { state: "PLANNED_NEEDS_PREFLIGHT" } });
    await expect(repository.createOrAdvanceAccountingCase({
      binding: renewedBinding,
      compiled: successor,
      compiledPlanHash: accountingCasePlanHash(renewedBinding, successor),
      recoveryResidualAuthorization: authorization,
      now: new Date(),
    })).resolves.toMatchObject({ mode: "IDEMPOTENT_REPLAY" });
    const successorPrepared = await prepareWholeCase(successor, { binding: renewedBinding });
    expect(successorPrepared.preparations[0]?.preparationId).not.toBe(residualPreparation.preparationId);
    await expect(recordPreflight(
      successor,
      successorPrepared.operations,
      `successor-residual-${suffix}`,
      new Date(),
      renewedBinding,
    )).resolves.toMatchObject({ mode: "PREFLIGHTED", record: { state: "PREFLIGHTED" } });
    await expect(repository.getAccountingCaseRecoveryResidualGrant({
      currentAccessBinding: renewedBinding,
      successorCaseId,
      now: new Date(),
    })).resolves.toMatchObject({ grant: { state: "CONSUMED" } });
  }, 12_000);

  it("keeps an expired target referenced by an unconsumed residual grant while cleaning an unrelated target", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const originalExpiry = new Date(Date.now() + 700);
    const successorExpiry = new Date(Date.now() + 4_000);
    const originalBinding = await saveTargetBinding(`cleanup-original-${suffix}`, originalExpiry);
    const successorBinding = await saveTargetBinding(`cleanup-successor-${suffix}`, successorExpiry);
    const unrelatedBinding = await saveTargetBinding(`cleanup-unrelated-${suffix}`, successorExpiry);
    const caseId = `case-pg-expired-residual-cleanup-${suffix}`;
    const compiled = compileTwoInvoiceCase(caseId);
    caseIds.add(caseId);
    await repository.createOrAdvanceAccountingCase({
      binding: originalBinding,
      compiled,
      compiledPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: createdAt,
    });
    const prepared = await prepareWholeCase(compiled, { binding: originalBinding });
    const requestId = `expired-residual-cleanup-${suffix}`;
    await recordPreflight(compiled, prepared.operations, requestId, createdAt, originalBinding);
    await repository.claimAccountingCaseExecution({
      binding: originalBinding,
      caseId,
      version: 1,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: createdAt,
    });
    const writtenOperation = compiled.operations[0]!;
    const residualOperation = compiled.operations[1]!;
    const writtenPreparation = prepared.preparations[0]!;
    const { mutationRequestId } = await confirmMutation(writtenPreparation);
    await waitUntilAfter(originalExpiry);
    await repository.adoptExpiredExecutingAccountingCaseForRecovery({
      currentAccessBinding: successorBinding,
      caseId,
      version: 1,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: new Date(),
    });

    const bound = boundMutationInput(writtenPreparation, mutationRequestId);
    const xeroObjectId = `xero-cleanup-recovered-${suffix}`;
    const writeReceipt = { providerRequestId: `provider-cleanup-recovered-${suffix}` };
    await repository.recordXeroMutationWriteEvidence({ ...bound, xeroObjectId, writeReceipt });
    const readbackSnapshot = {
      xeroObjectId,
      status: XERO_MUTATION_EXPECTED_READBACK_STATUS[writtenPreparation.objectType],
      canonicalPayload: writtenPreparation.canonicalPayload,
      evidence: economicReadbackEvidence(writtenOperation, xeroObjectId),
    };
    await repository.markXeroMutationReadbackVerified({
      ...bound,
      xeroObjectId,
      writeReceipt,
      readbackSnapshot,
      readbackSnapshotHash: hashObject(readbackSnapshot),
      readbackCanonicalPayload: writtenPreparation.canonicalPayload,
      readbackPayloadHash: writtenPreparation.canonicalPayloadHash,
      readbackStatus: XERO_MUTATION_EXPECTED_READBACK_STATUS[writtenPreparation.objectType],
    });
    await repository.projectAccountingCaseOperationFromMutation({
      binding: successorBinding,
      caseId,
      version: 1,
      operationId: writtenOperation.operationId,
      requestId,
      expectedStates: ["WRITE_IN_FLIGHT"],
      desiredState: "READBACK_VERIFIED",
      mutationRequestId,
      accessMode: "RECOVERY_GET_ONLY",
      now: new Date(),
    });

    const successorCaseId = `recovery-${hashObject({ caseId, requestId, kind: "cleanup-successor" })}`;
    const grantId = `acrg_${hashObject({ caseId, requestId, kind: "cleanup-grant" })}`;
    const template = accountingCaseRecoveryResidualContinuationTemplate({
      source: compiled,
      successorCaseId,
      residualOperationIds: [residualOperation.operationId],
    });
    retainsAppendOnlyRecoveryGrant = true;
    await repository.completeExpiredTargetAccountingCaseRecovery({
      currentAccessBinding: successorBinding,
      caseId,
      version: 1,
      requestId,
      continuation: {
        grantId,
        successorCaseId,
        template,
        templateHash: accountingCaseContinuationTemplateHash(template),
      },
      reasonReceipt: { receiptType: "TEST_EXPIRED_TARGET_RECOVERY_CLEANUP" },
      now: new Date(),
    });
    await expect(repository.revokeLedgerTargetSession(
      successorBinding.targetSessionHash,
      successorBinding.installationId,
      new Date(),
    )).resolves.toBe(true);

    await waitUntilAfter(successorExpiry);
    const cleanup = await repository.cleanupExpiredEphemeral(new Date(), 1_000);
    expect(cleanup.lockAcquired).toBe(true);
    expect(cleanup.deleted.ledgerTargetSessions).toBeGreaterThanOrEqual(1);
    const targets = await repository.pool.query<{ session_hash: string }>(
      `SELECT session_hash FROM ledger_target_sessions
       WHERE session_hash = ANY($1::text[])
       ORDER BY session_hash`,
      [[
        originalBinding.targetSessionHash,
        successorBinding.targetSessionHash,
        unrelatedBinding.targetSessionHash,
      ]],
    );
    expect(targets.rows.map((row) => row.session_hash)).toEqual([
      originalBinding.targetSessionHash,
      successorBinding.targetSessionHash,
    ].sort());
    await expect(repository.pool.query(
      `SELECT state FROM accounting_case_recovery_residual_grants
       WHERE grant_id = $1 AND state = 'ISSUED'`,
      [grantId],
    )).resolves.toMatchObject({ rowCount: 1 });
  }, 15_000);

  it("serializes an old-worker projection against expired-target adoption so only one CAS wins", async () => {
    if (!repository || !databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    const originalExpiry = new Date(Date.now() + 1_500);
    const originalBinding = await saveTargetBinding(`expired-race-${suffix}`, originalExpiry);
    const renewedBinding = await saveTargetBinding(
      `renewed-race-${suffix}`,
      new Date(Date.now() + 30 * 60_000),
    );
    const caseId = `case-pg-expired-target-race-${suffix}`;
    const compiled = compile(caseId);
    caseIds.add(caseId);
    await repository.createOrAdvanceAccountingCase({
      binding: originalBinding,
      compiled,
      compiledPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: createdAt,
    });
    const prepared = await prepareWholeCase(compiled, { binding: originalBinding });
    const requestId = `expired-target-race-${suffix}`;
    await recordPreflight(compiled, prepared.operations, requestId, createdAt, originalBinding);
    await repository.claimAccountingCaseExecution({
      binding: originalBinding,
      caseId,
      version: compiled.version,
      requestId,
      expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
      now: createdAt,
    });
    const operation = compiled.operations[0]!;
    const { mutationRequestId } = await confirmMutation(prepared.preparations[0]!);
    await waitUntilAfter(originalExpiry);

    const oldWorkerRepository = new PostgresAccountingRepository(databaseUrl);
    const adopterRepository = new PostgresAccountingRepository(databaseUrl);
    try {
      const outcomes = await Promise.allSettled([
        oldWorkerRepository.projectAccountingCaseOperationFromMutation({
          binding: originalBinding,
          caseId,
          version: compiled.version,
          operationId: operation.operationId,
          requestId,
          expectedStates: ["PREPARED"],
          desiredState: "WRITE_IN_FLIGHT",
          mutationRequestId,
          now: new Date(),
        }),
        adopterRepository.adoptExpiredExecutingAccountingCaseForRecovery({
          currentAccessBinding: renewedBinding,
          caseId,
          version: compiled.version,
          requestId,
          expectedPlanHash: accountingCasePlanHash(originalBinding, compiled),
          now: new Date(),
        }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    } finally {
      await Promise.all([oldWorkerRepository.close(), adopterRepository.close()]);
    }

    await expect(repository.getAccessibleAccountingCase({
      currentAccessBinding: renewedBinding,
      caseId,
      version: compiled.version,
      mode: "STATUS",
      now: new Date(),
    })).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      operations: expect.arrayContaining([
        expect.objectContaining({
          operation: expect.objectContaining({ operationId: operation.operationId }),
          state: "WRITE_IN_FLIGHT",
          mutationRequestId,
        }),
      ]),
    });
  }, 10_000);

  it("fails release readiness for only current active legacy recovery projections and recovers after terminal", async () => {
    if (!repository) throw new Error("TEST_DATABASE_URL is required");
    const caseId = `case-pg-release-readiness-${suffix}`;
    const plannedCaseId = `case-pg-release-readiness-planned-${suffix}`;
    const malformedCaseId = `case-pg-release-readiness-malformed-${suffix}`;
    const legacyPolicy = "xero-sg-accounting-policy-projection:v3";
    const legacyProvider = "xero-accounting-case-provider-projection:v4";

    const mutateCurrentFixture = async (
      targetCaseId: string,
      options: {
        state?: "RECOVERY_REQUIRED" | "TERMINAL";
        malformed?: boolean;
        terminalSummary?: Record<string, unknown>;
      },
    ) => {
      const client = await repository.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        const selected = await client.query<{ compiled_case: CompiledAccountingCase }>(
          `SELECT compiled_case
           FROM accounting_case_versions
           WHERE case_id = $1
             AND version = (SELECT current_version FROM accounting_cases WHERE case_id = $1)
           FOR UPDATE`,
          [targetCaseId],
        );
        const candidate = structuredClone(selected.rows[0]?.compiled_case);
        if (!candidate) throw new Error("release readiness fixture Case is missing");
        (candidate.policyProjection as Record<string, unknown>).schemaVersion =
          options.malformed ? 7 : legacyPolicy;
        (candidate.providerProjection as Record<string, unknown>).schemaVersion =
          options.malformed ? false : legacyProvider;
        const updated = await client.query(
          `UPDATE accounting_case_versions
           SET compiled_case = $2::jsonb,
               compiled_plan_hash = $3,
               state = COALESCE($4::text, state),
               terminal_summary = CASE
                 WHEN $4::text IS NULL THEN terminal_summary
                 ELSE $5::jsonb
               END,
               updated_at = statement_timestamp()
           WHERE case_id = $1
             AND version = (SELECT current_version FROM accounting_cases WHERE case_id = $1)
           RETURNING version`,
          [
            targetCaseId,
            candidate,
            accountingCasePlanHash(binding, candidate),
            options.state ?? null,
            options.terminalSummary ?? { fixture: options.state ?? "UNCHANGED" },
          ],
        );
        expect(updated.rowCount).toBe(1);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };

    await createContactCase(
      plannedCaseId,
      `READINESS-PLANNED-${suffix}`,
      binding,
    );
    await mutateCurrentFixture(plannedCaseId, {});
    const plannedEvidence = await repository.readinessEvidence(XERO_RELEASE_ATTESTATION.requiredMigration);
    expect(plannedEvidence).toMatchObject({
      ready: true,
      activeAccountingCaseRecoveryProjection: { status: "COMPATIBLE" },
    });
    const baselineActiveCount = plannedEvidence.activeAccountingCaseRecoveryProjection.activeCaseCount;
    if (baselineActiveCount === null) throw new Error("baseline recovery evidence is unknown");

    const compiledV1 = await createContactCase(
      caseId,
      `READINESS-${suffix}`,
      binding,
    );
    const activePrepared = await prepareWholeCase(compiledV1);
    const activeRequestId = `release-readiness-${suffix}`;
    await recordPreflight(compiledV1, activePrepared.operations, activeRequestId);
    await repository.claimAccountingCaseExecution({
      binding,
      caseId,
      version: compiledV1.version,
      requestId: activeRequestId,
      expectedPlanHash: accountingCasePlanHash(binding, compiledV1),
      now: createdAt,
    });
    for (const operation of compiledV1.operations) {
      await repository.updateAccountingCaseOperation({
        binding,
        caseId,
        version: compiledV1.version,
        operationId: operation.operationId,
        requestId: activeRequestId,
        expectedStates: ["PREPARED"],
        state: "BLOCKED_VALIDATION",
        errorReceipt: { receiptType: "TEST_DEFINITE_NO_WRITE" },
        now: createdAt,
      });
    }
    const terminalBase = await repository.getBoundAccountingCase({
      binding,
      caseId,
      version: compiledV1.version,
    });
    if (!terminalBase) throw new Error("release readiness terminal fixture is missing");
    await mutateCurrentFixture(caseId, { state: "RECOVERY_REQUIRED" });
    const activeEvidence = await repository.readinessEvidence(XERO_RELEASE_ATTESTATION.requiredMigration);
    expect(activeEvidence).toMatchObject({
      ready: false,
      requiredMigrationStatus: "APPLIED",
      activeAccountingCaseRecoveryProjection: {
        status: "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION",
        activeCaseCount: baselineActiveCount + 1,
        storedPolicyProjectionVersions: expect.arrayContaining([legacyPolicy]),
        storedProviderProjectionVersions: expect.arrayContaining([legacyProvider]),
      },
    });
    expect(JSON.stringify(activeEvidence)).not.toContain(caseId);

    await mutateCurrentFixture(caseId, {
      state: "TERMINAL",
      terminalSummary: accountingCaseTerminalSummary(terminalBase, "TERMINAL"),
    });
    await expect(repository.readinessEvidence(XERO_RELEASE_ATTESTATION.requiredMigration)).resolves.toMatchObject({
      ready: true,
      activeAccountingCaseRecoveryProjection: {
        status: "COMPATIBLE",
        activeCaseCount: baselineActiveCount,
      },
    });

    const restoreClient = await repository.pool.connect();
    try {
      await restoreClient.query("BEGIN");
      await restoreClient.query("SET LOCAL session_replication_role = replica");
      await restoreClient.query(
        `UPDATE accounting_case_versions
         SET compiled_case = $3::jsonb, compiled_plan_hash = $4
         WHERE case_id = $1 AND version = $2`,
        [caseId, compiledV1.version, compiledV1, accountingCasePlanHash(binding, compiledV1)],
      );
      await restoreClient.query("COMMIT");
    } catch (error) {
      await restoreClient.query("ROLLBACK");
      throw error;
    } finally {
      restoreClient.release();
    }
    const compiledV2 = compileAccountingCase({
      ...contactOnlyInput({
        caseId,
        jurisdiction: "SG",
        registryScheme: "ACRA",
        number: `READINESS-${suffix}`,
      }),
      expectedVersion: 1,
    });
    await repository.createOrAdvanceAccountingCase({
      binding,
      compiled: compiledV2,
      compiledPlanHash: accountingCasePlanHash(binding, compiledV2),
      now: createdAt,
    });
    const nonCurrentClient = await repository.pool.connect();
    try {
      await nonCurrentClient.query("BEGIN");
      await nonCurrentClient.query("SET LOCAL session_replication_role = replica");
      const nonCurrentLegacy = structuredClone(compiledV1);
      (nonCurrentLegacy.policyProjection as Record<string, unknown>).schemaVersion = legacyPolicy;
      (nonCurrentLegacy.providerProjection as Record<string, unknown>).schemaVersion = legacyProvider;
      await nonCurrentClient.query(
        `UPDATE accounting_case_versions
         SET compiled_case = $2::jsonb,
             compiled_plan_hash = $3,
             state = 'RECOVERY_REQUIRED',
             terminal_summary = '{"fixture":"non-current"}'::jsonb
         WHERE case_id = $1 AND version = 1`,
        [caseId, nonCurrentLegacy, accountingCasePlanHash(binding, nonCurrentLegacy)],
      );
      await nonCurrentClient.query("COMMIT");
    } catch (error) {
      await nonCurrentClient.query("ROLLBACK");
      throw error;
    } finally {
      nonCurrentClient.release();
    }
    await expect(repository.readinessEvidence(XERO_RELEASE_ATTESTATION.requiredMigration)).resolves.toMatchObject({
      ready: true,
      activeAccountingCaseRecoveryProjection: {
        status: "COMPATIBLE",
        activeCaseCount: baselineActiveCount,
      },
    });

    const malformed = await createContactCase(
      malformedCaseId,
      `M-${suffix}`,
      binding,
    );
    const malformedPrepared = await prepareWholeCase(malformed);
    const malformedRequestId = `release-readiness-malformed-${suffix}`;
    await recordPreflight(malformed, malformedPrepared.operations, malformedRequestId);
    await repository.claimAccountingCaseExecution({
      binding,
      caseId: malformedCaseId,
      version: malformed.version,
      requestId: malformedRequestId,
      expectedPlanHash: accountingCasePlanHash(binding, malformed),
      now: createdAt,
    });
    await mutateCurrentFixture(malformedCaseId, { state: "RECOVERY_REQUIRED", malformed: true });
    await expect(repository.readinessEvidence(XERO_RELEASE_ATTESTATION.requiredMigration)).resolves.toMatchObject({
      ready: false,
      activeAccountingCaseRecoveryProjection: {
        status: "UNKNOWN",
        activeCaseCount: null,
        storedPolicyProjectionVersions: [],
        storedProviderProjectionVersions: [],
      },
    });
    await mutateCurrentFixture(malformedCaseId, { state: "TERMINAL", malformed: true });
  }, 10_000);
});
