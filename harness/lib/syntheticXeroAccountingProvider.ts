import { AppError } from "../../src/errors.js";
import type {
  CreditNoteType,
  CreateDraftSupplierBillInput,
  InvoiceType,
  ListContactsInput,
  ListCreditNotesInput,
  ListInvoicesInput,
  ListPaymentsInput,
  PaymentType,
} from "../../src/domain/schemas.js";
import type {
  AccountingPrincipal,
  AccountingProvider,
  AccountSummary,
  ActorTenantContext,
  ConnectionSummary,
  ContactSearchResult,
  ContactListResult,
  ContactSummary,
  CreditNoteListResult,
  CreditNoteSnapshot,
  CreditNoteSummary,
  InvoiceListResult,
  InvoiceSnapshot,
  InvoiceSummary,
  OrganisationSummary,
  PaymentListResult,
  PaymentSummary,
  ProviderWriteResult,
  SupplierBillDraftReferenceData,
  SupplierBillSnapshot,
  TaxRateSummary,
} from "../../src/providers/types.js";

export const SYNTHETIC_CONNECTION_ID = "connection_xero_harness_001";

interface FixturePageEvidence {
  page: number;
  pageSize: number;
  returned: number;
  providerPageCount?: number;
  providerItemCount?: number;
  hasNextPage: boolean;
  hasNextPageIsEstimated: boolean;
  omittedInvalid: number;
  omittedOverflow?: number;
}

interface SyntheticLedgerFixture {
  fixture_id: string;
  synthetic: true;
  organisation: OrganisationSummary;
  accounts: AccountSummary[];
  taxRates: TaxRateSummary[];
  contacts: ContactSummary[];
  invoicePages: Array<{ invoices: InvoiceSummary[]; pagination: FixturePageEvidence }>;
  paymentPages: Array<{ payments: PaymentSummary[]; pagination: FixturePageEvidence }>;
  creditNotePages: Array<{ creditNotes: CreditNoteSummary[]; pagination: FixturePageEvidence }>;
  exactInvoices: InvoiceSnapshot[];
  trialBalance: Record<string, unknown> & {
    rows: Array<Record<string, unknown>>;
    totalDebit: string;
    totalCredit: string;
    balanced: boolean;
  };
}

export interface ProviderCallEvidence {
  sequence: number;
  method: keyof AccountingProvider;
  principal: {
    actorId: string;
    workspaceId?: string;
    subjectType?: string;
    subjectId?: string;
    agentId?: string;
    oauthInstallationId?: string;
    bindingId?: string;
    connectionId?: string;
    scopes: string[];
    legacyDemo?: boolean;
  };
  boundTenantId: string;
  input: Record<string, unknown>;
  outputEvidence?: Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function principalEvidence(principal: AccountingPrincipal): ProviderCallEvidence["principal"] {
  if (typeof principal === "string") {
    return { actorId: principal, scopes: [] };
  }
  return {
    actorId: principal.actorId,
    ...(principal.workspaceId ? { workspaceId: principal.workspaceId } : {}),
    ...(principal.subjectType ? { subjectType: principal.subjectType } : {}),
    ...(principal.subjectId ? { subjectId: principal.subjectId } : {}),
    ...(principal.agentId ? { agentId: principal.agentId } : {}),
    ...(principal.oauthInstallationId ? { oauthInstallationId: principal.oauthInstallationId } : {}),
    ...(principal.bindingId ? { bindingId: principal.bindingId } : {}),
    ...(principal.connectionId ? { connectionId: principal.connectionId } : {}),
    scopes: [...principal.scopes],
    legacyDemo: principal.legacyDemo,
  };
}

function byUniqueId<T>(items: T[], id: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [id(item), item])).values()];
}

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function page<T>(items: T[], pageNumber: number, pageSize: number): { items: T[]; pagination: FixturePageEvidence } {
  const start = (pageNumber - 1) * pageSize;
  const selected = items.slice(start, start + pageSize);
  const providerPageCount = Math.max(1, Math.ceil(items.length / pageSize));
  return {
    items: selected,
    pagination: {
      page: pageNumber,
      pageSize,
      returned: selected.length,
      providerPageCount,
      providerItemCount: items.length,
      hasNextPage: start + selected.length < items.length,
      hasNextPageIsEstimated: false,
      omittedInvalid: 0,
      omittedOverflow: 0,
    },
  };
}

function dateInRange(value: string | undefined, from: string | undefined, to: string | undefined): boolean {
  if (!value) return from === undefined && to === undefined;
  return (from === undefined || value >= from) && (to === undefined || value <= to);
}

