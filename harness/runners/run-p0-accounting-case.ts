/**
 * Current 0.4.0-rc.1 deterministic controlled-write release gate.
 *
 * The runner exercises only the Agent-facing Accounting Case public contract:
 * manifest-derived public surface, prepare-without-write, identity-only execute
 * under the pinned OAuth target, released typed Case action and write gate,
 * provider receipt plus exact readback, and idempotent
 * terminal replay. Object-level mutation tools are probed only to prove that
 * they are absent and cannot bypass the Case.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryAccountingRepository } from "../../src/db/inMemoryRepository.js";
import { RepositoryLedgerAuthoritySnapshotResolver } from "../../src/domain/ledgerAuthority.js";
import type { XeroAccountingCaseBusinessIntake } from "../../src/mcp/xeroAccountingCaseBusinessIntake.js";
import type { AccountingCaseBinding } from "../../src/domain/accountingCasePersistence.js";
import type {
  AccountingProvider,
  AccountSummary,
  ActorTenantContext,
  ContactSummary,
  SalesInvoiceSnapshot,
  SupplierBillSnapshot,
  TaxRateSummary,
} from "../../src/providers/types.js";
import { hashObject } from "../../src/security/hash.js";
import { consumeXeroProviderWritePermitAtMutationBoundary } from "../../src/security/xeroProviderWritePermitContext.js";
import { createOAuthRequestContext, type RequestContext } from "../../src/security/requestContext.js";
import { createAccountingMcpServer } from "../../src/mcp/createServer.js";
import { TOOL_ALLOWLIST } from "../../src/mcp/toolNames.js";
import type { Logger } from "../../src/logging.js";
import { AccountingService } from "../../src/services/accountingService.js";
import { ConnectionTicketService } from "../../src/services/connectionTicketService.js";
import { XeroAccountingCaseService } from "../../src/services/xeroAccountingCaseService.js";
import { LedgerTargetSessionService } from "../../src/services/ledgerTargetSessionService.js";
import { OrganisationSwitchService } from "../../src/services/organisationSwitchService.js";
import { XeroMutationService } from "../../src/services/xeroMutationService.js";
import { parseXeroAccountingCaseBusinessAuthorityProfiles } from "../../src/policy/xeroBusinessCoordinateAuthority.js";
import {
  createXeroRuntimeAttestation,
  XERO_RELEASE_ATTESTATION,
  XERO_RELEASE_VERSION,
} from "../../src/xeroRelease.js";
import {
  oracleRunSchema,
  type OracleCaseResult,
  type OracleResult,
  type OracleRunResult,
} from "../lib/oracleResultRuntimeSchema.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const scenarioPath = resolve(repoRoot, "harness/scenarios/accounting-case-deterministic.p0.json");
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const INVOICE_ID = "44444444-4444-4444-8444-444444444444";
const SUPPLIER_BILL_ID = "55555555-5555-4555-8555-555555555555";
const AUTHORIZATION_ID = "p0-accounting-case-oauth-binding";
const POLICY_ID = "typed-case-write-gate-v1";
const LEGACY_OBJECT_WRITE_TOOL = "xero_create_draft_supplier_bill";
const CONTROLLED_WRITE_CONTINUATION_SECRET = Buffer.from(
  "p0-controlled-write-continuation-secret-v1",
  "utf8",
);
const LOCAL_AGENT_CONTINUATION_SECRET = Buffer.from(
  "local-agent-continuation-secret-v1",
  "utf8",
);

type JsonObject = Record<string, unknown>;
type EvidenceKind = "TOOL_CALL" | "TOOL_OUTPUT" | "PROVIDER_CALL" | "PROVIDER_RECORD" | "REPOSITORY_STATE" | "STATE_PROBE";

interface ScenarioStep {
  input?: XeroAccountingCaseBusinessIntake | JsonObject;
}

interface ScenarioCase {
  id: string;
  personas: string[];
  steps: ScenarioStep[];
  baseline_expectation: "PASS" | "EXPECTED_RED";
}

interface ScenarioManifest {
  suite_id: string;
  layer: "DETERMINISTIC_CONTRACT";
  cases: ScenarioCase[];
}

interface EvidenceRecord {
  schema_version: "1.0";
  run_id: string;
  evidence_id: string;
  case_id: string;
  kind: EvidenceKind;
  label: string;
  captured_at: string;
  payload: unknown;
}

interface ProviderRecord {
  case_id: string;
  invoice_id: string;
  status: "DRAFT";
  provider_receipt: Record<string, unknown>;
  exact_readback: Record<string, unknown>;
}

interface ToolObservation {
  isError: boolean;
  result?: unknown;
  thrown?: { name: string; message: string };
}

interface RuntimeCounters {
  casePrepareCalls: number;
  caseExecuteCalls: number;
  caseStatusCalls: number;
  writeGatePreflights: string[][];
  providerWriteAttempts: number;
  providerRecords: ProviderRecord[];
  auditTools: string[];
}

interface LocalAgentMcpProtocolCall {
  jsonrpc_id: string | number;
  method: "tools/call";
  tool: string;
  public_arguments: JsonObject;
  started_at: string;
  finished_at: string;
  status: "PASS" | "FAIL";
  target_session_ref_hash: string | null;
  raw_structured_result: unknown | null;
  error: unknown | null;
}

interface LocalAgentProtocolObserver {
  receive(message: JSONRPCMessage): void;
  send(message: JSONRPCMessage): Promise<void>;
}

/** Harness-only transport tap; production MCP behavior remains unchanged. */
class AuditedLocalAgentTransport implements Transport {
  /**
   * A `get sessionId()` accessor of type `string | undefined` cannot satisfy
   * `Transport`'s `sessionId?: string` under `exactOptionalPropertyTypes`:
   * TypeScript requires "string when present" for an optional property, and
   * an accessor is always present, so it can never be typed to admit
   * `undefined` (the MCP SDK's own StreamableHTTPServerTransport hits the
   * identical shape and is only spared because its .d.ts is trusted, not
   * re-checked). Declaring the field with `declare` and wiring the live
   * pass-through via defineProperty keeps this the same plain
   * optional-property shape the interface declares, checkable as such, with
   * identical runtime behaviour to the getter it replaces - nothing in the
   * SDK ever writes to a Transport's sessionId, so a getter-only descriptor
   * changes nothing observable.
   */
  declare readonly sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: Transport,
    private readonly observer: LocalAgentProtocolObserver,
  ) {
    Object.defineProperty(this, "sessionId", {
      enumerable: false,
      configurable: true,
      get: (): string | undefined => this.inner.sessionId,
    });
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message, extra) => {
      this.observer.receive(message);
      this.onmessage?.(message, extra);
    };
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.observer.send(message);
    await this.inner.send(message, options);
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}

export interface ExecuteP0AccountingCaseOptions {
  runId?: string;
  outputDirectory?: string;
  writeArtifacts?: boolean;
  providerEconomicMutation?: "NONE" | "SELF_CONSISTENT_WRONG_TAX_AND_TOTAL";
}

export interface ExecuteP0AccountingCaseResult {
  report: OracleRunResult;
  evidence: EvidenceRecord[];
  providerWriteAttempts: number;
  providerRecords: ProviderRecord[];
  writeGatePreflights: string[][];
  toolCalls: Array<{ case_id: string; tool: string; input: JsonObject }>;
  finalCaseState?: string;
  finalOperationStates: string[];
  artifactPaths?: {
    oracleResults: string;
    evidence: string;
    providerRecords: string;
    summary: string;
  };
}

const RUN_CLOCK_ANCHOR = new Date();
const TARGET_SESSION_CREATED_AT = new Date(RUN_CLOCK_ANCHOR.getTime() - 30 * 60_000);
const TARGET_SESSION_EXPIRES_AT = new Date(RUN_CLOCK_ANCHOR.getTime() + 2 * 60 * 60_000);
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

/** ContactSummary.name is optional on the real interface; this fixture always sets it. */
const CONTACT_NAME = "Exact Customer";

const CONTACT: ContactSummary = Object.freeze({
  contactId: CONTACT_ID,
  name: CONTACT_NAME,
  status: "ACTIVE",
  isCustomer: true,
});

const ACCOUNT: AccountSummary = Object.freeze({
  accountId: ACCOUNT_ID,
  code: "200",
  name: "Consulting Revenue",
  status: "ACTIVE",
  class: "REVENUE",
  type: "REVENUE",
});

const ACCOUNTS: readonly AccountSummary[] = Object.freeze([
  ACCOUNT,
  Object.freeze({
    accountId: "33333333-3333-4333-8333-333333333353",
    code: "453",
    name: "Office Supplies",
    status: "ACTIVE",
    class: "EXPENSE",
    type: "EXPENSE",
  }),
  Object.freeze({
    accountId: "33333333-3333-4333-8333-333333333385",
    code: "485",
    name: "Cloud Subscriptions",
    status: "ACTIVE",
    class: "EXPENSE",
    type: "EXPENSE",
  }),
]);

const BUSINESS_AUTHORITY_PROFILES = parseXeroAccountingCaseBusinessAuthorityProfiles([{
  tenant_id: TENANT_ID,
  writer_authority: {
    mode: "EXCLUSIVE_GOVERNED_WRITER",
    authority_id: "p0-accounting-case-exclusive-writer",
    revision: 1,
    covers_all_tenant_writers: true,
    verification_receipt_sha256: "f".repeat(64),
  },
  recurring_series_authorities: [],
}]);

const TAX_RATE: TaxRateSummary = Object.freeze({
  taxType: "OUTPUTY24",
  name: "GST on Income",
  status: "ACTIVE",
  displayTaxRate: "9.0000",
  effectiveRate: "9.0000",
  canApplyToRevenue: true,
});

/**
 * Supplier bills are a first-class write action, but a tenant that only
 * publishes a revenue-applicable rate cannot express one at all: there is no
 * legal tax_type for an ACCPAY line. The harness used to expose exactly that,
 * so every local supplier-bill scenario died on the fixture rather than on the
 * behaviour under test. These two are the purchase-side counterparts a real SG
 * organisation carries.
 */
const INPUT_TAX_RATE: TaxRateSummary = Object.freeze({
  taxType: "INPUTY24",
  name: "GST on Expenses",
  status: "ACTIVE",
  displayTaxRate: "9.0000",
  effectiveRate: "9.0000",
  canApplyToExpenses: true,
});

const NO_TAX_RATE: TaxRateSummary = Object.freeze({
  taxType: "NONE",
  name: "Tax Exempt",
  status: "ACTIVE",
  displayTaxRate: "0.0000",
  effectiveRate: "0.0000",
  canApplyToExpenses: true,
  canApplyToRevenue: true,
});

