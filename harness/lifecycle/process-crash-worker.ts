/**
 * Child process for the real PostgreSQL Accounting Case crash/restart harness.
 *
 * The parent deliberately SIGKILLs this process at one reviewed lifecycle
 * boundary.  A second OS process then loads the same PostgreSQL records and
 * executes the same identity-only Accounting Case command.  The only fake is
 * the provider SDK boundary; its object ledger and call log are PostgreSQL
 * tables, so provider acceptance survives process death.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runMigrations } from "../../src/db/migrate.js";
import { PostgresAccountingRepository } from "../../src/db/postgresRepository.js";
import { RepositoryLedgerAuthoritySnapshotResolver } from "../../src/domain/ledgerAuthority.js";
import type { PrepareAccountingCasePublicInput } from "../../src/domain/accountingCaseSchemas.js";
import {
  normalizeXeroAccountingCaseBusinessIntake,
  xeroAccountingCaseBusinessIntakeSchema,
} from "../../src/mcp/xeroAccountingCaseBusinessIntake.js";
import type {
  AccountingProvider,
  AccountSummary,
  ContactSummary,
  SalesInvoiceSnapshot,
  TaxRateSummary,
} from "../../src/providers/types.js";
import { hashObject } from "../../src/security/hash.js";
import { consumeXeroProviderWritePermitAtMutationBoundary } from "../../src/security/xeroProviderWritePermitContext.js";
import { createOAuthRequestContext, type RequestContext } from "../../src/security/requestContext.js";
import type { Logger } from "../../src/logging.js";
import type { AccountingRepository } from "../../src/db/repository.js";
import { AccountingService } from "../../src/services/accountingService.js";
import { ConnectionTicketService } from "../../src/services/connectionTicketService.js";
import { XeroAccountingCaseService } from "../../src/services/xeroAccountingCaseService.js";
import { XeroMutationService } from "../../src/services/xeroMutationService.js";
import { XERO_RELEASE_ATTESTATION, XERO_RELEASE_VERSION } from "../../src/xeroRelease.js";
import {
  parseXeroAccountingCaseBusinessAuthorityProfiles,
} from "../../src/policy/xeroBusinessCoordinateAuthority.js";
import { testXeroAccounts } from "../../tests/helpers/xeroTenantCoaProfile.js";

const REQUIRED_SCENARIOS = [
  "AFTER_PREFLIGHT_PREPARED",
  "AFTER_WRITE_CLAIM_BEFORE_PROVIDER",
  "AFTER_PROVIDER_ACCEPT_BEFORE_DURABLE_COMPLETION",
  "AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE",
] as const;
const PROCESS_CRASH_CONTINUATION_SECRET = Buffer.from(
  "process-crash-continuation-secret-v1",
  "utf8",
);

type ScenarioId = typeof REQUIRED_SCENARIOS[number];
type Phase = "initial" | "restart";

interface RuntimeMetadata {
  schema_version: "1.0";
  run_id: string;
  scenario_id: ScenarioId;
  tenant_id: string;
  contact_id: string;
  account_id: string;
  invoice_id: string;
  case_id: string;
  workspace_id: string;
  subject_id: string;
  agent_id: string;
  installation_id: string;
  binding_id: string;
  connection_id: string;
  authorization_id: string;
  target_session_id: string;
  target_session_hash: string;
  execution_request_id: string;
  anchor_at: string;
  target_expires_at: string;
}

interface Arguments {
  scenario: ScenarioId;
  phase: Phase;
  metadataPath: string;
}

function parseArguments(argv: string[]): Arguments {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const scenario = value("--scenario");
  const phase = value("--phase");
  const metadataPath = value("--metadata");
  if (!REQUIRED_SCENARIOS.includes(scenario as ScenarioId)) throw new Error("CRASH_SCENARIO_INVALID");
  if (phase !== "initial" && phase !== "restart") throw new Error("CRASH_PHASE_INVALID");
  if (!metadataPath) throw new Error("CRASH_METADATA_REQUIRED");
  return { scenario: scenario as ScenarioId, phase, metadataPath };
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({
    schema_version: "1.0",
    captured_at: new Date().toISOString(),
    pid: process.pid,
    ...event,
  })}\n`);
}

async function crashWindow(scenario: ScenarioId, details: Record<string, unknown>): Promise<never> {
  emit({ event: "CRASH_WINDOW_REACHED", scenario_id: scenario, ...details });
  // The parent must prove an external SIGKILL.  Self-exit or exception would
  // not be acceptable evidence, so deliberately remain alive forever.
  return new Promise<never>(() => undefined);
}

function assertMetadata(value: unknown, expectedScenario: ScenarioId): RuntimeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CRASH_METADATA_INVALID");
  const metadata = value as RuntimeMetadata;
  if (metadata.schema_version !== "1.0" || metadata.scenario_id !== expectedScenario) {
    throw new Error("CRASH_METADATA_INVALID");
  }
  return metadata;
}

function requestContext(metadata: RuntimeMetadata): RequestContext {
  const anchor = new Date(metadata.anchor_at);
  const expiresAt = new Date(metadata.target_expires_at);
  const base = createOAuthRequestContext({
    issuer: "https://xero-mcp.process-crash.invalid",
    resolvedToken: {
      tokenId: `token-${metadata.run_id}`,
      clientId: `client-${metadata.run_id}`,
      resource: "https://xero-mcp.process-crash.invalid/mcp",
      audience: "https://xero-mcp.process-crash.invalid/mcp",
      grantedScopes: ["xero.read", "xero.draft.write"],
      issuedAt: new Date(anchor.getTime() - 60_000),
      expiresAt,
      installationId: metadata.installation_id,
      bindingId: metadata.binding_id,
      bindingRevision: 1,
      workspaceId: metadata.workspace_id,
      subjectType: "USER",
      subjectId: metadata.subject_id,
      agentId: metadata.agent_id,
      connectionId: metadata.connection_id,
      authorizationId: metadata.authorization_id,
      tenantId: metadata.tenant_id,
      policyId: `policy-${metadata.run_id}`,
    },
  });
  return Object.freeze({
    ...base,
    targetSessionId: metadata.target_session_id,
    targetSessionHash: metadata.target_session_hash,
    targetSessionExpiresAt: expiresAt,
  });
}

function fixedFour(value: number): string {
  return value.toFixed(4);
}

class DurableSyntheticXeroProvider implements AccountingProvider {
  readonly #contact: ContactSummary;
  readonly #accounts: readonly AccountSummary[];
  readonly #taxRate: TaxRateSummary;

  constructor(
    private readonly repository: PostgresAccountingRepository,
    private readonly metadata: RuntimeMetadata,
    private readonly scenario: ScenarioId,
    private readonly phase: Phase,
  ) {
    this.#contact = Object.freeze({
      contactId: metadata.contact_id,
      name: "Exact Customer",
      status: "ACTIVE",
      isCustomer: true,
    });
    this.#accounts = Object.freeze(testXeroAccounts()
      .map((account) => Object.freeze({ ...account })));
    this.#taxRate = Object.freeze({
      taxType: "OUTPUTY24",
      name: "GST on Income",
      status: "ACTIVE",
      displayTaxRate: "9.0000",
      effectiveRate: "9.0000",
      canApplyToRevenue: true,
    });
  }

  readonly connectionStatus: AccountingProvider["connectionStatus"] = async () => ({
    connected: true,
    tenant: { id: this.metadata.tenant_id, name: "Crash Harness Company" },
    scopes: ["xero.read", "xero.draft.write"],
    tokenExpiresAt: this.metadata.target_expires_at,
  });

  readonly resolveContext: AccountingProvider["resolveContext"] = async (principal) => ({
    actorId: typeof principal === "string" ? principal : principal.actorId,
    tenantId: this.metadata.tenant_id,
    tenantName: "Crash Harness Company",
  });

  readonly getOrganisation: AccountingProvider["getOrganisation"] = async () => ({
    organisationId: this.metadata.tenant_id,
    name: "Crash Harness Company",
    countryCode: "SG",
    baseCurrency: "SGD",
    paysTax: true,
    organisationStatus: "ACTIVE",
  });

  readonly listAccounts: AccountingProvider["listAccounts"] = async () => structuredClone(this.#accounts);
  readonly listTaxRates: AccountingProvider["listTaxRates"] = async () => [structuredClone(this.#taxRate)];
  readonly listContacts: AccountingProvider["listContacts"] = async () => ({
    contacts: [structuredClone(this.#contact)],
    pagination: this.#singlePage(1),
  });
  readonly searchContacts: AccountingProvider["searchContacts"] = async (_principal, query) => {
    const normalized = query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
    const expected = this.#contact.name!.toLocaleLowerCase("en");
    const contacts = normalized === expected ? [structuredClone(this.#contact)] : [];
    return { contacts, pagination: this.#singlePage(contacts.length) };
  };
  readonly getSupplierBillDraftReferenceData: AccountingProvider["getSupplierBillDraftReferenceData"] = async () => ({
    tenant: { id: this.metadata.tenant_id, name: "Crash Harness Company" },
    contacts: [structuredClone(this.#contact)],
    contactsComplete: true,
    accounts: structuredClone(this.#accounts),
    taxRates: [structuredClone(this.#taxRate)],
  });
  readonly getContact: AccountingProvider["getContact"] = async (_principal, contactId) =>
    contactId === this.metadata.contact_id ? structuredClone(this.#contact) : undefined;

  readonly createDraftSalesInvoice: AccountingProvider["createDraftSalesInvoice"] = async (
    principal,
    input,
    idempotencyKey,
    recordWriteEvidence,
    providerWritePermit,
    mutationRequestId,
  ) => {
    const request = mutationRequestId
      ? await this.repository.getXeroMutationRequest(mutationRequestId)
      : undefined;
    if (this.phase === "initial" && this.scenario === "AFTER_WRITE_CLAIM_BEFORE_PROVIDER") {
      await crashWindow(this.scenario, {
        mutation_request_id: mutationRequestId ?? null,
        mutation_state: request?.state ?? null,
        provider_create_attempted: false,
      });
    }

    const serverOwnedCompatibilityField = ["user", "confirmation"].join("_");
    const canonicalPayload = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== serverOwnedCompatibilityField),
    );
    consumeXeroProviderWritePermitAtMutationBoundary({
      permit: providerWritePermit,
      principal: principal as RequestContext,
      connection: {
        connectionId: this.metadata.connection_id,
        tenantId: this.metadata.tenant_id,
      } as never,
      adapterOperation: "XeroAccountingProvider.createDraftSalesInvoice",
      actionId: "customer_invoice.create_draft",
      mutationRequestId: mutationRequestId ?? "",
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload,
    });

    const invoice = this.#invoice(input);
    const receipt = {
      operation: "CREATE_ACCREC_DRAFT",
      invoiceId: this.metadata.invoice_id,
      providerRequestId: `provider-${this.metadata.run_id}`,
      tenantId: this.metadata.tenant_id,
      idempotencyKey,
    };
    await this.repository.pool.query(
      `INSERT INTO crash_harness_provider_events(run_id, process_pid, operation, object_id, details)
       VALUES ($1,$2,'CREATE_ATTEMPT',$3,$4::jsonb)`,
      [this.metadata.run_id, process.pid, this.metadata.invoice_id, JSON.stringify({ idempotencyKey })],
    );
    const inserted = await this.repository.pool.query(
      `INSERT INTO crash_harness_provider_ledger(run_id, idempotency_key, object_id, document, receipt)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
       ON CONFLICT (run_id, idempotency_key) DO NOTHING
       RETURNING object_id`,
      [this.metadata.run_id, idempotencyKey, this.metadata.invoice_id, JSON.stringify(invoice), JSON.stringify(receipt)],
    );
    if (inserted.rowCount !== 1) {
      throw new Error("CRASH_HARNESS_PROVIDER_CREATE_REPLAYED");
    }
    await this.repository.pool.query(
      `INSERT INTO crash_harness_provider_events(run_id, process_pid, operation, object_id, details)
       VALUES ($1,$2,'CREATE_ACCEPTED',$3,$4::jsonb)`,
      [this.metadata.run_id, process.pid, this.metadata.invoice_id, JSON.stringify({ providerRequestId: receipt.providerRequestId })],
    );
    await recordWriteEvidence?.({ invoiceId: this.metadata.invoice_id, receipt });

    if (this.phase === "initial" && this.scenario === "AFTER_PROVIDER_ACCEPT_BEFORE_DURABLE_COMPLETION") {
      const posting = await this.repository.pool.query<{ state: string; xero_invoice_id: string | null }>(
        `SELECT state, xero_invoice_id FROM posting_requests
         WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [this.metadata.tenant_id],
      );
      await crashWindow(this.scenario, {
        mutation_request_id: mutationRequestId ?? null,
        mutation_state: request?.state ?? null,
        provider_object_id: this.metadata.invoice_id,
        partial_write_evidence_state: posting.rows[0]?.state ?? null,
        partial_write_evidence_object_id: posting.rows[0]?.xero_invoice_id ?? null,
      });
    }

    const exactReadback = await this.getInvoice(principal, this.metadata.invoice_id, "ACCREC") as SalesInvoiceSnapshot;
    return { invoice: exactReadback, receipt };
  };

  readonly getInvoice: AccountingProvider["getInvoice"] = async (_principal, invoiceId, expectedType) => {
    await this.repository.pool.query(
      `INSERT INTO crash_harness_provider_events(run_id, process_pid, operation, object_id, details)
       VALUES ($1,$2,'GET',$3,$4::jsonb)`,
      [this.metadata.run_id, process.pid, invoiceId, JSON.stringify({ expectedType: expectedType ?? null })],
    );
    const found = await this.repository.pool.query<{ document: SalesInvoiceSnapshot }>(
      `SELECT document FROM crash_harness_provider_ledger WHERE run_id = $1 AND object_id = $2`,
      [this.metadata.run_id, invoiceId],
    );
    const invoice = found.rows[0]?.document;
    if (!invoice || invoice.type !== "ACCREC" || (expectedType && expectedType !== "ACCREC")) {
      throw new Error("CRASH_HARNESS_PROVIDER_OBJECT_NOT_FOUND");
    }
    return structuredClone(invoice);
  };

  readonly listInvoices: AccountingProvider["listInvoices"] = async () => {
    const found = await this.repository.pool.query<{ document: SalesInvoiceSnapshot }>(
      `SELECT document FROM crash_harness_provider_ledger WHERE run_id = $1 ORDER BY object_id`,
      [this.metadata.run_id],
    );
    const invoices = found.rows.map((row) => structuredClone(row.document));
    return { invoices, pagination: this.#singlePage(invoices.length) };
  };
  readonly listCreditNotes: AccountingProvider["listCreditNotes"] = async () => this.#unexpected("listCreditNotes");
  readonly getCreditNote: AccountingProvider["getCreditNote"] = async () => this.#unexpected("getCreditNote");
  readonly listPayments: AccountingProvider["listPayments"] = async () => this.#unexpected("listPayments");
  readonly listQuotes: AccountingProvider["listQuotes"] = async () => this.#unexpected("listQuotes");
  readonly getQuote: AccountingProvider["getQuote"] = async () => this.#unexpected("getQuote");
  readonly listPurchaseOrders: AccountingProvider["listPurchaseOrders"] = async () => this.#unexpected("listPurchaseOrders");
  readonly getPurchaseOrder: AccountingProvider["getPurchaseOrder"] = async () => this.#unexpected("getPurchaseOrder");
  readonly listManualJournals: AccountingProvider["listManualJournals"] = async () => this.#unexpected("listManualJournals");
  readonly getManualJournal: AccountingProvider["getManualJournal"] = async () => this.#unexpected("getManualJournal");
  readonly listItems: AccountingProvider["listItems"] = async () => this.#unexpected("listItems");
  readonly getItem: AccountingProvider["getItem"] = async () => this.#unexpected("getItem");
  readonly listBankTransactions: AccountingProvider["listBankTransactions"] = async () => this.#unexpected("listBankTransactions");
  readonly getBankTransaction: AccountingProvider["getBankTransaction"] = async () => this.#unexpected("getBankTransaction");
  readonly getSupplierBill: AccountingProvider["getSupplierBill"] = async () => this.#unexpected("getSupplierBill");
  readonly createDraftSupplierBill: AccountingProvider["createDraftSupplierBill"] = async () =>
    this.#unexpected("createDraftSupplierBill");
  readonly getTrialBalance: AccountingProvider["getTrialBalance"] = async () => this.#unexpected("getTrialBalance");

  #invoice(input: Parameters<NonNullable<AccountingProvider["createDraftSalesInvoice"]>>[1]): SalesInvoiceSnapshot {
    const lines = input.lines.map((line) => {
      const amount = line.quantity * line.unit_amount;
      return {
        description: line.description,
        quantity: fixedFour(line.quantity),
        unitAmount: fixedFour(line.unit_amount),
        lineAmount: fixedFour(amount),
        taxAmount: fixedFour(amount * 0.09),
        accountId: line.account_id,
        accountCode: line.account_code,
        taxType: line.tax_type,
      };
    });
    const subtotal = input.lines.reduce((sum, line) => sum + line.quantity * line.unit_amount, 0);
    const tax = subtotal * 0.09;
    return {
      tenantId: this.metadata.tenant_id,
      invoiceId: this.metadata.invoice_id,
      type: "ACCREC",
      status: "DRAFT",
      contact: { contactId: this.metadata.contact_id, name: this.#contact.name },
      invoiceDate: input.invoice_date,
      dueDate: input.due_date,
      currency: input.currency,
      ...(input.currency_rate !== undefined ? { currencyRate: fixedFour(input.currency_rate) } : {}),
      invoiceNumber: input.reference,
      lineAmountType: input.line_amount_type,
      lineItemCount: lines.length,
      linesTruncated: false,
      lines,
      subTotal: fixedFour(subtotal),
      totalTax: fixedFour(tax),
      total: fixedFour(subtotal + tax),
    };
  }

  #singlePage(returned: number) {
    return {
      page: 1,
      pageSize: 100,
      returned,
      providerPageCount: 1,
      providerItemCount: returned,
      hasNextPage: false,
      hasNextPageIsEstimated: false,
      omittedInvalid: 0,
    };
  }

  #unexpected(operation: string): never {
    throw new Error(`CRASH_HARNESS_UNEXPECTED_PROVIDER_OPERATION:${operation}`);
  }
}

function instrumentRepository(
  repository: PostgresAccountingRepository,
  scenario: ScenarioId,
  phase: Phase,
): AccountingRepository {
  return new Proxy(repository as unknown as AccountingRepository, {
    get(target, property, receiver) {
      if (property === "recordAccountingCasePreflight" &&
          phase === "initial" && scenario === "AFTER_PREFLIGHT_PREPARED") {
        return async (...args: Parameters<AccountingRepository["recordAccountingCasePreflight"]>) => {
      const result = await repository.recordAccountingCasePreflight(...args);
          await crashWindow(scenario, {
            case_state: result.record.state,
            preflight_receipt_hash: result.record.preflightReceiptHash ?? null,
            durable_prepared_operations: result.record.operations.filter((operation) => operation.state === "PREPARED").length,
          });
        };
      }
      if (property === "claimAccountingCaseExecution" &&
          phase === "restart" && scenario === "AFTER_PREFLIGHT_PREPARED") {
        return async (...args: Parameters<AccountingRepository["claimAccountingCaseExecution"]>) => {
          const result = await repository.claimAccountingCaseExecution(...args);
          emit({
            event: "RESTART_DURABLE_CASE_CLAIM",
            scenario_id: scenario,
            case_state: result.record.state,
            claim_mode: result.mode,
          });
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(repository) : value;
    },
  });
}

async function seed(
  repository: PostgresAccountingRepository,
  metadata: RuntimeMetadata,
  context: RequestContext,
): Promise<void> {
  const anchor = new Date(metadata.anchor_at);
  const expiresAt = new Date(metadata.target_expires_at);
  await repository.pool.query(`
    CREATE TABLE IF NOT EXISTS crash_harness_provider_ledger (
      run_id text NOT NULL,
      idempotency_key text NOT NULL,
      object_id text NOT NULL,
      document jsonb NOT NULL,
      receipt jsonb NOT NULL,
      accepted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(run_id, idempotency_key),
      UNIQUE(run_id, object_id)
    )
  `);
  await repository.pool.query(`
    CREATE TABLE IF NOT EXISTS crash_harness_provider_events (
      sequence_id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      process_pid integer NOT NULL,
      operation text NOT NULL CHECK (operation IN ('CREATE_ATTEMPT','CREATE_ACCEPTED','GET')),
      object_id text,
      details jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await repository.saveProviderAuthorization({
    authorizationId: metadata.authorization_id,
    workspaceId: metadata.workspace_id,
    authorizedBySubject: metadata.subject_id,
    provider: "xero",
    providerSubject: `provider-subject-${metadata.run_id}`,
    grantedScopes: ["accounting.transactions", "accounting.contacts", "accounting.settings.read"],
    tokenCiphertext: "synthetic-crash-harness-token-never-decrypted",
    tokenExpiresAt: expiresAt,
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: anchor,
    updatedAt: anchor,
  });
  await repository.upsertAuthorizedProviderConnection(metadata.workspace_id, {
    connectionId: metadata.connection_id,
    authorizationId: metadata.authorization_id,
    provider: "xero",
    providerConnectionId: `provider-connection-${metadata.run_id}`,
    tenantId: metadata.tenant_id,
    tenantName: "Crash Harness Company",
    status: "ACTIVE",
    lastVerifiedAt: anchor,
    createdAt: anchor,
    updatedAt: anchor,
  });
  await repository.saveOAuthInstallation({
    installationId: metadata.installation_id,
    workspaceId: metadata.workspace_id,
    subjectType: "USER",
    subjectId: metadata.subject_id,
    agentId: metadata.agent_id,
    clientId: `client-${metadata.run_id}`,
    status: "ACTIVE",
    createdAt: anchor,
    updatedAt: anchor,
  });
  await repository.saveAgentConnectionBinding({
    bindingId: metadata.binding_id,
    installationId: metadata.installation_id,
    workspaceId: metadata.workspace_id,
    subjectType: "USER",
    subjectId: metadata.subject_id,
    agentId: metadata.agent_id,
    connectionId: metadata.connection_id,
    policyId: `policy-${metadata.run_id}`,
    status: "ACTIVE",
    createdAt: anchor,
    updatedAt: anchor,
  });
  await repository.saveLedgerTargetSession({
    sessionId: metadata.target_session_id,
    sessionHash: metadata.target_session_hash,
    installationId: metadata.installation_id,
    bindingId: metadata.binding_id,
    connectionId: metadata.connection_id,
    bindingRevision: 1,
    createdAt: anchor,
    expiresAt,
  });
  await repository.publishLedgerAuthoritySnapshot({
    providerId: "xero",
    revision: 1,
    writeKillSwitchEnabled: true,
    standingDelegations: [{
      delegationId: `delegation-${metadata.run_id}`,
      revision: 1,
      status: "ACTIVE",
      providerId: "xero",
      workspaceId: metadata.workspace_id,
      agentId: metadata.agent_id,
      installationId: metadata.installation_id,
      tenantIds: [metadata.tenant_id],
      actionIds: ["customer_invoice.create_draft"],
      expiresAt,
    }],
    publishedAt: anchor,
  });
}

async function loadPrepareInput(metadata: RuntimeMetadata): Promise<PrepareAccountingCasePublicInput> {
  const manifestPath = resolve(process.cwd(), "harness/scenarios/accounting-case-deterministic.p0.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    cases: Array<{ id: string; steps: Array<{ input?: PrepareAccountingCasePublicInput }> }>;
  };
  const template = manifest.cases.find((candidate) => candidate.id === "AC-CASE-PREPARE-002")?.steps[0]?.input;
  if (!template) throw new Error("CRASH_HARNESS_PREPARE_TEMPLATE_MISSING");
  const input = structuredClone(template);
  input.case_id = metadata.case_id;
  return "sources" in input
    ? input
    : normalizeXeroAccountingCaseBusinessIntake(xeroAccountingCaseBusinessIntakeSchema.parse(input));
}

async function durableSnapshot(repository: PostgresAccountingRepository, metadata: RuntimeMetadata) {
  const context = requestContext(metadata);
  const binding = {
    actorId: context.actorId,
    workspaceId: context.workspaceId!,
    subjectType: context.subjectType!,
    subjectId: context.subjectId!,
    agentId: context.agentId!,
    installationId: context.oauthInstallationId!,
    bindingId: context.bindingId!,
    bindingRevision: context.bindingRevision!,
    connectionId: context.connectionId!,
    tenantId: metadata.tenant_id,
    targetSessionId: context.targetSessionId!,
    targetSessionHash: context.targetSessionHash!,
    targetSessionExpiresAt: context.targetSessionExpiresAt!,
  };
  const record = await repository.getBoundAccountingCase({ binding, caseId: metadata.case_id, version: 1 });
  const providerCounts = await repository.pool.query<{
    create_attempts: string;
    create_accepts: string;
    gets: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE operation = 'CREATE_ATTEMPT')::text AS create_attempts,
       count(*) FILTER (WHERE operation = 'CREATE_ACCEPTED')::text AS create_accepts,
       count(*) FILTER (WHERE operation = 'GET')::text AS gets
     FROM crash_harness_provider_events WHERE run_id = $1`,
    [metadata.run_id],
  );
  const mutationIds = record?.operations
    .map((operation) => operation.mutationRequestId)
    .filter((value): value is string => Boolean(value)) ?? [];
  const mutations = await Promise.all(mutationIds.map((id) => repository.getXeroMutationRequest(id)));
  return {
    case_state: record?.state ?? null,
    operation_states: record?.operations.map((operation) => operation.state) ?? [],
    mutation_states: mutations.map((mutation) => mutation?.state ?? null),
    provider_object_ids: mutations.map((mutation) => mutation?.xeroObjectId ?? null),
    provider_create_attempt_count: Number(providerCounts.rows[0]?.create_attempts ?? "0"),
    provider_create_accept_count: Number(providerCounts.rows[0]?.create_accepts ?? "0"),
    provider_get_count: Number(providerCounts.rows[0]?.gets ?? "0"),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
  const metadata = assertMetadata(JSON.parse(await readFile(args.metadataPath, "utf8")), args.scenario);
  if (args.phase === "initial") await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
  const durableRepository = new PostgresAccountingRepository(databaseUrl);
  try {
    const context = requestContext(metadata);
    if (args.phase === "initial") await seed(durableRepository, metadata, context);
    const repository = instrumentRepository(durableRepository, args.scenario, args.phase);
    const provider = new DurableSyntheticXeroProvider(durableRepository, metadata, args.scenario, args.phase);
    const anchor = new Date(metadata.anchor_at);
    const mutations = new XeroMutationService(repository, {
      confirmationSecret: "process-crash-harness-confirmation-secret-at-least-32-bytes",
      authoritySnapshotResolver: new RepositoryLedgerAuthoritySnapshotResolver(repository),
      now: () => new Date(anchor),
      providerCapabilityEvaluator: {
        evaluate: async (_effectiveContext, actionId) => ({
          allowed: true,
          denyReasons: [],
          receiptHash: hashObject({ actionId, provider: "xero", tenantId: metadata.tenant_id }),
        }),
      },
    });
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const accounting = new AccountingService({
      repository,
      provider,
      config: {
        publicBaseUrl: "https://xero-mcp.process-crash.invalid",
        xeroWriteEnabled: true,
        xeroAllowedTenantId: metadata.tenant_id,
      },
      logger,
      connectionTickets: new ConnectionTicketService(repository, "https://xero-mcp.process-crash.invalid"),
      mutationFoundation: mutations,
    });
    const caseService = new XeroAccountingCaseService(repository, provider, accounting, mutations, {
      continuationSecret: PROCESS_CRASH_CONTINUATION_SECRET,
      testTenantIds: [metadata.tenant_id],
      businessAuthorityProfiles: parseXeroAccountingCaseBusinessAuthorityProfiles([{
        tenant_id: metadata.tenant_id,
        writer_authority: {
          mode: "EXCLUSIVE_GOVERNED_WRITER",
          authority_id: `crash-harness-writer-${metadata.run_id}`,
          revision: 1,
          covers_all_tenant_writers: true,
          verification_receipt_sha256: "f".repeat(64),
        },
        recurring_series_authorities: [],
      }]),
      clock: () => new Date(anchor),
    });

    if (args.phase === "initial") {
      const prepared = await caseService.prepare(context, await loadPrepareInput(metadata));
      emit({ event: "CASE_PREPARED", scenario_id: args.scenario, case_state: prepared.state, case_version: prepared.case_version });
    }
    const readiness = await durableRepository.readinessEvidence(XERO_RELEASE_ATTESTATION.requiredMigration);
    emit({
      event: "PROCESS_READY",
      scenario_id: args.scenario,
      phase: args.phase,
      release_version: XERO_RELEASE_VERSION,
      release_attestation: XERO_RELEASE_ATTESTATION,
      release_attestation_hash: hashObject(XERO_RELEASE_ATTESTATION),
      postgres_readiness: readiness,
    });
    let result;
    try {
      result = await caseService.execute(context, {
        case_id: metadata.case_id,
        case_version: 1,
        request_id: metadata.execution_request_id,
      });
    } catch (error) {
      if (args.phase === "restart" && args.scenario === "AFTER_WRITE_CLAIM_BEFORE_PROVIDER") {
        const snapshot = await durableSnapshot(durableRepository, metadata);
        if (
          snapshot.case_state !== "RECOVERY_REQUIRED" ||
          snapshot.provider_create_attempt_count !== 0 ||
          !snapshot.operation_states.some((state) => state === "WRITE_IN_FLIGHT" || state === "WRITE_UNCERTAIN")
        ) throw error;
        emit({
          event: "PROCESS_RESULT",
          scenario_id: args.scenario,
          phase: args.phase,
          result_state: snapshot.case_state,
          completion_claim: "BLOCKED_SAFE_UNKNOWN",
          safe_unknown_error: {
            error_class: error instanceof Error ? error.name : "UnknownError",
            error_message: error instanceof Error ? error.message : String(error),
          },
          durable_snapshot: snapshot,
        });
        return;
      }
      throw error;
    }
    if (args.phase === "initial" && args.scenario === "AFTER_DURABLE_COMPLETION_BEFORE_RESPONSE") {
      await crashWindow(args.scenario, {
        case_state: result.state,
        operation_states: result.operations.map((operation) => operation.state),
      });
    }
    emit({
      event: "PROCESS_RESULT",
      scenario_id: args.scenario,
      phase: args.phase,
      result_state: result.state,
      completion_claim: result.completion_claim,
      durable_snapshot: await durableSnapshot(durableRepository, metadata),
    });
  } finally {
    await durableRepository.close();
  }
}

main().catch((error: unknown) => {
  emit({
    event: "PROCESS_ERROR",
    error_class: error instanceof Error ? error.name : "UnknownError",
    error_message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