/**
 * Network-free Xero provider fixture used behind the production AccountingService.
 *
 * The principal-to-tenant mapping is server-owned: only the synthetic connection
 * binding selects a tenant. Tool inputs never select or override it.
 */
export class SyntheticXeroAccountingProvider implements AccountingProvider {
  readonly calls: ProviderCallEvidence[] = [];
  readonly #fixture: SyntheticLedgerFixture;
  #trialBalancePressure = false;
  #writeAttemptCount = 0;

  constructor(fixture: unknown) {
    this.#fixture = clone(fixture as SyntheticLedgerFixture);
    if (this.#fixture.synthetic !== true || !this.#fixture.organisation?.organisationId) {
      throw new Error("The P0 read-only provider requires the pinned synthetic Xero ledger fixture.");
    }
  }

  get tenantId(): string {
    return this.#fixture.organisation.organisationId;
  }

  get tenantName(): string {
    return this.#fixture.organisation.name;
  }

  get writeAttempts(): number {
    return this.#writeAttemptCount;
  }

  setTrialBalancePressure(enabled: boolean): void {
    this.#trialBalancePressure = enabled;
  }

  #assertBoundPrincipal(principal: AccountingPrincipal): void {
    if (typeof principal === "string") {
      throw new AppError("FORBIDDEN", "The synthetic P0 provider requires an OAuth-bound request context.", {
        httpStatus: 403,
      });
    }
    if (
      principal.legacyDemo ||
      principal.connectionId !== SYNTHETIC_CONNECTION_ID ||
      !principal.bindingId ||
      !principal.oauthInstallationId ||
      !principal.workspaceId ||
      !principal.subjectId ||
      !principal.agentId
    ) {
      throw new AppError("FORBIDDEN", "The request does not match the server-owned synthetic Xero binding.", {
        httpStatus: 403,
      });
    }
  }

  #record(
    method: keyof AccountingProvider,
    principal: AccountingPrincipal,
    input: Record<string, unknown> = {},
    outputEvidence?: Record<string, unknown>,
  ): void {
    this.#assertBoundPrincipal(principal);
    this.calls.push({
      sequence: this.calls.length + 1,
      method,
      principal: principalEvidence(principal),
      boundTenantId: this.tenantId,
      input: clone(input),
      ...(outputEvidence ? { outputEvidence: clone(outputEvidence) } : {}),
    });
  }

  async connectionStatus(principal: AccountingPrincipal): Promise<ConnectionSummary> {
    this.#record("connectionStatus", principal);
    const scopes = typeof principal === "string" ? [] : [...principal.scopes];
    return {
      connected: true,
      tenant: { id: this.tenantId, name: this.tenantName },
      scopes,
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    };
  }

  async resolveContext(principal: AccountingPrincipal): Promise<ActorTenantContext> {
    this.#record("resolveContext", principal, {}, { bindingSource: SYNTHETIC_CONNECTION_ID });
    const actorId = typeof principal === "string" ? principal : principal.actorId;
    return { actorId, tenantId: this.tenantId, tenantName: this.tenantName };
  }

  async getOrganisation(principal: AccountingPrincipal): Promise<OrganisationSummary> {
    this.#record("getOrganisation", principal);
    return clone(this.#fixture.organisation);
  }

  async listAccounts(principal: AccountingPrincipal): Promise<AccountSummary[]> {
    this.#record("listAccounts", principal, {}, { sourceItemCount: this.#fixture.accounts.length });
    return clone(this.#fixture.accounts);
  }

  async listTaxRates(principal: AccountingPrincipal): Promise<TaxRateSummary[]> {
    this.#record("listTaxRates", principal, {}, { sourceItemCount: this.#fixture.taxRates.length });
    return clone(this.#fixture.taxRates);
  }

  async listContacts(
    principal: AccountingPrincipal,
    input: ListContactsInput,
  ): Promise<ContactListResult> {
    const matches = this.#fixture.contacts
      .filter((contact) =>
        contact.status === input.status &&
        (input.is_supplier === undefined || contact.isSupplier === input.is_supplier) &&
        (input.is_customer === undefined || contact.isCustomer === input.is_customer))
      .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));
    const selectedPage = page(matches, input.page, input.limit);
    this.#record("listContacts", principal, input, {
      returned: selectedPage.pagination.returned,
      providerItemCount: selectedPage.pagination.providerItemCount ?? matches.length,
    });
    return {
      contacts: clone(selectedPage.items),
      pagination: selectedPage.pagination,
    };
  }

  async searchContacts(
    principal: AccountingPrincipal,
    query: string,
    limit: number,
    pageNumber = 1,
  ): Promise<ContactSearchResult> {
    const matches = this.#fixture.contacts
      .filter((contact) => normalized(contact.name).includes(normalized(query)));
    const selectedPage = page(matches, pageNumber, limit);
    this.#record(
      "searchContacts",
      principal,
      { query, limit, page: pageNumber },
      {
        returned: selectedPage.pagination.returned,
        providerItemCount: selectedPage.pagination.providerItemCount ?? matches.length,
      },
    );
    return {
      contacts: clone(selectedPage.items),
      pagination: selectedPage.pagination,
    };
  }

  async getSupplierBillDraftReferenceData(
    principal: AccountingPrincipal,
    supplierQuery?: string,
  ): Promise<SupplierBillDraftReferenceData> {
    const contacts = supplierQuery
      ? this.#fixture.contacts.filter((contact) => normalized(contact.name).includes(normalized(supplierQuery)))
      : this.#fixture.contacts;
    this.#record(
      "getSupplierBillDraftReferenceData",
      principal,
      { ...(supplierQuery ? { supplierQuery } : {}) },
      { contactsReturned: contacts.length, contactsComplete: true },
    );
    return {
      tenant: { id: this.tenantId, name: this.tenantName },
      contacts: clone(contacts),
      contactsComplete: true,
      accounts: clone(this.#fixture.accounts),
      taxRates: clone(this.#fixture.taxRates),
    };
  }

  async getContact(principal: AccountingPrincipal, contactId: string): Promise<ContactSummary | undefined> {
    const contact = this.#fixture.contacts.find((candidate) => candidate.contactId === contactId);
    this.#record("getContact", principal, { contactId }, { found: contact !== undefined });
    return contact ? clone(contact) : undefined;
  }

  async listInvoices(principal: AccountingPrincipal, input: ListInvoicesInput): Promise<InvoiceListResult> {
    let invoices = byUniqueId(
      this.#fixture.invoicePages.flatMap((fixturePage) => fixturePage.invoices),
      (invoice) => invoice.invoiceId,
    ).filter((invoice) =>
      (input.type === undefined || invoice.type === input.type) &&
      (input.contact_id === undefined || invoice.contact.contactId === input.contact_id) &&
      (input.statuses === undefined || input.statuses.includes(invoice.status as never)) &&
      dateInRange(invoice.invoiceDate, input.date_from, input.date_to) &&
      (input.search_term === undefined || normalized(JSON.stringify(invoice)).includes(normalized(input.search_term))));
    const direction = input.order.endsWith("_ASC") ? 1 : -1;
    const field = input.order.startsWith("UPDATED_AT") ? "updatedAt" : "invoiceDate";
    invoices = invoices.sort((left, right) => direction * (left[field] ?? "").localeCompare(right[field] ?? ""));
    const selected = page(invoices, input.page, input.page_size);
    this.#record("listInvoices", principal, input, {
      filteredItemCount: invoices.length,
      returned: selected.items.length,
      page: input.page,
    });
    return { invoices: clone(selected.items), pagination: selected.pagination };
  }

  async listCreditNotes(principal: AccountingPrincipal, input: ListCreditNotesInput): Promise<CreditNoteListResult> {
    const notes = byUniqueId(
      this.#fixture.creditNotePages.flatMap((fixturePage) => fixturePage.creditNotes),
      (note) => note.creditNoteId,
    ).filter((note) =>
      (input.type === undefined || note.type === input.type) &&
      (input.status === undefined || note.status === input.status) &&
      (input.contact_id === undefined || note.contact.contactId === input.contact_id) &&
      dateInRange(note.creditNoteDate, input.date_from, input.date_to));
    const selected = page(notes, input.page, input.page_size);
    this.#record("listCreditNotes", principal, input, {
      filteredItemCount: notes.length,
      returned: selected.items.length,
      page: input.page,
    });
    return { creditNotes: clone(selected.items), pagination: selected.pagination };
  }

  async listPayments(principal: AccountingPrincipal, input: ListPaymentsInput): Promise<PaymentListResult> {
    const payments = byUniqueId(
      this.#fixture.paymentPages.flatMap((fixturePage) => fixturePage.payments),
      (payment) => payment.paymentId,
    ).filter((payment) =>
      (input.type === undefined || payment.type === input.type) &&
      (input.status === undefined || payment.status === input.status) &&
      (input.contact_id === undefined || payment.contact?.contactId === input.contact_id) &&
      dateInRange(payment.paymentDate, input.date_from, input.date_to));
    const selected = page(payments, input.page, input.page_size);
    this.#record("listPayments", principal, input, {
      filteredItemCount: payments.length,
      returned: selected.items.length,
      page: input.page,
    });
    return { payments: clone(selected.items), pagination: selected.pagination };
  }

  async getInvoice(
    principal: AccountingPrincipal,
    invoiceId: string,
    expectedType?: InvoiceType,
  ): Promise<InvoiceSnapshot> {
    const invoice = this.#fixture.exactInvoices.find((candidate) =>
      candidate.invoiceId === invoiceId && (expectedType === undefined || candidate.type === expectedType));
    this.#record("getInvoice", principal, { invoiceId, ...(expectedType ? { expectedType } : {}) }, {
      found: invoice !== undefined,
    });
    if (!invoice) throw new AppError("NOT_FOUND", "The synthetic invoice was not found.", { httpStatus: 404 });
    return clone(invoice);
  }

  async getCreditNote(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expectedType?: CreditNoteType,
  ): Promise<CreditNoteSnapshot> {
    this.#record("getCreditNote", principal, {
      creditNoteId,
      ...(expectedType ? { expectedType } : {}),
    }, { found: false });
    throw new AppError("NOT_FOUND", "The synthetic fixture has no exact credit-note snapshot.", { httpStatus: 404 });
  }

  async getSupplierBill(principal: AccountingPrincipal, invoiceId: string): Promise<SupplierBillSnapshot> {
    const invoice = this.#fixture.exactInvoices.find((candidate) =>
      candidate.invoiceId === invoiceId && candidate.type === "ACCPAY");
    this.#record("getSupplierBill", principal, { invoiceId }, { found: invoice !== undefined });
    if (!invoice) throw new AppError("NOT_FOUND", "The synthetic supplier bill was not found.", { httpStatus: 404 });
    return clone(invoice as SupplierBillSnapshot);
  }

  async createDraftSupplierBill(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
    idempotencyKey: string,
  ): Promise<ProviderWriteResult> {
    this.#writeAttemptCount += 1;
    this.#record("createDraftSupplierBill", principal, {
      requestId: input.request_id,
      idempotencyKey,
    });
    throw new Error("P0_READ_ONLY_WRITE_ESCAPE: createDraftSupplierBill reached the Provider");
  }

  async authoriseSupplierBill(
    principal: AccountingPrincipal,
    invoiceId: string,
    idempotencyKey: string,
  ): Promise<ProviderWriteResult> {
    this.#writeAttemptCount += 1;
    this.#record("authoriseSupplierBill", principal, { invoiceId, idempotencyKey });
    throw new Error("P0_READ_ONLY_WRITE_ESCAPE: authoriseSupplierBill reached the Provider");
  }

  async getTrialBalance(principal: AccountingPrincipal, date?: string): Promise<Record<string, unknown>> {
    if (!this.#trialBalancePressure) {
      this.#record("getTrialBalance", principal, { ...(date ? { date } : {}) }, {
        pressure: false,
        rawRowCount: this.#fixture.trialBalance.rows.length,
      });
      return clone(this.#fixture.trialBalance);
    }

    this.#trialBalancePressure = false;
    const rows = Array.from({ length: 5_000 }, (_, index) => ({
      rowType: "Row",
      cells: [
        {
          value: `P${String(index + 1).padStart(4, "0")}`,
          attributes: [{ id: "account", value: `Pressure account ${index + 1}` }],
        },
        { value: index < 2_500 ? "1.00" : "0.00" },
        { value: index < 2_500 ? "0.00" : "1.00" },
      ],
    }));
    this.#record("getTrialBalance", principal, { ...(date ? { date } : {}) }, {
      pressure: true,
      rawRowCount: rows.length,
      rawByteCount: Buffer.byteLength(JSON.stringify(rows), "utf8"),
    });
    return {
      reports: [{
        reportID: "TrialBalance",
        reportName: "Trial Balance",
        reportTitle: "Trial Balance pressure fixture",
        reportType: "TrialBalance",
        reportTitles: ["Trial Balance", this.#fixture.organisation.name, date ?? this.#fixture.trialBalance.reportDate],
        reportDate: date ?? this.#fixture.trialBalance.reportDate,
        updatedDateUTC: new Date("2026-08-06T00:00:00.000Z"),
        rows,
      }],
    };
  }
}

export type { SyntheticLedgerFixture, CreditNoteType, PaymentType };