const TAX_RATES: readonly TaxRateSummary[] = Object.freeze([TAX_RATE, INPUT_TAX_RATE, NO_TAX_RATE]);

function fixedFour(value: number): string {
  return value.toFixed(4);
}

/**
 * Xero returns tax rounded to the currency minor unit and aggregates it per
 * line, so a GST-inclusive source whose net is already cents-rounded yields a
 * short decimal (1100.92 * 0.09 -> 99.08), not the raw product (99.0828).
 *
 * The double previously emitted the raw product, which the exact-readback
 * validator correctly rejected as a mismatch — a fidelity gap in the fake, not
 * in the Case logic. Rounding here keeps the double faithful to the provider so
 * realistic invoices can reach READBACK_VERIFIED. The wrong-economics fault
 * injection stays detectable: it moves the rate far more than one cent.
 */
function minorUnitTax(lineAmount: number, taxRate: number): number {
  return Math.round(lineAmount * taxRate * 100) / 100;
}

/**
 * Deterministic Xero test double at the provider-adapter boundary only.
 * Everything above this class is the production Case, Accounting and Mutation
 * service stack. The fake consumes the real one-shot write permit, persists a
 * provider-side record and makes the POST result travel through the same GET
 * method used by recovery before it can be returned as readback evidence.
 */
class P0XeroProviderFake implements AccountingProvider {
  #invoice?: SalesInvoiceSnapshot;
  #bill?: SupplierBillSnapshot;

  constructor(
    private readonly counters: RuntimeCounters,
    private caseId: string,
    private readonly writeGateIsOpen: () => boolean,
    private readonly economicMutation: NonNullable<ExecuteP0AccountingCaseOptions["providerEconomicMutation"]>,
  ) {}

  setEvidenceCaseId(caseId: string): void {
    this.caseId = caseId;
  }

  readonly connectionStatus: AccountingProvider["connectionStatus"] = async () => ({
    connected: true,
    tenant: { id: TENANT_ID, name: "Synthetic Case Company" },
    scopes: ["xero.read", "xero.draft.write"],
    tokenExpiresAt: TARGET_SESSION_EXPIRES_AT.toISOString(),
  });

  readonly resolveContext: AccountingProvider["resolveContext"] = async (principal) => ({
    actorId: typeof principal === "string" ? principal : principal.actorId,
    tenantId: TENANT_ID,
    tenantName: "Synthetic Case Company",
  });

  readonly getOrganisation: AccountingProvider["getOrganisation"] = async () => ({
    organisationId: TENANT_ID,
    name: "Synthetic Case Company",
    countryCode: "SG",
    baseCurrency: "SGD",
    paysTax: true,
    organisationStatus: "ACTIVE",
  });

  readonly listAccounts: AccountingProvider["listAccounts"] = async () => structuredClone([...ACCOUNTS]);
  readonly listTaxRates: AccountingProvider["listTaxRates"] = async () => TAX_RATES.map((rate) => structuredClone(rate));
  readonly listContacts: AccountingProvider["listContacts"] = async () => ({
    contacts: [structuredClone(CONTACT)],
    pagination: this.#singlePage(1),
  });
  readonly searchContacts: AccountingProvider["searchContacts"] = async (_principal, query) => {
    const canonicalQuery = query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
    const canonicalContactName = CONTACT_NAME.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
    const contacts = canonicalQuery === canonicalContactName ? [structuredClone(CONTACT)] : [];
    return { contacts, pagination: this.#singlePage(contacts.length) };
  };
  readonly getSupplierBillDraftReferenceData: AccountingProvider["getSupplierBillDraftReferenceData"] = async () => ({
    tenant: { id: TENANT_ID, name: "Synthetic Case Company" },
    contacts: [structuredClone(CONTACT)],
    contactsComplete: true,
    accounts: structuredClone([...ACCOUNTS]),
    taxRates: TAX_RATES.map((rate) => structuredClone(rate)),
  });
  readonly getContact: AccountingProvider["getContact"] = async (_principal, contactId) =>
    contactId === CONTACT_ID ? structuredClone(CONTACT) : undefined;

  readonly getInvoice: AccountingProvider["getInvoice"] = async (_principal, invoiceId, expectedType) => {
    if (!this.#invoice || invoiceId !== this.#invoice.invoiceId || (expectedType && expectedType !== "ACCREC")) {
      throw new Error("P0 fake GET could not find the exact ACCREC invoice.");
    }
    return structuredClone(this.#invoice);
  };

  readonly createDraftSalesInvoice: AccountingProvider["createDraftSalesInvoice"] = async (
    principal,
    input,
    idempotencyKey,
    recordWriteEvidence,
    providerWritePermit,
    mutationRequestId,
  ) => {
    if (!this.writeGateIsOpen()) {
      throw new Error("P0 fake provider write attempted while the isolated gate was closed.");
    }
    const serverOwnedCompatibilityField = ["user", "confirmation"].join("_");
    const canonicalPayload = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== serverOwnedCompatibilityField),
    );
    consumeXeroProviderWritePermitAtMutationBoundary({
      permit: providerWritePermit,
      principal: principal as RequestContext,
      connection: { connectionId: "p0-accounting-case-connection", tenantId: TENANT_ID } as never,
      adapterOperation: "XeroAccountingProvider.createDraftSalesInvoice",
      actionId: "customer_invoice.create_draft",
      mutationRequestId: mutationRequestId ?? "",
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload,
    });
    this.counters.providerWriteAttempts += 1;

    const wrongEconomics = this.economicMutation === "SELF_CONSISTENT_WRONG_TAX_AND_TOTAL";
    const taxRate = wrongEconomics ? 0.072 : 0.09;
    const lines = input.lines.map((line) => {
      const lineAmount = line.quantity * line.unit_amount;
      return {
        description: line.description,
        quantity: fixedFour(line.quantity),
        unitAmount: fixedFour(line.unit_amount),
        lineAmount: fixedFour(lineAmount),
        taxAmount: fixedFour(minorUnitTax(lineAmount, taxRate)),
        ...(line.account_id !== undefined ? { accountId: line.account_id } : {}),
        accountCode: line.account_code,
        taxType: line.tax_type,
      };
    });
    const subTotal = input.lines.reduce((sum, line) => sum + line.quantity * line.unit_amount, 0);
    const totalTax = input.lines.reduce(
      (sum, line) => sum + minorUnitTax(line.quantity * line.unit_amount, taxRate),
      0,
    );
    this.#invoice = {
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      type: "ACCREC",
      status: "DRAFT",
      contact: { contactId: CONTACT_ID, name: CONTACT_NAME },
      invoiceDate: input.invoice_date,
      dueDate: input.due_date,
      currency: input.currency,
      ...(input.currency_rate !== undefined ? { currencyRate: fixedFour(input.currency_rate) } : {}),
      invoiceNumber: input.reference,
      lineAmountType: input.line_amount_type,
      lineItemCount: lines.length,
      linesTruncated: false,
      lines,
      subTotal: fixedFour(subTotal),
      totalTax: fixedFour(totalTax),
      total: fixedFour(subTotal + totalTax),
    };
    const receipt = {
      operation: "CREATE_ACCREC_DRAFT",
      invoiceId: INVOICE_ID,
      providerRequestId: "provider-request-case-001",
      tenantId: TENANT_ID,
      idempotencyKey,
    };
    await recordWriteEvidence?.({ invoiceId: INVOICE_ID, receipt });

    // The provider-side POST result is deliberately read through exact GET.
    // The fake never accepts an expected canonical payload or expected hash.
    const exactReadback = await this.getInvoice(principal, INVOICE_ID, "ACCREC") as SalesInvoiceSnapshot;
    this.counters.providerRecords.push({
      case_id: this.caseId,
      invoice_id: INVOICE_ID,
      status: "DRAFT",
      provider_receipt: structuredClone(receipt),
      exact_readback: structuredClone(exactReadback) as unknown as Record<string, unknown>,
    });
    return { invoice: exactReadback, receipt };
  };

  readonly listInvoices: AccountingProvider["listInvoices"] = async () => ({
    invoices: this.#invoice ? [structuredClone(this.#invoice)] : [],
    pagination: this.#singlePage(this.#invoice ? 1 : 0),
  });
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
  readonly getSupplierBill: AccountingProvider["getSupplierBill"] = async (_principal, invoiceId) => {
    if (!this.#bill || invoiceId !== this.#bill.invoiceId) {
      throw new Error("P0 fake GET could not find the exact ACCPAY supplier bill.");
    }
    return structuredClone(this.#bill);
  };
  readonly listJournals: AccountingProvider["listJournals"] = async () => this.#unexpected("listJournals");
  readonly getProfitAndLoss: AccountingProvider["getProfitAndLoss"] = async () => this.#unexpected("getProfitAndLoss");
  readonly getBalanceSheet: AccountingProvider["getBalanceSheet"] = async () => this.#unexpected("getBalanceSheet");
  readonly getAgedReceivables: AccountingProvider["getAgedReceivables"] = async () => this.#unexpected("getAgedReceivables");
  readonly getAgedPayables: AccountingProvider["getAgedPayables"] = async () => this.#unexpected("getAgedPayables");
  readonly getPayment: AccountingProvider["getPayment"] = async () => this.#unexpected("getPayment");
  readonly listTrackingCategories: AccountingProvider["listTrackingCategories"] = async () =>
    this.#unexpected("listTrackingCategories");
  readonly listContactGroups: AccountingProvider["listContactGroups"] = async () =>
    this.#unexpected("listContactGroups");

  readonly createDraftSupplierBill: AccountingProvider["createDraftSupplierBill"] = async (
    principal,
    input,
    idempotencyKey,
    recordWriteEvidence,
    providerWritePermit,
    mutationRequestId,
  ) => {
    if (!this.writeGateIsOpen()) {
      throw new Error("P0 fake provider write attempted while the isolated gate was closed.");
    }
    const serverOwnedCompatibilityField = ["user", "confirmation"].join("_");
    const canonicalPayload = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== serverOwnedCompatibilityField),
    );
    consumeXeroProviderWritePermitAtMutationBoundary({
      permit: providerWritePermit,
      principal: principal as RequestContext,
      connection: { connectionId: "p0-accounting-case-connection", tenantId: TENANT_ID } as never,
      adapterOperation: "XeroAccountingProvider.createDraftSupplierBill",
      actionId: "supplier_bill.create_draft",
      mutationRequestId: mutationRequestId ?? "",
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload,
    });
    this.counters.providerWriteAttempts += 1;

    const wrongEconomics = this.economicMutation === "SELF_CONSISTENT_WRONG_TAX_AND_TOTAL";
    const taxRate = wrongEconomics ? 0.072 : 0.09;
    const lines = input.lines.map((line) => {
      const lineAmount = line.quantity * line.unit_amount;
      return {
        description: line.description,
        quantity: fixedFour(line.quantity),
        unitAmount: fixedFour(line.unit_amount),
        lineAmount: fixedFour(lineAmount),
        taxAmount: fixedFour(minorUnitTax(lineAmount, taxRate)),
        ...(line.account_id !== undefined ? { accountId: line.account_id } : {}),
        accountCode: line.account_code,
        taxType: line.tax_type,
      };
    });
    const subTotal = input.lines.reduce((sum, line) => sum + line.quantity * line.unit_amount, 0);
    const totalTax = input.lines.reduce(
      (sum, line) => sum + minorUnitTax(line.quantity * line.unit_amount, taxRate),
      0,
    );
    this.#bill = {
      tenantId: TENANT_ID,
      invoiceId: SUPPLIER_BILL_ID,
      type: "ACCPAY",
      status: "DRAFT",
      contact: { contactId: CONTACT_ID, name: CONTACT_NAME },
      invoiceDate: input.invoice_date,
      dueDate: input.due_date,
      currency: input.currency,
      ...(input.currency_rate !== undefined ? { currencyRate: fixedFour(input.currency_rate) } : {}),
      invoiceNumber: input.reference,
      lineAmountType: input.line_amount_type,
      lineItemCount: lines.length,
      linesTruncated: false,
      lines,
      subTotal: fixedFour(subTotal),
      totalTax: fixedFour(totalTax),
      total: fixedFour(subTotal + totalTax),
    };
    const receipt = {
      operation: "CREATE_ACCPAY_DRAFT",
      invoiceId: SUPPLIER_BILL_ID,
      providerRequestId: "provider-request-case-002",
      tenantId: TENANT_ID,
      idempotencyKey,
    };
    await recordWriteEvidence?.({ invoiceId: SUPPLIER_BILL_ID, receipt });

    // The provider-side POST result is deliberately read through exact GET.
    // The fake never accepts an expected canonical payload or expected hash.
    const exactReadback = await this.getSupplierBill(principal, SUPPLIER_BILL_ID);
    this.counters.providerRecords.push({
      case_id: this.caseId,
      invoice_id: SUPPLIER_BILL_ID,
      status: "DRAFT",
      provider_receipt: structuredClone(receipt),
      exact_readback: structuredClone(exactReadback) as unknown as Record<string, unknown>,
    });
    return { bill: exactReadback, receipt };
  };
  readonly getTrialBalance: AccountingProvider["getTrialBalance"] = async () => this.#unexpected("getTrialBalance");

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
    throw new Error(`P0 provider fake received unexpected operation ${operation}.`);
  }
}

class ObservedXeroMutationService extends XeroMutationService {
  constructor(
    ...args: [...ConstructorParameters<typeof XeroMutationService>, RuntimeCounters]
  ) {
    const [repository, options, counters] = args;
    super(repository, options);
    this.counters = counters;
  }

  private readonly counters: RuntimeCounters;

  override async preflightAutonomousActions(
    ...args: Parameters<XeroMutationService["preflightAutonomousActions"]>
  ) {
    this.counters.writeGatePreflights.push([...args[1]]);
    return super.preflightAutonomousActions(...args);
  }
}

class EvidenceCollector {
  readonly records: EvidenceRecord[] = [];

  constructor(private readonly runId: string) {}

  add(caseId: string, kind: EvidenceKind, label: string, payload: unknown): string {
    const evidenceId = `ev_${String(this.records.length + 1).padStart(5, "0")}`;
    this.records.push({
      schema_version: "1.0",
      run_id: this.runId,
      evidence_id: evidenceId,
      case_id: caseId,
      kind,
      label,
      captured_at: new Date().toISOString(),
      payload,
    });
    return `evidence.jsonl#${evidenceId}`;
  }
}

function requestContext(): RequestContext {
  return createOAuthRequestContext({
    issuer: "https://xero-mcp.p0-accounting-case.invalid",
    resolvedToken: {
      tokenId: "p0-accounting-case-token",
      clientId: "p0-accounting-case-client",
      resource: "https://xero-mcp.p0-accounting-case.invalid/mcp",
      audience: "https://xero-mcp.p0-accounting-case.invalid/mcp",
      grantedScopes: ["xero.read", "xero.draft.write"],
      issuedAt: new Date(RUN_CLOCK_ANCHOR.getTime() - 60 * 60_000),
      expiresAt: TARGET_SESSION_EXPIRES_AT,
      installationId: "p0-accounting-case-installation",
      bindingId: "p0-accounting-case-binding",
      bindingRevision: 1,
      workspaceId: "p0-accounting-case-workspace",
      subjectType: "USER",
      subjectId: "p0-accounting-case-user",
      agentId: "p0-accounting-case-agent",
      connectionId: "p0-accounting-case-connection",
      authorizationId: AUTHORIZATION_ID,
      tenantId: TENANT_ID,
      policyId: POLICY_ID,
    },
  });
}

function pinnedRequestContext(): RequestContext {
  const base = requestContext();
  return Object.freeze({
    ...base,
    targetSessionId: "p0-accounting-case-target-session",
    targetSessionHash: "a".repeat(64),
    targetSessionExpiresAt: TARGET_SESSION_EXPIRES_AT,
  });
}

function targetSessionRefHash(reference: string): string {
  return hashObject({ targetSessionRef: reference });
}

function targetSessionRefFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.target_session_ref === "string") return record.target_session_ref;
  const structured = record.structuredContent ?? record.structured_content;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const result = (structured as Record<string, unknown>).result;
    const nested = targetSessionRefFrom(result);
    if (nested) return nested;
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const text = (item as Record<string, unknown>).text;
      if (typeof text !== "string") continue;
      try {
        const nested = targetSessionRefFrom(JSON.parse(text));
        if (nested) return nested;
      } catch {
        // Non-JSON content cannot contain the structured target capability.
      }
    }
  }
  return undefined;
}

function redactTargetSessionRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTargetSessionRefs);
  if (!value || typeof value !== "object") {
    return typeof value === "string"
      ? value.replace(/xts_[A-Za-z0-9_-]{43}/gu, "<redacted-target-session-ref>")
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "target_session_ref" ? "<redacted-target-session-ref>" : redactTargetSessionRefs(child),
  ]));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function resultBody(observation: ToolObservation): JsonObject | undefined {
  const result = observation.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const structured = (result as JsonObject).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const body = (structured as JsonObject).result;
  return body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : undefined;
}

function oracle(
  oracleId: string,
  passed: boolean,
  observed: unknown,
  evidenceRefs: string[],
  message: string,
): OracleResult {
  return {
    oracle_id: oracleId,
    strength: "HARD",
    status: passed ? "PASS" : "FAIL",
    observed: observed === undefined ? null : observed,
    evidence_refs: unique(evidenceRefs),
    message,
  };
}

function caseResult(
  scenario: ScenarioCase,
  oracleResults: OracleResult[],
  evidenceRefs: string[],
): OracleCaseResult {
  const hardGatePassed = oracleResults.every((result) => result.status === "PASS");
  return {
    case_id: scenario.id,
    persona_id: scenario.personas[0] ?? "protocol_security_agent",
    repeat_index: 1,
    baseline_expectation: scenario.baseline_expectation,
    actual_status: hardGatePassed ? "PASS" : "FAIL",
    hard_gate_passed: hardGatePassed,
    expected_red_observed: false,
    oracle_results: oracleResults,
    evidence_refs: unique([...evidenceRefs, ...oracleResults.flatMap((result) => result.evidence_refs)]),
  };
}

async function callTool(
  client: Client,
  collector: EvidenceCollector,
  toolCalls: ExecuteP0AccountingCaseResult["toolCalls"],
  caseId: string,
  tool: string,
  input: JsonObject,
): Promise<{ observation: ToolObservation; evidenceRefs: string[] }> {
  toolCalls.push({ case_id: caseId, tool, input: structuredClone(input) });
  const callRef = collector.add(caseId, "TOOL_CALL", `${tool}:call`, { tool, input });
  try {
    const result = await client.callTool({ name: tool, arguments: input });
    const outputRef = collector.add(caseId, "TOOL_OUTPUT", `${tool}:output`, {
      tool,
      isError: result.isError === true,
      structuredContent: result.structuredContent ?? null,
    });
    return { observation: { isError: result.isError === true, result }, evidenceRefs: [callRef, outputRef] };
  } catch (error) {
    const thrown = {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    };
    const outputRef = collector.add(caseId, "TOOL_OUTPUT", `${tool}:throw`, { tool, isError: true, thrown });
    return { observation: { isError: true, thrown }, evidenceRefs: [callRef, outputRef] };
  }
}

function statusSummary(caseResults: OracleCaseResult[]): OracleRunResult["summary"] {
  const count = (status: OracleCaseResult["actual_status"]) =>
    caseResults.filter((result) => result.actual_status === status).length;
  return {
    total: caseResults.length,
    pass: count("PASS"),
    fail: count("FAIL"),
    blocked_model_provider: count("BLOCKED_MODEL_PROVIDER"),
    blocked_env: count("BLOCKED_ENV"),
    blocked_test_data: count("BLOCKED_TEST_DATA"),
    unsupported: count("UNSUPPORTED"),
    flaky: count("FLAKY"),
    not_run: count("NOT_RUN"),
  };
}

function summaryMarkdown(report: OracleRunResult, counters: RuntimeCounters): string {
  return [
    "# Accounting Case P0 deterministic controlled-write summary",
    "",
    `- Release: ${XERO_RELEASE_VERSION}`,
    `- Cases: ${report.summary.total}; PASS ${report.summary.pass}; FAIL ${report.summary.fail}`,
    `- Public tools: ${TOOL_ALLOWLIST.length}`,
    `- Provider write attempts: ${counters.providerWriteAttempts}`,
    `- Provider records with receipt/readback: ${counters.providerRecords.length}`,
    `- Write-gate preflights: ${counters.writeGatePreflights.length}`,
    "- Execute contract: case_id + case_version + request_id only",
    "- Unreleased state/payment operations in this draft-only scenario: 0",
    "- Write gate end: CLOSED",
    "",
  ].join("\n");
}

export async function executeP0AccountingCaseSuite(
  options: ExecuteP0AccountingCaseOptions = {},
): Promise<ExecuteP0AccountingCaseResult> {
  const startedAt = new Date();
  const runId = options.runId ?? `p0-accounting-case-${startedAt.toISOString().replaceAll(":", "-")}`;
  const manifest = JSON.parse(await readFile(scenarioPath, "utf8")) as ScenarioManifest;
  const byId = new Map(manifest.cases.map((scenario) => [scenario.id, scenario]));
  const surfaceScenario = byId.get("AC-SURFACE-001");
  const prepareScenario = byId.get("AC-CASE-PREPARE-002");
  const executeScenario = byId.get("AC-WRITE-GATE-003");
  if (!surfaceScenario || !prepareScenario || !executeScenario) {
    throw new Error("Current Accounting Case deterministic manifest is incomplete.");
  }
  const prepareInput = prepareScenario.steps[0]?.input;
  if (!prepareInput) throw new Error("Accounting Case prepare input is missing from the current manifest.");

  const collector = new EvidenceCollector(runId);
  const toolCalls: ExecuteP0AccountingCaseResult["toolCalls"] = [];
  const counters: RuntimeCounters = {
    casePrepareCalls: 0,
    caseExecuteCalls: 0,
    caseStatusCalls: 0,
    writeGatePreflights: [],
    providerWriteAttempts: 0,
    providerRecords: [],
    auditTools: [],
  };
  let writeGateOpen = false;
  const context = pinnedRequestContext();
  const binding: AccountingCaseBinding = {
    actorId: context.actorId,
    workspaceId: context.workspaceId!,
    subjectType: context.subjectType!,
    subjectId: context.subjectId!,
    agentId: context.agentId!,
    installationId: context.oauthInstallationId!,
    bindingId: context.bindingId!,
    bindingRevision: context.bindingRevision!,
    connectionId: context.connectionId!,
    tenantId: TENANT_ID,
    targetSessionId: context.targetSessionId!,
    targetSessionHash: context.targetSessionHash!,
    targetSessionExpiresAt: context.targetSessionExpiresAt!,
  };
  const repository = new InMemoryAccountingRepository();
  await repository.saveProviderAuthorization({
    authorizationId: AUTHORIZATION_ID,
    workspaceId: binding.workspaceId,
    authorizedBySubject: binding.subjectId,
    provider: "xero",
    providerSubject: "p0-accounting-case-xero-user",
    grantedScopes: ["accounting.transactions", "accounting.contacts", "accounting.settings.read"],
    tokenCiphertext: "encrypted-p0-test-token",
    tokenExpiresAt: new Date(RUN_CLOCK_ANCHOR.getTime() + 4 * 60 * 60_000),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  await repository.upsertAuthorizedProviderConnection(binding.workspaceId, {
    connectionId: binding.connectionId,
    authorizationId: AUTHORIZATION_ID,
    provider: "xero",
    providerConnectionId: "p0-accounting-case-provider-connection",
    tenantId: TENANT_ID,
    tenantName: "Synthetic Case Company",
    status: "ACTIVE",
    lastVerifiedAt: TARGET_SESSION_CREATED_AT,
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  await repository.saveOAuthInstallation({
    installationId: binding.installationId,
    workspaceId: binding.workspaceId,
    subjectType: binding.subjectType,
    subjectId: binding.subjectId,
    agentId: binding.agentId,
    clientId: "p0-accounting-case-client",
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  await repository.saveAgentConnectionBinding({
    bindingId: binding.bindingId,
    installationId: binding.installationId,
    workspaceId: binding.workspaceId,
    subjectType: binding.subjectType,
    subjectId: binding.subjectId,
    agentId: binding.agentId,
    connectionId: binding.connectionId,
    policyId: POLICY_ID,
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  await repository.saveLedgerTargetSession({
    sessionId: binding.targetSessionId,
    sessionHash: binding.targetSessionHash,
    installationId: binding.installationId,
    bindingId: binding.bindingId,
    connectionId: binding.connectionId,
    bindingRevision: binding.bindingRevision,
    createdAt: TARGET_SESSION_CREATED_AT,
    expiresAt: binding.targetSessionExpiresAt,
  });

  const provider = new P0XeroProviderFake(
    counters,
    String((prepareInput as JsonObject).case_id),
    () => writeGateOpen,
    options.providerEconomicMutation ?? "NONE",
  );
  await repository.publishLedgerAuthoritySnapshot({
    providerId: "xero",
    revision: 1,
    writeKillSwitchEnabled: true,
    standingDelegations: [],
    publishedAt: new Date(RUN_CLOCK_ANCHOR),
  });
  const mutations = new ObservedXeroMutationService(repository, {
    confirmationSecret: "p0-accounting-case-confirmation-secret-at-least-32-bytes",
    writeEnabled: true,
    authoritySnapshotResolver: new RepositoryLedgerAuthoritySnapshotResolver(repository),
    now: () => new Date(RUN_CLOCK_ANCHOR),
    providerCapabilityEvaluator: {
      evaluate: async (_effectiveContext, actionId) => ({
        allowed: true,
        denyReasons: [],
        receiptHash: hashObject({ actionId, provider: "xero", tenantId: TENANT_ID }),
      }),
    },
  }, counters);
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
      publicBaseUrl: "https://xero-mcp.p0-accounting-case.invalid",
      xeroWriteEnabled: true,
      xeroAllowedTenantId: TENANT_ID,
    },
    logger,
    connectionTickets: new ConnectionTicketService(repository, "https://xero-mcp.p0-accounting-case.invalid"),
    mutationFoundation: mutations,
  });
  const caseService = new XeroAccountingCaseService(repository, provider, accounting, mutations, {
    continuationSecret: CONTROLLED_WRITE_CONTINUATION_SECRET,
    testTenantIds: [TENANT_ID],
    businessAuthorityProfiles: BUSINESS_AUTHORITY_PROFILES,
    clock: () => new Date(RUN_CLOCK_ANCHOR),
  });
  const caseRuntime = {
    prepare: async (...args: Parameters<XeroAccountingCaseService["prepare"]>) => {
      counters.casePrepareCalls += 1;
      return caseService.prepare(...args);
    },
    execute: async (...args: Parameters<XeroAccountingCaseService["execute"]>) => {
      counters.caseExecuteCalls += 1;
      return caseService.execute(...args);
    },
    status: async (...args: Parameters<XeroAccountingCaseService["status"]>) => {
      counters.caseStatusCalls += 1;
      return caseService.status(...args);
    },
    listAttentionCases: async (...args: Parameters<XeroAccountingCaseService["listAttentionCases"]>) => {
      return caseService.listAttentionCases(...args);
    },
  };
  const server = createAccountingMcpServer(accounting, context, undefined, undefined, caseRuntime);
  const client = new Client({ name: "xero-p0-accounting-case", version: XERO_RELEASE_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport);

  const caseResults: OracleCaseResult[] = [];
  let finalCaseState: string | undefined;
  let finalOperationStates: string[] = [];
  try {
    const listedTools = (await client.listTools()).tools.map((tool) => tool.name);
    const surfaceRef = collector.add(surfaceScenario.id, "STATE_PROBE", "public-tool-surface", {
      release: XERO_RELEASE_VERSION,
      count: listedTools.length,
      tools: listedTools,
    });
    const legacyProbe = await callTool(client, collector, toolCalls, surfaceScenario.id, LEGACY_OBJECT_WRITE_TOOL, {
      preparation_id: `xmp_${"d".repeat(32)}`,
      request_id: "legacy-bypass-probe-001",
    });
    const injectionProbe = await callTool(client, collector, toolCalls, surfaceScenario.id, "xero_execute_accounting_case", {
      case_id: "contract-case-001",
      case_version: 1,
      request_id: "case-payload-injection-001",
      payload: { account_code: "999", amount: "999999.00" },
    });
    caseResults.push(caseResult(surfaceScenario, [
      oracle("exact_28_tools", sameStringSet(listedTools, TOOL_ALLOWLIST), {
        expectedCount: TOOL_ALLOWLIST.length,
        actualCount: listedTools.length,
      }, [surfaceRef], "The Agent-facing MCP surface must equal the reviewed 28-tool allowlist."),
      oracle("legacy_mutation_tools_absent", legacyProbe.observation.isError && !listedTools.includes(LEGACY_OBJECT_WRITE_TOOL), {
        advertised: listedTools.includes(LEGACY_OBJECT_WRITE_TOOL),
        directCallRejected: legacyProbe.observation.isError,
      }, legacyProbe.evidenceRefs, "An unadvertised object-level writer must remain uncallable."),
      oracle("execute_payload_injection_rejected", injectionProbe.observation.isError && counters.caseExecuteCalls === 0, {
        rejected: injectionProbe.observation.isError,
        caseServiceExecuteCalls: counters.caseExecuteCalls,
      }, injectionProbe.evidenceRefs, "Execute must reject Agent-supplied accounting payload before the Case service."),
    ], [surfaceRef, ...legacyProbe.evidenceRefs, ...injectionProbe.evidenceRefs]));

    const writesBeforePrepare = counters.providerWriteAttempts;
    const prepared = await callTool(
      client,
      collector,
      toolCalls,
      prepareScenario.id,
      "xero_prepare_accounting_case",
      prepareInput as JsonObject,
    );
    const preparedBody = resultBody(prepared.observation);
    const prepareStateRef = collector.add(prepareScenario.id, "REPOSITORY_STATE", "case-after-prepare", {
      case_id: preparedBody?.case_id ?? null,
      case_version: preparedBody?.case_version ?? null,
      state: preparedBody?.state ?? null,
      compiled_plan_hash: preparedBody?.compiled_plan_hash ?? null,
      providerWriteAttempts: counters.providerWriteAttempts,
    });
    const prepareClaim = preparedBody?.completion_claim as JsonObject | undefined;
    caseResults.push(caseResult(prepareScenario, [
      oracle("prepare_called_once", !prepared.observation.isError && counters.casePrepareCalls === 1, {
        isError: prepared.observation.isError,
        caseServicePrepareCalls: counters.casePrepareCalls,
      }, prepared.evidenceRefs, "The public Case prepare tool must call the Case service exactly once."),
      oracle("prepare_not_written", counters.providerWriteAttempts === writesBeforePrepare && prepareClaim?.ledger_write_claim === "NOT_WRITTEN", {
        providerWriteAttemptsBefore: writesBeforePrepare,
        providerWriteAttemptsAfter: counters.providerWriteAttempts,
        ledgerWriteClaim: prepareClaim?.ledger_write_claim ?? null,
      }, [...prepared.evidenceRefs, prepareStateRef], "Prepare must persist a plan but never claim or perform a Xero write."),
    ], [...prepared.evidenceRefs, prepareStateRef]));

    const caseId = String(preparedBody?.case_id ?? "");
    const caseVersion = Number(preparedBody?.case_version ?? 0);
    const executeInput = {
      case_id: caseId,
      case_version: caseVersion,
      request_id: "contract-case-execute-001",
    };
    const gateOpenRef = collector.add(executeScenario.id, "STATE_PROBE", "isolated-write-gate-open", { state: "OPEN" });
    writeGateOpen = true;
    let executed: Awaited<ReturnType<typeof callTool>>;
    try {
      executed = await callTool(client, collector, toolCalls, executeScenario.id, "xero_execute_accounting_case", executeInput);
    } finally {
      writeGateOpen = false;
    }
    const gateCloseRef = collector.add(executeScenario.id, "STATE_PROBE", "isolated-write-gate-close", { state: "CLOSED" });
    const executedBody = resultBody(executed.observation);
    const durableAfterExecute = await repository.getBoundAccountingCase({
      binding,
      caseId,
      version: caseVersion,
    });
    const durableOperation = durableAfterExecute?.operations[0];
    const durablePreparation = durableOperation?.preparationId
      ? await repository.getXeroMutationPreparation(durableOperation.preparationId)
      : undefined;
    const durableMutation = durableOperation?.mutationRequestId
      ? await repository.getXeroMutationRequest(durableOperation.mutationRequestId)
      : undefined;
    const receiptOperations = Array.isArray(durableAfterExecute?.preflightReceipt?.operations)
      ? durableAfterExecute.preflightReceipt.operations as JsonObject[]
      : [];
    const receiptOperation = receiptOperations.find((operation) =>
      operation.operationId === durableOperation?.operation.operationId);
    const durableMutationChecks = {
      recordsPresent: Boolean(durableOperation && durablePreparation && durableMutation && receiptOperation),
      operationReadbackVerified: durableOperation?.state === "READBACK_VERIFIED",
      preparationConsumed: durablePreparation?.state === "CONSUMED",
      mutationReadbackVerified: durableMutation?.state === "READBACK_VERIFIED",
      preparationIdentityBound: durableOperation?.preparationId === durablePreparation?.preparationId,
      mutationIdentityBound: durableOperation?.mutationRequestId === durableMutation?.mutationRequestId,
      preparationPayloadBound: durableOperation?.preparationCanonicalPayloadHash === durablePreparation?.canonicalPayloadHash,
      mutationPayloadBound: durableOperation?.preparationCanonicalPayloadHash === durableMutation?.canonicalPayloadHash,
      preparationSourceBound: durableOperation?.sourceSha256 === durablePreparation?.sourceSha256,
      mutationSourceBound: durableOperation?.sourceSha256 === durableMutation?.sourceSha256,
      receiptPreparationBound: receiptOperation?.preparationId === durablePreparation?.preparationId,
      receiptOperationPayloadBound:
        receiptOperation?.operationCanonicalPayloadHash === durableOperation?.operation.canonicalPayloadHash,
      receiptPreparationPayloadBound:
        receiptOperation?.preparationCanonicalPayloadHash === durablePreparation?.canonicalPayloadHash,
      receiptSourceBound: receiptOperation?.sourceSha256 === durablePreparation?.sourceSha256,
      exactProviderObjectBound: durableMutation?.xeroObjectId === INVOICE_ID,
      providerReceiptBound:
        (durableMutation?.writeReceipt?.providerReceipt as JsonObject | undefined)?.providerRequestId ===
          "provider-request-case-001",
      readbackObjectBound: durableMutation?.readbackSnapshot?.xeroObjectId === INVOICE_ID,
    };
    const durableMutationLinked = Object.values(durableMutationChecks).every(Boolean);
    const durablePreflightRef = collector.add(executeScenario.id, "REPOSITORY_STATE", "durable-case-preflight-receipt", {
      state: durableAfterExecute?.state ?? null,
      preflightRequestId: durableAfterExecute?.preflightRequestId ?? null,
      preflightReceiptHash: durableAfterExecute?.preflightReceiptHash ?? null,
      preflightReceipt: durableAfterExecute?.preflightReceipt ?? null,
    });
    const durableMutationRef = collector.add(executeScenario.id, "REPOSITORY_STATE", "durable-mutation-projection", {
      linked: durableMutationLinked,
      operationState: durableOperation?.state ?? null,
      preparationState: durablePreparation?.state ?? null,
      mutationState: durableMutation?.state ?? null,
      preparationId: durablePreparation?.preparationId ?? null,
      mutationRequestId: durableMutation?.mutationRequestId ?? null,
      xeroObjectId: durableMutation?.xeroObjectId ?? null,
      checks: durableMutationChecks,
    });
    const providerRef = collector.add(executeScenario.id, "PROVIDER_CALL", "provider-write-attempts", {
      count: counters.providerWriteAttempts,
      unreleasedStateActionAttempts: 0,
      paymentAttempts: 0,
    });
    const providerRecordRef = collector.add(executeScenario.id, "PROVIDER_RECORD", "provider-receipt-and-exact-readback", {
      records: counters.providerRecords,
    });
    const preflightsAfterInitialExecute = structuredClone(counters.writeGatePreflights);
    const replay = await callTool(client, collector, toolCalls, executeScenario.id, "xero_execute_accounting_case", executeInput);
    const status = await callTool(client, collector, toolCalls, executeScenario.id, "xero_get_accounting_case_status", {
      case_id: caseId,
      case_version: caseVersion,
    });
    const statusBody = resultBody(status.observation);
    finalCaseState = typeof statusBody?.state === "string" ? statusBody.state : undefined;
    finalOperationStates = Array.isArray(statusBody?.operations)
      ? (statusBody.operations as JsonObject[])
        .map((operation) => operation.state)
        .filter((state): state is string => typeof state === "string")
      : [];
    const executedClaim = executedBody?.completion_claim as JsonObject | undefined;
    const executedOperations = Array.isArray(executedBody?.operations) ? executedBody.operations as JsonObject[] : [];
    const readbackVerified = executedOperations.length === 1 && executedOperations.every((operation) =>
      operation.state === "READBACK_VERIFIED" &&
      operation.provider_receipt_recorded === true &&
      operation.exact_readback_recorded === true &&
      operation.xero_object_id === INVOICE_ID);
    const executionRefs = [
      gateOpenRef,
      ...executed.evidenceRefs,
      gateCloseRef,
      durablePreflightRef,
      durableMutationRef,
      providerRef,
      providerRecordRef,
      ...replay.evidenceRefs,
      ...status.evidenceRefs,
    ];
    caseResults.push(caseResult(executeScenario, [
      oracle("execute_identity_only", Object.keys(executeInput).sort().join(",") === "case_id,case_version,request_id", {
        keys: Object.keys(executeInput).sort(),
      }, executed.evidenceRefs, "Execute must receive only immutable Case and idempotent request identity."),
      oracle("write_gate_preflight", preflightsAfterInitialExecute.length === 1 &&
        preflightsAfterInitialExecute[0]?.includes("customer_invoice.create_draft") === true &&
        durableAfterExecute?.preflightReceiptHash?.length === 64 &&
        (durableAfterExecute.preflightReceipt?.authorityReceipt as JsonObject | undefined)?.bindingRevision === 1, {
        preflights: preflightsAfterInitialExecute,
        durableReceiptHash: durableAfterExecute?.preflightReceiptHash ?? null,
        bindingRevision:
          (durableAfterExecute?.preflightReceipt?.authorityReceipt as JsonObject | undefined)?.bindingRevision ?? null,
      }, [durablePreflightRef, providerRef], "The full stored plan must persist the OAuth target, released typed action and write-gate preflight receipt before writing."),
      oracle("durable_mutation_projection", durableMutationLinked, {
        linked: durableMutationLinked,
        operationState: durableOperation?.state ?? null,
        preparationState: durablePreparation?.state ?? null,
        mutationState: durableMutation?.state ?? null,
        checks: durableMutationChecks,
      }, [durablePreflightRef, durableMutationRef, providerRecordRef],
      "Terminal Case evidence must be projected from one fully bound durable Xero preparation and mutation request."),
      oracle("terminal_requires_receipt_and_readback", !executed.observation.isError &&
        executedBody?.state === "TERMINAL" &&
        executedClaim?.ledger_write_claim === "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" &&
        readbackVerified && counters.providerRecords.length === 1, {
        state: executedBody?.state ?? null,
        ledgerWriteClaim: executedClaim?.ledger_write_claim ?? null,
        readbackVerified,
        providerRecords: counters.providerRecords.length,
      }, [providerRecordRef, ...executed.evidenceRefs], "Success requires one provider receipt and exact same-ID readback."),
      oracle("same_request_idempotent_replay", !replay.observation.isError && counters.providerWriteAttempts === 1 &&
        counters.caseExecuteCalls === 2, {
        caseServiceExecuteCalls: counters.caseExecuteCalls,
        providerWriteAttempts: counters.providerWriteAttempts,
      }, replay.evidenceRefs, "The same execution request must replay terminal evidence without another provider write."),
      oracle("status_preserves_terminal_evidence", !status.observation.isError && statusBody?.state === "TERMINAL" &&
        (statusBody?.completion_claim as JsonObject | undefined)?.ledger_write_claim === "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED", {
        state: statusBody?.state ?? null,
        ledgerWriteClaim: (statusBody?.completion_claim as JsonObject | undefined)?.ledger_write_claim ?? null,
      }, status.evidenceRefs, "Case status must preserve the receipt/readback-bounded terminal claim."),
      oracle("write_gate_closed_after_run", writeGateOpen === false, { state: writeGateOpen ? "OPEN" : "CLOSED" },
        [gateCloseRef], "The isolated synthetic write gate must close after execution."),
    ], executionRefs));
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }

  const finishedAt = new Date();
  const report = oracleRunSchema.parse({
    schema_version: "1.0",
    run_id: runId,
    suite_id: manifest.suite_id,
    layer: manifest.layer,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    environment: {
      target: "IN_MEMORY",
      data_class: "SYNTHETIC_ONLY",
      write_gate_start: "CLOSED",
      write_gate_end: writeGateOpen ? "OPEN" : "CLOSED",
      secrets_redacted: true,
      mcp_server_version: XERO_RELEASE_VERSION,
      oauth_binding_fingerprint: "synthetic-exact-binding-v7",
    },
    case_results: caseResults,
    summary: statusSummary(caseResults),
    claim_guardrail_violations: [],
  });
  const result: ExecuteP0AccountingCaseResult = {
    report,
    evidence: collector.records,
    providerWriteAttempts: counters.providerWriteAttempts,
    providerRecords: counters.providerRecords,
    writeGatePreflights: counters.writeGatePreflights,
    toolCalls,
    ...(finalCaseState ? { finalCaseState } : {}),
    finalOperationStates,
  };
  if (options.writeArtifacts !== false) {
    const outputDirectory = options.outputDirectory ?? resolve(repoRoot, "artifacts/harness-runs", runId, "p0-accounting-case");
    await mkdir(outputDirectory, { recursive: true });
    const paths = {
      oracleResults: resolve(outputDirectory, "oracle-results.json"),
      evidence: resolve(outputDirectory, "evidence.jsonl"),
      providerRecords: resolve(outputDirectory, "provider-records.json"),
      summary: resolve(outputDirectory, "summary.md"),
    };
    await Promise.all([
      writeFile(paths.oracleResults, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
      writeFile(paths.evidence, `${collector.records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
      writeFile(paths.providerRecords, `${JSON.stringify(counters.providerRecords, null, 2)}\n`, "utf8"),
      writeFile(paths.summary, summaryMarkdown(report, counters), "utf8"),
    ]);
    result.artifactPaths = paths;
  }
  return result;
}

export interface StartLocalAgentAccountingCaseMcpOptions {
  auditPath: string;
}

type LocalAgentDurableEvidence = {
  case_id: string;
  case_version: number;
  compiled_plan_hash: string;
  case_state: string;
  operation_id: string;
  operation_state: string;
  provider_object_id: string;
  mutation_request_id: string;
  mutation_receipt_id: string;
  exact_readback_receipt_id: string;
  evidence_chain_hash: string;
  write_receipt: Record<string, unknown>;
  exact_readback: Record<string, unknown>;
};

/**
 * Starts the current Accounting Case stack over a real MCP STDIO transport for
 * a local Codex Agent acceptance run. The only fake is P0XeroProviderFake at
 * the AccountingProvider/Xero SDK boundary; the Case, Accounting and Mutation
 * services, durable projections, OAuth-target/write-gate preflight and one-shot
 * provider permit are the production implementations.
 */
export async function startLocalAgentAccountingCaseMcp(
  options: StartLocalAgentAccountingCaseMcpOptions,
): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const counters: RuntimeCounters = {
    casePrepareCalls: 0,
    caseExecuteCalls: 0,
    caseStatusCalls: 0,
    writeGatePreflights: [],
    providerWriteAttempts: 0,
    providerRecords: [],
    auditTools: [],
  };
  let writeGateOpen = false;
  const context = requestContext();
  if (context.targetSessionId || context.targetSessionHash || context.targetSessionExpiresAt) {
    throw new Error("LOCAL_AGENT_BASE_CONTEXT_MUST_BE_UNPINNED");
  }
  const identity = {
    actorId: context.actorId,
    workspaceId: context.workspaceId!,
    subjectType: context.subjectType!,
    subjectId: context.subjectId!,
    agentId: context.agentId!,
    installationId: context.oauthInstallationId!,
    bindingId: context.bindingId!,
    bindingRevision: context.bindingRevision!,
    connectionId: context.connectionId!,
    tenantId: TENANT_ID,
  };
  const repository = new InMemoryAccountingRepository();
  await repository.saveProviderAuthorization({
    authorizationId: AUTHORIZATION_ID,
    workspaceId: identity.workspaceId,
    authorizedBySubject: identity.subjectId,
    provider: "xero",
    providerSubject: "local-agent-evidence-xero-user",
    grantedScopes: ["accounting.transactions", "accounting.contacts", "accounting.settings.read"],
    tokenCiphertext: "encrypted-local-agent-evidence-token",
    tokenExpiresAt: new Date(RUN_CLOCK_ANCHOR.getTime() + 4 * 60 * 60_000),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  await repository.upsertAuthorizedProviderConnection(identity.workspaceId, {
    connectionId: identity.connectionId,
    authorizationId: AUTHORIZATION_ID,
    provider: "xero",
    providerConnectionId: "local-agent-evidence-provider-connection",
    tenantId: TENANT_ID,
    tenantName: "Synthetic Case Company",
    status: "ACTIVE",
    lastVerifiedAt: TARGET_SESSION_CREATED_AT,
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  await repository.saveOAuthInstallation({
    installationId: identity.installationId,
    workspaceId: identity.workspaceId,
    subjectType: identity.subjectType,
    subjectId: identity.subjectId,
    agentId: identity.agentId,
    clientId: "local-agent-evidence-client",
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  await repository.saveAgentConnectionBinding({
    bindingId: identity.bindingId,
    installationId: identity.installationId,
    workspaceId: identity.workspaceId,
    subjectType: identity.subjectType,
    subjectId: identity.subjectId,
    agentId: identity.agentId,
    connectionId: identity.connectionId,
    policyId: POLICY_ID,
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  const authorityPublication = await repository.publishLedgerAuthoritySnapshot({
    providerId: "xero",
    revision: 1,
    writeKillSwitchEnabled: true,
    standingDelegations: [],
    publishedAt: new Date(RUN_CLOCK_ANCHOR),
  });
  // Real evidence, not a plausible fake: the in-memory repository computes
  // both fields for real from the snapshot just published above and the
  // Accounting Cases actually stored (see InMemoryAccountingRepository's own
  // readinessEvidence, which the production /readyz route also calls).
  const attestationReadiness = await repository.readinessEvidence(XERO_RELEASE_ATTESTATION.requiredMigration);

  const provider = new P0XeroProviderFake(counters, "not-prepared", () => writeGateOpen, "NONE");
  const mutations = new ObservedXeroMutationService(repository, {
    confirmationSecret: "local-agent-evidence-confirmation-secret-at-least-32-bytes",
    writeEnabled: true,
    authoritySnapshotResolver: new RepositoryLedgerAuthoritySnapshotResolver(repository),
    now: () => new Date(RUN_CLOCK_ANCHOR),
    providerCapabilityEvaluator: {
      evaluate: async (_effectiveContext, actionId) => ({
        allowed: true,
        denyReasons: [],
        receiptHash: hashObject({ actionId, provider: "xero", tenantId: TENANT_ID }),
      }),
    },
  }, counters);
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
      publicBaseUrl: "https://xero-mcp.local-agent-evidence.invalid",
      xeroWriteEnabled: true,
      xeroAllowedTenantId: TENANT_ID,
    },
    logger,
    connectionTickets: new ConnectionTicketService(repository, "https://xero-mcp.local-agent-evidence.invalid"),
    mutationFoundation: mutations,
  });
  const caseService = new XeroAccountingCaseService(repository, provider, accounting, mutations, {
    continuationSecret: LOCAL_AGENT_CONTINUATION_SECRET,
    testTenantIds: [TENANT_ID],
    businessAuthorityProfiles: BUSINESS_AUTHORITY_PROFILES,
    clock: () => new Date(RUN_CLOCK_ANCHOR),
  });
  const targetSessions = new LedgerTargetSessionService({
    repository,
    secret: Buffer.from("local-agent-ledger-target-secret-v1"),
    required: true,
    ttlMs: 2 * 60 * 60_000,
    clock: () => new Date(RUN_CLOCK_ANCHOR),
    referenceFactory: () => `xts_${Buffer.alloc(32, 13).toString("base64url")}`,
    sessionIdFactory: () => "local-agent-pinned-target-session",
  });
  let runtimeBinding: AccountingCaseBinding | undefined;

  const audit: {
    schema_version: "1.0";
    evidence_boundary: "LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY";
    release_version: string;
    server_pid: number;
    started_at: string;
    mcp_protocol_calls: LocalAgentMcpProtocolCall[];
    tool_calls: Array<Record<string, unknown>>;
    target_session_evidence: {
      status: "PENDING" | "PASS";
      issuance_tool: "xero_pin_current_organisation";
      verification_tool: "xero_get_organisation";
      base_context_unpinned: true;
      required_by_server: true;
      raw_capability_persisted_in_server_audit: false;
      binding_scope: "OAUTH_INSTALLATION_PRINCIPAL_AND_IMMUTABLE_BINDING_CAPABILITY";
      conversation_binding: "NOT_CLAIMED_NO_TRUSTED_SERVER_CONVERSATION_ID";
      target_session_ref_hash: string | null;
      target_ref_safe: string | null;
      binding_revision: number | null;
    };
    provider_write_count: number;
    provider_records: ProviderRecord[];
    write_gate_preflights: string[][];
    release_attestation: typeof XERO_RELEASE_ATTESTATION;
    release_attestation_hash: string;
    runtime_attestation: ReturnType<typeof createXeroRuntimeAttestation>;
    runtime_attestation_hash: string;
    durable_evidence?: LocalAgentDurableEvidence;
  } = {
    schema_version: "1.0",
    evidence_boundary: "LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY",
    release_version: XERO_RELEASE_VERSION,
    server_pid: process.pid,
    started_at: new Date().toISOString(),
    mcp_protocol_calls: [],
    tool_calls: [],
    target_session_evidence: {
      status: "PENDING",
      issuance_tool: "xero_pin_current_organisation",
      verification_tool: "xero_get_organisation",
      base_context_unpinned: true,
      required_by_server: true,
      raw_capability_persisted_in_server_audit: false,
      binding_scope: "OAUTH_INSTALLATION_PRINCIPAL_AND_IMMUTABLE_BINDING_CAPABILITY",
      conversation_binding: "NOT_CLAIMED_NO_TRUSTED_SERVER_CONVERSATION_ID",
      target_session_ref_hash: null,
      target_ref_safe: null,
      binding_revision: null,
    },
    provider_write_count: 0,
    provider_records: [],
    write_gate_preflights: [],
    release_attestation: XERO_RELEASE_ATTESTATION,
    release_attestation_hash: hashObject(XERO_RELEASE_ATTESTATION),
    runtime_attestation: createXeroRuntimeAttestation({
      buildIdentityHash: null,
      acceptanceSourceSha256: null,
      sourceArchiveSha256: null,
      writeMode: "WRITE_ENABLED",
      processWriteGateEnabled: true,
      authoritySnapshotRevision: authorityPublication.snapshot.revision,
      authoritySnapshotHash: authorityPublication.snapshot.snapshotHash,
      authorityWriteKillSwitchEnabled: authorityPublication.snapshot.writeKillSwitchEnabled,
      storageMode: "IN_MEMORY",
      repositoryReady: true,
      requiredMigration: XERO_RELEASE_ATTESTATION.requiredMigration,
      requiredMigrationStatus: "NOT_APPLICABLE",
      migrationHead: null,
      activeAccountingCaseRecoveryProjection: attestationReadiness.activeAccountingCaseRecoveryProjection,
    }),
    runtime_attestation_hash: "",
  };
  audit.runtime_attestation_hash = hashObject(audit.runtime_attestation);

  async function durableEvidence(caseId: string, version: number): Promise<LocalAgentDurableEvidence | undefined> {
    if (!runtimeBinding) return undefined;
    const record = await repository.getBoundAccountingCase({ binding: runtimeBinding, caseId, version });
    const operation = record?.operations[0];
    const mutation = operation?.mutationRequestId
      ? await repository.getXeroMutationRequest(operation.mutationRequestId)
      : undefined;
    if (!record || !operation || !mutation?.writeReceipt || !mutation.readbackSnapshot || !mutation.xeroObjectId) {
      return undefined;
    }
    const mutationReceiptId = `xwr_${hashObject(mutation.writeReceipt).slice(0, 32)}`;
    const exactReadbackReceiptId = `xrb_${hashObject(mutation.readbackSnapshot).slice(0, 32)}`;
    const chain = {
      caseId,
      version,
      compiledPlanHash: record.compiledPlanHash,
      operationId: operation.operation.operationId,
      operationState: operation.state,
      providerObjectId: mutation.xeroObjectId,
      mutationRequestId: mutation.mutationRequestId,
      mutationReceiptId,
      exactReadbackReceiptId,
      writeReceipt: mutation.writeReceipt,
      exactReadback: mutation.readbackSnapshot,
    };
    return {
      case_id: caseId,
      case_version: version,
      compiled_plan_hash: record.compiledPlanHash,
      case_state: record.state,
      operation_id: operation.operation.operationId,
      operation_state: operation.state,
      provider_object_id: mutation.xeroObjectId,
      mutation_request_id: mutation.mutationRequestId,
      mutation_receipt_id: mutationReceiptId,
      exact_readback_receipt_id: exactReadbackReceiptId,
      evidence_chain_hash: hashObject(chain),
      write_receipt: structuredClone(mutation.writeReceipt),
      exact_readback: structuredClone(mutation.readbackSnapshot),
    };
  }

  async function persistAudit(): Promise<void> {
    audit.provider_write_count = counters.providerWriteAttempts;
    audit.provider_records = structuredClone(counters.providerRecords);
    audit.write_gate_preflights = structuredClone(counters.writeGatePreflights);
    await mkdir(dirname(options.auditPath), { recursive: true });
    await writeFile(options.auditPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  const pendingProtocolCalls = new Map<string, Omit<LocalAgentMcpProtocolCall,
    "finished_at" | "status" | "raw_structured_result" | "error">>();
  const protocolCallKey = (value: string | number) => `${typeof value}:${String(value)}`;
  const expectedProtocolTools = new Set([
    "xero_pin_current_organisation",
    "xero_get_organisation",
    "xero_prepare_accounting_case",
    "xero_execute_accounting_case",
    "xero_get_accounting_case_status",
  ]);
  const containsCredential = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsCredential);
    if (!value || typeof value !== "object") return false;
    const forbidden = /^(?:access_token|refresh_token|token|authorization|secret|password|tenant_id|tenantId)$/u;
    return Object.entries(value).some(([key, child]) => forbidden.test(key) || containsCredential(child));
  };
  const protocolObserver: LocalAgentProtocolObserver = {
    receive(message) {
      const request = message as unknown as {
        id?: string | number;
        method?: string;
        params?: { name?: unknown; arguments?: unknown };
      };
      if (request.method !== "tools/call" ||
          (typeof request.id !== "string" && typeof request.id !== "number") ||
          typeof request.params?.name !== "string" ||
          !expectedProtocolTools.has(request.params.name)) return;
      const publicArguments = request.params.arguments;
      if (!publicArguments || typeof publicArguments !== "object" || Array.isArray(publicArguments) ||
          containsCredential(publicArguments)) {
        throw new Error("LOCAL_AGENT_PUBLIC_PROTOCOL_ARGUMENTS_UNSAFE");
      }
      const rawTargetRef = (publicArguments as JsonObject).target_session_ref;
      if (rawTargetRef !== undefined &&
          (typeof rawTargetRef !== "string" || !/^xts_[A-Za-z0-9_-]{43}$/u.test(rawTargetRef))) {
        throw new Error("LOCAL_AGENT_PUBLIC_TARGET_SESSION_REF_INVALID");
      }
      const key = protocolCallKey(request.id);
      if (pendingProtocolCalls.has(key) || audit.mcp_protocol_calls.some((call) =>
        protocolCallKey(call.jsonrpc_id) === key)) {
        throw new Error("LOCAL_AGENT_JSONRPC_CALL_ID_REUSED");
      }
      pendingProtocolCalls.set(key, {
        jsonrpc_id: request.id,
        method: "tools/call",
        tool: request.params.name,
        public_arguments: redactTargetSessionRefs(publicArguments) as JsonObject,
        target_session_ref_hash: typeof rawTargetRef === "string" ? targetSessionRefHash(rawTargetRef) : null,
        started_at: new Date().toISOString(),
      });
    },
    async send(message) {
      const response = message as unknown as {
        id?: string | number;
        result?: unknown;
        error?: unknown;
      };
      if (typeof response.id !== "string" && typeof response.id !== "number") return;
      const key = protocolCallKey(response.id);
      const pending = pendingProtocolCalls.get(key);
      if (!pending) return;
      pendingProtocolCalls.delete(key);
      const hasError = response.error !== undefined;
      const issuedTargetRef = pending.tool === "xero_pin_current_organisation"
        ? targetSessionRefFrom(response.result)
        : undefined;
      const effectiveTargetHash = pending.target_session_ref_hash ??
        (issuedTargetRef ? targetSessionRefHash(issuedTargetRef) : null);
      audit.mcp_protocol_calls.push({
        ...pending,
        target_session_ref_hash: effectiveTargetHash,
        finished_at: new Date().toISOString(),
        status: hasError ? "FAIL" : "PASS",
        raw_structured_result: hasError ? null : redactTargetSessionRefs(response.result ?? null),
        error: hasError ? redactTargetSessionRefs(response.error) : null,
      });
      await persistAudit();
    },
  };

  const targetHashBySessionId = new Map<string, string>();

  async function captureCall<T>(
    tool: string,
    input: unknown,
    effectiveContext: RequestContext,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const serverCallId = `local_mcp_${hashObject({ tool, input, sequence: audit.tool_calls.length + 1 }).slice(0, 24)}`;
    try {
      const result = await action();
      const issuedTargetRef = tool === "xero_pin_current_organisation"
        ? targetSessionRefFrom(result)
        : undefined;
      const targetRefHash = issuedTargetRef
        ? targetSessionRefHash(issuedTargetRef)
        : effectiveContext.targetSessionId
          ? targetHashBySessionId.get(effectiveContext.targetSessionId) ?? null
          : null;
      if (effectiveContext.targetSessionId && effectiveContext.targetSessionHash &&
          effectiveContext.targetSessionExpiresAt) {
        runtimeBinding = {
          actorId: effectiveContext.actorId,
          workspaceId: effectiveContext.workspaceId!,
          subjectType: effectiveContext.subjectType!,
          subjectId: effectiveContext.subjectId!,
          agentId: effectiveContext.agentId!,
          installationId: effectiveContext.oauthInstallationId!,
          bindingId: effectiveContext.bindingId!,
          bindingRevision: effectiveContext.bindingRevision!,
          connectionId: effectiveContext.connectionId!,
          tenantId: TENANT_ID,
          targetSessionId: effectiveContext.targetSessionId,
          targetSessionHash: effectiveContext.targetSessionHash,
          targetSessionExpiresAt: effectiveContext.targetSessionExpiresAt,
        };
      }
      const projection = result as { case_id?: unknown; case_version?: unknown };
      if (typeof projection.case_id === "string" && Number.isInteger(projection.case_version)) {
        const evidence = await durableEvidence(projection.case_id, Number(projection.case_version));
        if (evidence !== undefined) {
          audit.durable_evidence = evidence;
        }
      }
      audit.tool_calls.push({
        server_call_id: serverCallId,
        tool,
        normalized_input: structuredClone(input),
        target_session_ref_hash: targetRefHash,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: "PASS",
        result: redactTargetSessionRefs(result),
      });
      if (tool === "xero_pin_current_organisation" && issuedTargetRef &&
          result && typeof result === "object" && !Array.isArray(result)) {
        const issued = result as Record<string, unknown>;
        audit.target_session_evidence.target_session_ref_hash = targetRefHash;
        audit.target_session_evidence.target_ref_safe = typeof issued.target_ref_safe === "string"
          ? issued.target_ref_safe
          : null;
        audit.target_session_evidence.binding_revision = typeof issued.binding_revision === "number"
          ? issued.binding_revision
          : null;
      }
      if (tool === "xero_get_organisation" && targetRefHash &&
          targetRefHash === audit.target_session_evidence.target_session_ref_hash) {
        audit.target_session_evidence.status = "PASS";
      }
      await persistAudit();
      return result;
    } catch (error) {
      audit.tool_calls.push({
        server_call_id: serverCallId,
        tool,
        normalized_input: structuredClone(input),
        target_session_ref_hash: effectiveContext.targetSessionId
          ? targetHashBySessionId.get(effectiveContext.targetSessionId) ?? null
          : null,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: "FAIL",
        error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
      });
      await persistAudit();
      throw error;
    }
  }

  const caseRuntime = {
    prepare: async (...args: Parameters<XeroAccountingCaseService["prepare"]>) => {
      counters.casePrepareCalls += 1;
      provider.setEvidenceCaseId(args[1].case_id);
      return captureCall("xero_prepare_accounting_case", args[1], args[0], () => caseService.prepare(...args));
    },
    execute: async (...args: Parameters<XeroAccountingCaseService["execute"]>) => {
      counters.caseExecuteCalls += 1;
      return captureCall("xero_execute_accounting_case", args[1], args[0], async () => {
        writeGateOpen = true;
        try {
          return await caseService.execute(...args);
        } finally {
          writeGateOpen = false;
        }
      });
    },
    status: async (...args: Parameters<XeroAccountingCaseService["status"]>) => {
      counters.caseStatusCalls += 1;
      return captureCall("xero_get_accounting_case_status", args[1], args[0], () => caseService.status(...args));
    },
    listAttentionCases: async (...args: Parameters<XeroAccountingCaseService["listAttentionCases"]>) => {
      return captureCall("xero_list_accounting_cases", {}, args[0], () => caseService.listAttentionCases(...args));
    },
  };
  const observedTargetSessions = {
    required: true,
    issue: (principal: RequestContext) => captureCall(
      "xero_pin_current_organisation",
      {},
      principal,
      () => targetSessions.issue(principal),
    ),
    resolve: async (principal: RequestContext, targetSessionRef: string | undefined) => {
      const resolved = await targetSessions.resolve(principal, targetSessionRef);
      if (targetSessionRef && resolved.targetSessionId) {
        targetHashBySessionId.set(resolved.targetSessionId, targetSessionRefHash(targetSessionRef));
      }
      return resolved;
    },
  };
  const observedAccounting = new Proxy(accounting, {
    get(target, property) {
      if (property === "getOrganisation") {
        return (principal: RequestContext) => captureCall(
          "xero_get_organisation",
          {},
          principal,
          () => target.getOrganisation(principal),
        );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // Production parity: the trusted base principal is unpinned. The Agent must
  // acquire one opaque target via the public pin tool, verify it, then present
  // that same capability to every ledger call. No client header is accepted as
  // a conversation identity; the proven scope is OAuth principal/installation
  // plus the immutable target capability and binding.
  const server = createAccountingMcpServer(
    observedAccounting,
    context,
    undefined,
    observedTargetSessions,
    caseRuntime,
  );
  await persistAudit();
  await server.connect(new AuditedLocalAgentTransport(new StdioServerTransport(), protocolObserver));
}

export interface LocalAgentTargetSessionNegativeSuiteResult {
  providerWriteAttempts: number;
  cases: Array<{ scenario: string; status: "PASS" }>;
  conversationBindingResidual: "NO_TRUSTED_SERVER_CONVERSATION_ID_AVAILABLE";
}

/**
 * Direct MCP-boundary falsification for the local-Agent target contract. The
 * execute adapter is deliberately reduced to one counter: every scenario must
 * be rejected by the production target-session resolver before that adapter
 * can be reached.
 */
export async function executeLocalAgentTargetSessionNegativeSuite(
): Promise<LocalAgentTargetSessionNegativeSuiteResult> {
  const repository = new InMemoryAccountingRepository();
  const baseContext = requestContext();
  let currentTime = new Date(RUN_CLOCK_ANCHOR);
  let targetSequence = 0;
  let providerWriteAttempts = 0;
  const identity = {
    workspaceId: baseContext.workspaceId!,
    subjectType: baseContext.subjectType!,
    subjectId: baseContext.subjectId!,
    agentId: baseContext.agentId!,
    installationId: baseContext.oauthInstallationId!,
    bindingId: baseContext.bindingId!,
    connectionId: baseContext.connectionId!,
  };
  await repository.saveProviderAuthorization({
    authorizationId: AUTHORIZATION_ID,
    workspaceId: identity.workspaceId,
    authorizedBySubject: identity.subjectId,
    provider: "xero",
    providerSubject: "local-agent-negative-xero-user",
    grantedScopes: ["accounting.transactions", "accounting.settings.read"],
    tokenCiphertext: "encrypted-local-agent-negative-token",
    tokenExpiresAt: new Date(RUN_CLOCK_ANCHOR.getTime() + 4 * 60 * 60_000),
    refreshVersion: 0,
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  for (const [connectionId, tenantId, tenantName] of [
    [identity.connectionId, TENANT_ID, "Synthetic Case Company"],
    ["local-agent-negative-connection-b", "55555555-5555-4555-8555-555555555555", "Switched Company"],
  ] as const) {
    await repository.upsertAuthorizedProviderConnection(identity.workspaceId, {
      connectionId,
      authorizationId: AUTHORIZATION_ID,
      provider: "xero",
      providerConnectionId: `provider-${connectionId}`,
      tenantId,
      tenantName,
      status: "ACTIVE",
      lastVerifiedAt: TARGET_SESSION_CREATED_AT,
      createdAt: TARGET_SESSION_CREATED_AT,
      updatedAt: TARGET_SESSION_CREATED_AT,
    });
  }
  await repository.saveOAuthInstallation({
    installationId: identity.installationId,
    workspaceId: identity.workspaceId,
    subjectType: identity.subjectType,
    subjectId: identity.subjectId,
    agentId: identity.agentId,
    clientId: "local-agent-negative-client",
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  await repository.saveAgentConnectionBinding({
    bindingId: identity.bindingId,
    installationId: identity.installationId,
    workspaceId: identity.workspaceId,
    subjectType: identity.subjectType,
    subjectId: identity.subjectId,
    agentId: identity.agentId,
    connectionId: identity.connectionId,
    policyId: POLICY_ID,
    status: "ACTIVE",
    createdAt: TARGET_SESSION_CREATED_AT,
    updatedAt: TARGET_SESSION_CREATED_AT,
  });
  const targets = new LedgerTargetSessionService({
    repository,
    secret: Buffer.from("local-agent-negative-target-secret-v1"),
    required: true,
    ttlMs: 60_000,
    clock: () => new Date(currentTime),
    referenceFactory: () => {
      targetSequence += 1;
      return `xts_${Buffer.alloc(32, targetSequence).toString("base64url")}`;
    },
    sessionIdFactory: () => `local-agent-negative-target-${targetSequence}`,
  });
  const service = {
    withAudit: async <T>(options: {
      principal?: RequestContext;
      action: () => Promise<T>;
      onResolvedContext?: (resolved: ActorTenantContext | undefined) => void;
      skipTenantResolution?: boolean;
    }): Promise<T> => {
      if (!options.skipTenantResolution) {
        options.onResolvedContext?.({
          actorId: options.principal?.actorId ?? baseContext.actorId,
          tenantId: TENANT_ID,
          tenantName: "Synthetic Case Company",
        });
      }
      return options.action();
    },
    getOrganisation: async () => ({
      organisationId: TENANT_ID,
      name: "Synthetic Case Company",
      countryCode: "SG",
      baseCurrency: "SGD",
      organisationStatus: "ACTIVE",
    }),
  } as unknown as AccountingService;
  const caseRuntime = {
    prepare: async () => ({ state: "PLANNED_NEEDS_PREFLIGHT" }),
    execute: async () => {
      providerWriteAttempts += 1;
      return { state: "TERMINAL" };
    },
    status: async () => ({ state: "TERMINAL" }),
    listAttentionCases: async () => ({ cases: [], has_more: false }),
  } as unknown as Pick<XeroAccountingCaseService, "prepare" | "execute" | "status" | "listAttentionCases">;

  const call = async (
    scenarioContext: RequestContext,
    tool: string,
    args: JsonObject,
  ): Promise<void> => {
    const server = createAccountingMcpServer(
      service,
      scenarioContext,
      undefined,
      targets,
      caseRuntime,
    );
    const client = new Client({ name: "local-agent-target-negative", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport as unknown as Transport);
      await client.connect(clientTransport);
      const response = await client.callTool({ name: tool, arguments: args });
      if (response.isError !== true) throw new Error(`LOCAL_AGENT_NEGATIVE_DID_NOT_FAIL:${tool}`);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
  const executeArgs = (targetSessionRef?: string): JsonObject => ({
    ...(targetSessionRef ? { target_session_ref: targetSessionRef } : {}),
    case_id: "local-agent-negative-case",
    case_version: 1,
    request_id: "local-agent-negative-execute",
  });
  const cases: LocalAgentTargetSessionNegativeSuiteResult["cases"] = [];
  const pass = async (scenario: string, action: () => Promise<void>) => {
    const writesBefore = providerWriteAttempts;
    await action();
    if (providerWriteAttempts !== writesBefore) {
      throw new Error(`LOCAL_AGENT_NEGATIVE_REACHED_PROVIDER:${scenario}`);
    }
    cases.push({ scenario, status: "PASS" });
  };

  const valid = await targets.issue(baseContext);
  await pass("MISSING_TARGET_SESSION_REF", () => call(baseContext, "xero_execute_accounting_case", executeArgs()));
  await pass("WRONG_ACTOR_TARGET_SESSION_REF", () => call(Object.freeze({
    ...baseContext,
    actorId: "wrong-actor",
  }), "xero_execute_accounting_case", executeArgs(valid.target_session_ref)));
  await pass("WRONG_WORKSPACE_TARGET_SESSION_REF", () => call(Object.freeze({
    ...baseContext,
    workspaceId: "wrong-workspace",
    actorId: `wrong-workspace:${identity.subjectType.toLowerCase()}:${identity.subjectId}`,
  }), "xero_execute_accounting_case", executeArgs(valid.target_session_ref)));
  await pass("WRONG_INSTALLATION_TARGET_SESSION_REF", () => call(Object.freeze({
    ...baseContext,
    oauthInstallationId: "wrong-installation",
  }), "xero_execute_accounting_case", executeArgs(valid.target_session_ref)));
  await pass("STALE_BINDING_REVISION_PIN", () => call(Object.freeze({
    ...baseContext,
    bindingRevision: baseContext.bindingRevision! + 1,
  }), "xero_pin_current_organisation", {}));

  const expired = await targets.issue(baseContext);
  currentTime = new Date(RUN_CLOCK_ANCHOR.getTime() + 60_001);
  await pass("EXPIRED_TARGET_SESSION_REF", () => call(
    baseContext,
    "xero_execute_accounting_case",
    executeArgs(expired.target_session_ref),
  ));
  currentTime = new Date(RUN_CLOCK_ANCHOR);

  const switchTarget = await targets.issue(baseContext);
  const pinnedSwitchContext = await targets.resolve(baseContext, switchTarget.target_session_ref);
  const switchService = new OrganisationSwitchService({
    repository,
    publicBaseUrl: "https://xero-mcp.local-agent-evidence.invalid",
    secret: Buffer.from("local-agent-negative-switch-secret-v1"),
    clock: () => new Date(currentTime),
    ticketFactory: () => "s".repeat(43),
    bindingIdFactory: () => "local-agent-negative-binding-b",
  });
  await switchService.start(pinnedSwitchContext);
  const switchPage = await switchService.getPage("s".repeat(43));
  await switchService.confirm({
    ticket: "s".repeat(43),
    csrfToken: switchPage.csrfToken,
    selectedConnectionId: "local-agent-negative-connection-b",
  });
  await pass("ORGANISATION_SWITCH_STALE_TARGET_SESSION_REF", () => call(
    baseContext,
    "xero_execute_accounting_case",
    executeArgs(switchTarget.target_session_ref),
  ));

  return {
    providerWriteAttempts,
    cases,
    conversationBindingResidual: "NO_TRUSTED_SERVER_CONVERSATION_ID_AVAILABLE",
  };
}

function cliOptions(argv: string[]): ExecuteP0AccountingCaseOptions {
  const options: ExecuteP0AccountingCaseOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--run-id") {
      const value = argv[++index];
      if (!value) throw new Error("--run-id requires a value");
      options.runId = value;
    } else if (argument === "--out-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--out-dir requires a value");
      options.outputDirectory = value;
    }
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main(): Promise<void> {
  const result = await executeP0AccountingCaseSuite(cliOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    run_id: result.report.run_id,
    summary: result.report.summary,
    provider_write_attempts: result.providerWriteAttempts,
    artifacts: result.artifactPaths,
  }, null, 2)}\n`);
  if (result.report.summary.fail > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
const invokedAsP0Cli = process.argv[1]
  ? /^run-p0-accounting-case\.(?:[cm]?[jt]s)$/u.test(basename(process.argv[1]))
  : false;
if (invokedAsP0Cli && invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
