import { randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import {
  canonicalBillForApproval,
  canonicalDraftExtractionFingerprint,
  canonicalDraftRequest,
  canonicalInvoiceForApproval,
  canonicalSalesInvoiceDraftExtractionFingerprint,
  canonicalSalesInvoiceDraftRequest,
} from "../domain/canonical.js";
import type { AuditCompletion, AuditIntent, GovernanceDisposition, PostingRequest } from "../domain/models.js";
import type {
  AuthoriseSupplierBillInput,
  CreateDraftSalesInvoiceInput,
  CreateDraftSupplierBillInput,
  GetContactInput,
  GetInvoiceInput,
  ListAccountsInput,
  ListContactsInput,
  ListCreditNotesInput,
  ListInvoicesInput,
  ListPaymentsInput,
  PrepareSupplierBillDraftInput,
  PrepareSalesInvoiceDraftInput,
  SearchContactsInput,
  SourceEvidenceType,
  TrialBalanceInput,
} from "../domain/schemas.js";
import { createDraftSupplierBillSchema } from "../domain/schemas.js";
import type {
  GetBankTransactionInput,
  GetItemInput,
  GetManualJournalInput,
  GetPurchaseOrderInput,
  GetQuoteInput,
  ListBankTransactionsInput,
  ListItemsInput,
  ListManualJournalsInput,
  ListPurchaseOrdersInput,
  ListQuotesInput,
} from "../domain/extendedReadSchemas.js";
import type {
  PreparePurchaseOrderDraftInput,
  PrepareQuoteDraftInput,
} from "../domain/xeroQuotePurchaseOrderDraft.js";
import type { ExecutePreparedXeroMutationInput } from "../domain/xeroControlledMutationSchemas.js";
import type {
  PrepareCreditNoteDraftInput,
  PrepareManualJournalDraftInput,
} from "../domain/xeroCreditNoteManualJournalDraft.js";
import type {
  PrepareContactCreateMutationInput,
  PrepareContactUpdateMutationInput,
  PrepareItemCreateMutationInput,
  PrepareItemUpdateMutationInput,
} from "../domain/xeroContactItemMutationSchemas.js";
import type { AccountingRepository } from "../db/repository.js";
import { xeroSupplierPostingIdentity } from "../db/xeroPostingDuplicate.js";
import { AppError, toSafeError } from "../errors.js";
import type { Logger } from "../logging.js";
import { hashObject, safeEqual, sha256 } from "../security/hash.js";
import type {
  AccountingPrincipal,
  AccountingProvider,
  AccountSummary,
  ContactSummary,
  InvoiceSnapshot,
  ProviderSalesInvoiceWriteResult,
  ProviderWriteResult,
  SalesInvoiceSnapshot,
  SupplierBillSnapshot,
  TaxRateSummary,
  ActorTenantContext,
} from "../providers/types.js";
import type { ConnectionTicketService } from "./connectionTicketService.js";
import { requireOAuthBoundRequestContext, type RequestContext } from "../security/requestContext.js";
import { boundXeroTrialBalanceForAgent } from "./xeroTrialBalanceBounds.js";
import type { XeroControlledMutationService } from "./xeroControlledMutationService.js";
import type { XeroCreditNoteManualJournalService } from "./xeroCreditNoteManualJournalService.js";
import type { XeroContactItemMutationService } from "./xeroContactItemMutationService.js";
import type { XeroMutationService } from "./xeroMutationService.js";

const MAX_AGENT_INVOICE_LINES = 100;
const MAX_AGENT_LINE_DESCRIPTION_CHARS = 1_000;
const MAX_AGENT_INVOICE_RESULT_BYTES = 128 * 1_024;
const EXISTING_DRAFT_WAIT_MS = 30_000;
const EXISTING_DRAFT_INITIAL_POLL_MS = 25;
const EXISTING_DRAFT_MAX_POLL_MS = 1_000;

function boundInvoiceForAgent<T extends InvoiceSnapshot>(invoice: T): T {
  const originalLineCount = invoice.lineItemCount ?? invoice.lines.length;
  let selectedLines = invoice.lines.slice(0, MAX_AGENT_INVOICE_LINES).map((line) => {
    if (line.description.length <= MAX_AGENT_LINE_DESCRIPTION_CHARS) return line;
    return {
      ...line,
      description: line.description.slice(0, MAX_AGENT_LINE_DESCRIPTION_CHARS),
      descriptionTruncated: true,
    };
  });

  const bounded = () => ({
    ...invoice,
    lines: selectedLines,
    lineItemCount: originalLineCount,
    linesTruncated: invoice.linesTruncated === true || originalLineCount > selectedLines.length,
  }) as T;

  let result = bounded();
  while (
    selectedLines.length > 0 &&
    Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_AGENT_INVOICE_RESULT_BYTES
  ) {
    selectedLines = selectedLines.slice(0, -1);
    result = bounded();
  }
  return result;
}

export interface DraftSupplierBillResult {
  postingRequestId: string;
  invoiceId: string;
  status: string;
  approvedPayloadHash: string;
  /** Durable, non-secret Provider acknowledgement for the exact Xero write. */
  providerReceipt: Record<string, unknown> | null;
  /** True only after the exact created InvoiceID has passed semantic readback verification. */
  readbackVerified: true;
  reviewUrl: string;
  bill: SupplierBillSnapshot;
  idempotentReplay: boolean;
}

export interface DraftSalesInvoiceResult {
  postingRequestId: string;
  invoiceId: string;
  status: string;
  verifiedPayloadHash: string;
  providerReceipt: Record<string, unknown> | null;
  readbackVerified: true;
  invoice: SalesInvoiceSnapshot;
  idempotentReplay: boolean;
}

export interface AuthoriseSupplierBillResult {
  postingRequestId: string;
  invoiceId: string;
  status: string;
  verified: true;
  bill: SupplierBillSnapshot;
  idempotentReplay: boolean;
}

export interface SupplierBillDraftPreparationBlocker {
  code: "MISSING_FIELD" | "NO_EXACT_MATCH" | "AMBIGUOUS_MATCH" | "INELIGIBLE_MATCH" | "INCOMPLETE_EVIDENCE";
  path: string;
  message: string;
  candidates?: Array<Record<string, unknown>>;
}

export interface SupplierBillDraftPreparationWarning {
  code: "SOURCE_HASH_AGENT_ASSERTED" | "SOURCE_EXTRACTION_FINGERPRINT_ONLY";
  path: "source_sha256";
  message: string;
}

export interface SupplierBillDraftPreparationResult {
  technicallyReady: boolean;
  readyForUserConfirmation: boolean;
  requiresUserConfirmation: true;
  executionAllowed: false;
  proposal: Omit<CreateDraftSupplierBillInput, "user_confirmation"> | null;
  evidence: {
    tenant: { id: string; name: string };
    source: {
      ref?: string;
      sha256: string;
      trust: SourceEvidenceType;
    };
    supplier: {
      requestedName?: string;
      requestedContactNumber?: string;
      exactMatches: ContactSummary[];
      selected?: ContactSummary;
    };
    lines: Array<{
      index: number;
      account: {
        requestedCode?: string;
        requestedName?: string;
        exactMatches: AccountSummary[];
        selected?: AccountSummary;
      };
      taxRate: {
        requestedTaxType?: string;
        requestedName?: string;
        exactMatches: TaxRateSummary[];
        selected?: TaxRateSummary;
      };
    }>;
    sourceCounts: { contacts: number; contactsComplete: boolean; accounts: number; taxRates: number };
  };
  blockers: SupplierBillDraftPreparationBlocker[];
  warnings: SupplierBillDraftPreparationWarning[];
  preparation_id: string | null;
  confirmation_phrase: string | null;
  expires_at: string | null;
}

export interface SalesInvoiceDraftPreparationResult extends Omit<
  SupplierBillDraftPreparationResult,
  "proposal" | "evidence"
> {
  proposal: Omit<CreateDraftSalesInvoiceInput, "user_confirmation"> | null;
  evidence: Omit<SupplierBillDraftPreparationResult["evidence"], "supplier"> & {
    customer: SupplierBillDraftPreparationResult["evidence"]["supplier"];
  };
}

function normalizedExact(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function safeContactCandidate(contact: ContactSummary): Record<string, unknown> {
  return {
    contactId: contact.contactId,
    ...(contact.name ? { name: contact.name } : {}),
    ...(contact.contactNumber ? { contactNumber: contact.contactNumber } : {}),
    ...(contact.status ? { status: contact.status } : {}),
    ...(contact.isSupplier !== undefined ? { isSupplier: contact.isSupplier } : {}),
  };
}

function safeAccountCandidate(account: AccountSummary): Record<string, unknown> {
  return {
    ...(account.accountId ? { accountId: account.accountId } : {}),
    ...(account.code ? { code: account.code } : {}),
    ...(account.name ? { name: account.name } : {}),
    ...(account.type ? { type: account.type } : {}),
    ...(account.class ? { class: account.class } : {}),
    ...(account.status ? { status: account.status } : {}),
    ...(account.systemAccount ? { systemAccount: account.systemAccount } : {}),
  };
}

function safeTaxCandidate(tax: TaxRateSummary): Record<string, unknown> {
  return {
    ...(tax.taxType ? { taxType: tax.taxType } : {}),
    ...(tax.name ? { name: tax.name } : {}),
    ...(tax.status ? { status: tax.status } : {}),
    ...(tax.displayTaxRate ? { displayTaxRate: tax.displayTaxRate } : {}),
  };
}

function canTaxApplyToAccountClass(tax: TaxRateSummary, accountClass?: string): boolean {
  switch (accountClass?.toUpperCase()) {
    case "EXPENSE": return tax.canApplyToExpenses !== false;
    case "ASSET": return tax.canApplyToAssets !== false;
    case "LIABILITY": return tax.canApplyToLiabilities !== false;
    case "REVENUE": return tax.canApplyToRevenue !== false;
    case "EQUITY": return tax.canApplyToEquity !== false;
    default: return true;
  }
}

interface InternalAuthoriseInput {
  postingRequestId: string;
  invoiceId: string;
  approvalRefHash: string;
  approvedPayloadHash: string;
  requestId: string;
}

function principalActorId(principal: AccountingPrincipal): string {
  return typeof principal === "string" ? principal : principal.actorId;
}

function isOAuthPrincipal(principal: AccountingPrincipal): boolean {
  return typeof principal !== "string" && !principal.legacyDemo;
}

function isDefiniteProviderWriteRejection(error: AppError): boolean {
  return error.code === "PROVIDER_ERROR" &&
    error.details?.writeOutcome === "DEFINITELY_REJECTED";
}

function isCanonicalOAuthActorId(actorId: string): boolean {
  const [workspaceId, subjectType, subjectId, extra] = actorId.split(":");
  return extra === undefined &&
    Boolean(workspaceId) &&
    (subjectType === "user" || subjectType === "team") &&
    Boolean(subjectId);
}

export class AccountingService {
  readonly #repository: AccountingRepository;
  readonly #provider: AccountingProvider;
  readonly #config: Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId">;
  readonly #logger: Logger;
  readonly #connectionTickets: ConnectionTicketService;
  readonly #controlledMutations: XeroControlledMutationService | undefined;
  readonly #creditNoteManualJournalMutations: XeroCreditNoteManualJournalService | undefined;
  readonly #contactItemMutations: XeroContactItemMutationService | undefined;
  readonly #mutationFoundation: XeroMutationService | undefined;

  constructor(options: {
    repository: AccountingRepository;
    provider: AccountingProvider;
    config: Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId">;
    logger: Logger;
    connectionTickets: ConnectionTicketService;
    controlledMutations?: XeroControlledMutationService;
    creditNoteManualJournalMutations?: XeroCreditNoteManualJournalService;
    contactItemMutations?: XeroContactItemMutationService;
    mutationFoundation?: XeroMutationService;
  }) {
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#connectionTickets = options.connectionTickets;
    this.#controlledMutations = options.controlledMutations;
    this.#creditNoteManualJournalMutations = options.creditNoteManualJournalMutations;
    this.#contactItemMutations = options.contactItemMutations;
    this.#mutationFoundation = options.mutationFoundation;
  }

  async connectionStatus(principal: AccountingPrincipal) {
    const status = await this.#provider.connectionStatus(principal);
    if (status.connected) {
      return {
        ...status,
        connectionLifecycle: {
          organisationBinding: "EXACTLY_ONE_CURRENT_ORGANISATION_PER_MCP_INSTALLATION" as const,
          accessTokenRefresh: "AUTOMATIC_NO_USER_ACTION" as const,
          organisationChange: {
            supported: true as const,
            requiresFreshXeroOAuth: "ONLY_IF_ORGANISATION_NOT_ALREADY_AUTHORISED" as const,
            silentChatSwitchAllowed: false as const,
            hostSteps: [
              "ASK_AGENT_TO_SWITCH_XERO_ORGANISATION",
              "OPEN_SHORT_LIVED_CONFIRMATION_LINK",
              "SELECT_EXACTLY_ONE_XERO_ORGANISATION",
              "RETURN_TO_AGENT_AND_VERIFY_CONNECTION_STATUS",
            ] as const,
          },
        },
      };
    }
    if (isOAuthPrincipal(principal)) return status;
    const actorId = principalActorId(principal);
    const ticket = await this.#connectionTickets.issue(actorId);
    return { ...status, connectUrl: ticket.url, connectUrlExpiresAt: ticket.expiresAt.toISOString() };
  }

  getOrganisation(principal: AccountingPrincipal) {
    return this.#provider.getOrganisation(principal);
  }

  async listAccounts(principal: AccountingPrincipal, input: ListAccountsInput) {
    const accounts = await this.#provider.listAccounts(principal);
    return input.account_class
      ? accounts.filter((account) => account.class === input.account_class)
      : accounts;
  }

  listTaxRates(principal: AccountingPrincipal) {
    return this.#provider.listTaxRates(principal);
  }

  listContacts(principal: AccountingPrincipal, input: ListContactsInput) {
    return this.#provider.listContacts(principal, input);
  }

  async getContact(principal: AccountingPrincipal, input: GetContactInput) {
    const contact = await this.#provider.getContact(principal, input.contact_id);
    if (!contact) {
      throw new AppError("NOT_FOUND", "The requested Xero contact was not found.", { httpStatus: 404 });
    }
    return contact;
  }

  searchContacts(principal: AccountingPrincipal, input: SearchContactsInput) {
    return this.#provider.searchContacts(principal, input.query, input.limit, input.page);
  }

  async prepareSupplierBillDraft(
    principal: AccountingPrincipal,
    input: PrepareSupplierBillDraftInput,
  ): Promise<SupplierBillDraftPreparationResult> {
    const prepared = await this.#prepareSupplierBillDraftProposal(principal, input);
    const confirmation = await this.#persistInvoiceDraftPreparation(
      principal,
      prepared.proposal,
      "SUPPLIER_BILL",
    );
    return { ...prepared, ...confirmation };
  }

  async #prepareSupplierBillDraftProposal(
    principal: AccountingPrincipal,
    input: PrepareSupplierBillDraftInput,
  ): Promise<SupplierBillDraftPreparationResult> {
    const referenceData = await this.#provider.getSupplierBillDraftReferenceData(principal, input.supplier_name);
    const blockers: SupplierBillDraftPreparationBlocker[] = [];
    const sourceTrust: SourceEvidenceType = input.source_sha256
      ? "AGENT_ASSERTED_UNVERIFIED" as const
      : "SERVER_FINGERPRINTED_EXTRACTION" as const;
    const warnings: SupplierBillDraftPreparationWarning[] = [input.source_sha256
      ? {
          code: "SOURCE_HASH_AGENT_ASSERTED",
          path: "source_sha256",
          message: "The supplied source hash was asserted by the Agent/Host and was not verified against a Host-signed file receipt. Human confirmation is required before creating the Xero draft.",
        }
      : {
          code: "SOURCE_EXTRACTION_FINGERPRINT_ONLY",
          path: "source_sha256",
          message: "The server generated a deterministic fingerprint of the extracted fields. It is not a hash of a Host-attested original file. Human confirmation is required before creating the Xero draft.",
        }];
    const addMissing = (path: string) => blockers.push({
      code: "MISSING_FIELD",
      path,
      message: `${path} must be supplied from the source material before a Xero draft can be proposed.`,
    });

    if (!input.source_ref) addMissing("source_ref");
    if (!input.supplier_name) addMissing("supplier_name");
    if (!input.invoice_date) addMissing("invoice_date");
    if (!input.due_date) addMissing("due_date");
    if (!input.currency) addMissing("currency");
    if (!input.reference) addMissing("reference");
    if (!input.line_amount_type) addMissing("line_amount_type");
    if (!input.lines || input.lines.length === 0) addMissing("lines");
    if (input.invoice_date && input.due_date && input.due_date < input.invoice_date) {
      blockers.push({
        code: "INELIGIBLE_MATCH",
        path: "due_date",
        message: "due_date cannot be before invoice_date.",
      });
    }

    const requestedSupplierName = normalizedExact(input.supplier_name);
    const requestedContactNumber = normalizedExact(input.supplier_contact_number);
    const exactContacts = requestedSupplierName === undefined
      ? []
      : referenceData.contacts.filter((contact) =>
        normalizedExact(contact.name) === requestedSupplierName &&
        (requestedContactNumber === undefined || normalizedExact(contact.contactNumber) === requestedContactNumber));
    const eligibleContacts = exactContacts.filter((contact) => !contact.status || contact.status === "ACTIVE");
    const soleEligibleContact = eligibleContacts.length === 1 ? eligibleContacts[0] : undefined;
    const selectedContact = referenceData.contactsComplete ? soleEligibleContact : undefined;
    if (input.supplier_name && exactContacts.length === 0) {
      blockers.push({
        code: "NO_EXACT_MATCH",
        path: "supplier_name",
        message: "No exact Xero contact matched the supplied supplier identity; a contact ID was not guessed.",
      });
    } else if (eligibleContacts.length > 1) {
      blockers.push({
        code: "AMBIGUOUS_MATCH",
        path: "supplier_name",
        message: "More than one active Xero contact exactly matched the supplier identity.",
        candidates: eligibleContacts.slice(0, 10).map(safeContactCandidate),
      });
    } else if (exactContacts.length > 0 && eligibleContacts.length === 0) {
      blockers.push({
        code: "INELIGIBLE_MATCH",
        path: "supplier_name",
        message: "The exact Xero contact match is not active.",
        candidates: exactContacts.slice(0, 10).map(safeContactCandidate),
      });
    } else if (!referenceData.contactsComplete && soleEligibleContact) {
      blockers.push({
        code: "INCOMPLETE_EVIDENCE",
        path: "supplier_name",
        message: "Xero returned more contact search pages, so uniqueness could not be proven and no contact ID was selected.",
        candidates: [safeContactCandidate(soleEligibleContact)],
      });
    }

    const lineEvidence: SupplierBillDraftPreparationResult["evidence"]["lines"] = [];
    const selectedLineValues: Array<{ account: AccountSummary; taxRate: TaxRateSummary }> = [];
    for (const [index, line] of (input.lines ?? []).entries()) {
      if (!line.description) addMissing(`lines[${index}].description`);
      if (line.quantity === undefined) addMissing(`lines[${index}].quantity`);
      if (line.unit_amount === undefined) addMissing(`lines[${index}].unit_amount`);
      if (!line.account_code && !line.account_name) addMissing(`lines[${index}].account_code_or_name`);
      if (!line.tax_type && !line.tax_name) addMissing(`lines[${index}].tax_type_or_name`);

      const requestedAccountCode = normalizedExact(line.account_code);
      const requestedAccountName = normalizedExact(line.account_name);
      const exactAccounts = referenceData.accounts.filter((account) =>
        (requestedAccountCode === undefined || normalizedExact(account.code) === requestedAccountCode) &&
        (requestedAccountName === undefined || normalizedExact(account.name) === requestedAccountName) &&
        (requestedAccountCode !== undefined || requestedAccountName !== undefined));
      const eligibleAccounts = exactAccounts.filter((account) =>
        (!account.status || account.status === "ACTIVE") &&
        account.type !== "BANK" &&
        !["DEBTORS", "CREDITORS"].includes(account.systemAccount ?? ""));
      const selectedAccount = eligibleAccounts.length === 1 ? eligibleAccounts[0] : undefined;
      if ((line.account_code || line.account_name) && exactAccounts.length === 0) {
        blockers.push({
          code: "NO_EXACT_MATCH",
          path: `lines[${index}].account`,
          message: "No exact Xero account matched the supplied code/name; an account ID or code was not guessed.",
        });
      } else if (eligibleAccounts.length > 1) {
        blockers.push({
          code: "AMBIGUOUS_MATCH",
          path: `lines[${index}].account`,
          message: "More than one eligible Xero account exactly matched this line.",
          candidates: eligibleAccounts.slice(0, 10).map(safeAccountCandidate),
        });
      } else if (exactAccounts.length > 0 && eligibleAccounts.length === 0) {
        blockers.push({
          code: "INELIGIBLE_MATCH",
          path: `lines[${index}].account`,
          message: "The exact Xero account match is not eligible for a supplier bill.",
          candidates: exactAccounts.slice(0, 10).map(safeAccountCandidate),
        });
      } else if (selectedAccount && !selectedAccount.code) {
        blockers.push({
          code: "INELIGIBLE_MATCH",
          path: `lines[${index}].account`,
          message: "The exact Xero account match has no account code and cannot form a draft proposal.",
          candidates: [safeAccountCandidate(selectedAccount)],
        });
      }

      const requestedTaxType = normalizedExact(line.tax_type);
      const requestedTaxName = normalizedExact(line.tax_name);
      const exactTaxRates = referenceData.taxRates.filter((tax) =>
        (requestedTaxType === undefined || normalizedExact(tax.taxType) === requestedTaxType) &&
        (requestedTaxName === undefined || normalizedExact(tax.name) === requestedTaxName) &&
        (requestedTaxType !== undefined || requestedTaxName !== undefined));
      const activeTaxRates = exactTaxRates.filter((tax) => !tax.status || tax.status === "ACTIVE");
      const compatibleTaxRates = activeTaxRates.filter((tax) =>
        canTaxApplyToAccountClass(tax, selectedAccount?.class));
      const selectedTaxRate = compatibleTaxRates.length === 1 ? compatibleTaxRates[0] : undefined;
      if ((line.tax_type || line.tax_name) && exactTaxRates.length === 0) {
        blockers.push({
          code: "NO_EXACT_MATCH",
          path: `lines[${index}].tax_rate`,
          message: "No exact active Xero tax rate matched the supplied type/name; a tax type was not guessed.",
        });
      } else if (compatibleTaxRates.length > 1) {
        blockers.push({
          code: "AMBIGUOUS_MATCH",
          path: `lines[${index}].tax_rate`,
          message: "More than one compatible Xero tax rate exactly matched this line.",
          candidates: compatibleTaxRates.slice(0, 10).map(safeTaxCandidate),
        });
      } else if (exactTaxRates.length > 0 && compatibleTaxRates.length === 0) {
        blockers.push({
          code: "INELIGIBLE_MATCH",
          path: `lines[${index}].tax_rate`,
          message: "The exact Xero tax match is inactive or incompatible with the matched account.",
          candidates: exactTaxRates.slice(0, 10).map(safeTaxCandidate),
        });
      } else if (selectedTaxRate && !selectedTaxRate.taxType) {
        blockers.push({
          code: "INELIGIBLE_MATCH",
          path: `lines[${index}].tax_rate`,
          message: "The exact Xero tax match has no tax type and cannot form a draft proposal.",
          candidates: [safeTaxCandidate(selectedTaxRate)],
        });
      }

      lineEvidence.push({
        index,
        account: {
          ...(line.account_code ? { requestedCode: line.account_code } : {}),
          ...(line.account_name ? { requestedName: line.account_name } : {}),
          exactMatches: exactAccounts,
          ...(selectedAccount ? { selected: selectedAccount } : {}),
        },
        taxRate: {
          ...(line.tax_type ? { requestedTaxType: line.tax_type } : {}),
          ...(line.tax_name ? { requestedName: line.tax_name } : {}),
          exactMatches: exactTaxRates,
          ...(selectedTaxRate ? { selected: selectedTaxRate } : {}),
        },
      });
      if (selectedAccount && selectedTaxRate) selectedLineValues.push({ account: selectedAccount, taxRate: selectedTaxRate });
    }

    let proposal: Omit<CreateDraftSupplierBillInput, "user_confirmation"> | null = null;
    let resolvedSourceSha256: string | undefined = input.source_sha256;
    if (blockers.length === 0 && selectedContact && input.lines && selectedLineValues.length === input.lines.length) {
      const normalizedDraftFields = {
        source_ref: input.source_ref as string,
        contact_id: selectedContact.contactId,
        invoice_date: input.invoice_date as string,
        due_date: input.due_date as string,
        currency: input.currency as string,
        reference: input.reference as string,
        line_amount_type: input.line_amount_type as "Exclusive" | "Inclusive" | "NoTax",
        lines: input.lines.map((line, index) => ({
          description: line.description as string,
          quantity: line.quantity as number,
          unit_amount: line.unit_amount as number,
          account_code: selectedLineValues[index]?.account.code as string,
          tax_type: selectedLineValues[index]?.taxRate.taxType as string,
        })),
      };
      resolvedSourceSha256 ??= hashObject(canonicalDraftExtractionFingerprint(normalizedDraftFields));
      const proposalWithoutRequestId = {
        ...normalizedDraftFields,
        source_sha256: resolvedSourceSha256,
        source_evidence_type: sourceTrust,
      };
      proposal = {
        request_id: `xero-draft:${hashObject(proposalWithoutRequestId).slice(0, 48)}`,
        ...proposalWithoutRequestId,
      };
    }

    const evidenceSourceSha256 = resolvedSourceSha256 ?? hashObject({
      source_ref: input.source_ref ?? null,
      supplier_name: input.supplier_name ?? null,
      supplier_contact_number: input.supplier_contact_number ?? null,
      invoice_date: input.invoice_date ?? null,
      due_date: input.due_date ?? null,
      currency: input.currency ?? null,
      reference: input.reference ?? null,
      line_amount_type: input.line_amount_type ?? null,
      lines: input.lines ?? [],
    });
    const technicallyReady = proposal !== null;

    return {
      technicallyReady,
      readyForUserConfirmation: technicallyReady,
      requiresUserConfirmation: true,
      executionAllowed: false,
      proposal,
      evidence: {
        tenant: referenceData.tenant,
        source: {
          ...(input.source_ref ? { ref: input.source_ref } : {}),
          sha256: evidenceSourceSha256,
          trust: sourceTrust,
        },
        supplier: {
          ...(input.supplier_name ? { requestedName: input.supplier_name } : {}),
          ...(input.supplier_contact_number ? { requestedContactNumber: input.supplier_contact_number } : {}),
          exactMatches: exactContacts,
          ...(selectedContact ? { selected: selectedContact } : {}),
        },
        lines: lineEvidence,
        sourceCounts: {
          contacts: referenceData.contacts.length,
          contactsComplete: referenceData.contactsComplete,
          accounts: referenceData.accounts.length,
          taxRates: referenceData.taxRates.length,
        },
      },
      blockers,
      warnings,
      preparation_id: null,
      confirmation_phrase: null,
      expires_at: null,
    };
  }

  async prepareSalesInvoiceDraft(
    principal: AccountingPrincipal,
    input: PrepareSalesInvoiceDraftInput,
  ): Promise<SalesInvoiceDraftPreparationResult> {
    const prepared = await this.#prepareSupplierBillDraftProposal(principal, {
      ...(input.source_ref ? { source_ref: input.source_ref } : {}),
      ...(input.source_sha256 ? { source_sha256: input.source_sha256 } : {}),
      ...(input.customer_name ? { supplier_name: input.customer_name } : {}),
      ...(input.customer_contact_number ? { supplier_contact_number: input.customer_contact_number } : {}),
      ...(input.invoice_date ? { invoice_date: input.invoice_date } : {}),
      ...(input.due_date ? { due_date: input.due_date } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
      ...(input.line_amount_type ? { line_amount_type: input.line_amount_type } : {}),
      ...(input.lines ? { lines: input.lines } : {}),
    });

    let proposal = prepared.proposal as Omit<CreateDraftSalesInvoiceInput, "user_confirmation"> | null;
    if (proposal) {
      const sourceSha256 = proposal.source_evidence_type === "SERVER_FINGERPRINTED_EXTRACTION"
        ? hashObject(canonicalSalesInvoiceDraftExtractionFingerprint({
            ...proposal,
            user_confirmation: "CONFIRMED_FOR_DRAFT",
          }))
        : proposal.source_sha256;
      const { request_id: _supplierRequestId, ...proposalFields } = proposal;
      const proposalWithoutRequestId = {
        ...proposalFields,
        source_sha256: sourceSha256,
      };
      proposal = {
        request_id: `xero-accrec-draft:${hashObject(proposalWithoutRequestId).slice(0, 48)}`,
        ...proposalWithoutRequestId,
      };
    }

    const blockers = prepared.blockers.map((blocker) => ({
      ...blocker,
      path: blocker.path
        .replace(/^supplier_name$/, "customer_name")
        .replace(/^supplier_contact_number$/, "customer_contact_number"),
      message: blocker.message
        .replace(/supplier bill/gi, "sales invoice")
        .replace(/supplier identity/gi, "customer identity")
        .replace(/supplier/gi, "customer"),
    }));
    const source = proposal && proposal.source_sha256 !== prepared.evidence.source.sha256
      ? { ...prepared.evidence.source, sha256: proposal.source_sha256 }
      : prepared.evidence.source;
    const { supplier, ...commonEvidence } = prepared.evidence;
    const result = {
      ...prepared,
      proposal,
      blockers,
      evidence: {
        ...commonEvidence,
        source,
        customer: supplier,
      },
    } as SalesInvoiceDraftPreparationResult;
    const confirmation = await this.#persistInvoiceDraftPreparation(
      principal,
      result.proposal,
      "SALES_INVOICE",
    );
    return { ...result, ...confirmation };
  }

  async #persistInvoiceDraftPreparation(
    principal: AccountingPrincipal,
    proposal: Omit<CreateDraftSupplierBillInput, "user_confirmation"> | null,
    objectType: "SUPPLIER_BILL" | "SALES_INVOICE",
  ): Promise<Pick<
    SupplierBillDraftPreparationResult,
    "preparation_id" | "confirmation_phrase" | "expires_at"
  >> {
    if (!proposal) {
      return { preparation_id: null, confirmation_phrase: null, expires_at: null };
    }
    if (!this.#mutationFoundation) {
      if (typeof principal === "string") {
        return { preparation_id: null, confirmation_phrase: null, expires_at: null };
      }
      throw new AppError(
        "CONFIGURATION_ERROR",
        "The one-time Xero invoice confirmation service is unavailable.",
        { httpStatus: 503 },
      );
    }
    const context = this.#requestContext(principal);
    const label = objectType === "SUPPLIER_BILL" ? "Supplier Bill" : "Sales Invoice";
    const persisted = await this.#mutationFoundation.prepare(context, {
      objectType,
      operation: "CREATE_DRAFT",
      canonicalPayload: proposal as unknown as Record<string, unknown>,
      sourceRef: proposal.source_ref,
      sourceUnitKey: `document:${proposal.source_sha256}`,
      ...(proposal.source_evidence_type === "AGENT_ASSERTED_UNVERIFIED"
        ? { sourceSha256: proposal.source_sha256 }
        : {}),
      sourceEvidenceType: proposal.source_evidence_type,
      confirmationDetails: {
        contactId: proposal.contact_id,
        reference: proposal.reference,
        invoiceDate: proposal.invoice_date,
        dueDate: proposal.due_date,
        currency: proposal.currency,
        lineCount: proposal.lines.length,
        enteredLineSubtotal: proposal.lines
          .reduce((total, line) => total + line.quantity * line.unit_amount, 0)
          .toFixed(4),
        status: "DRAFT",
      },
      confirmationPhrase: `确认创建 ${label} DRAFT｜Reference ${proposal.reference.slice(0, 48)}`,
    });
    return {
      preparation_id: persisted.preparationId,
      confirmation_phrase: persisted.confirmationPhrase,
      expires_at: persisted.expiresAt.toISOString(),
    };
  }

  async executePreparedSupplierBillDraft(
    principal: AccountingPrincipal,
    input: ExecutePreparedXeroMutationInput,
  ): Promise<DraftSupplierBillResult & { mutationRequestId: string }> {
    const result = await this.#executePreparedInvoiceDraft(principal, input, "SUPPLIER_BILL");
    return result as DraftSupplierBillResult & { mutationRequestId: string };
  }

  async executePreparedSalesInvoiceDraft(
    principal: AccountingPrincipal,
    input: ExecutePreparedXeroMutationInput,
  ): Promise<DraftSalesInvoiceResult & { mutationRequestId: string }> {
    const result = await this.#executePreparedInvoiceDraft(principal, input, "SALES_INVOICE");
    return result as DraftSalesInvoiceResult & { mutationRequestId: string };
  }

  async #executePreparedInvoiceDraft(
    principal: AccountingPrincipal,
    input: ExecutePreparedXeroMutationInput,
    objectType: "SUPPLIER_BILL" | "SALES_INVOICE",
  ): Promise<(DraftSupplierBillResult | DraftSalesInvoiceResult) & { mutationRequestId: string }> {
    const mutations = this.#requireMutationFoundation();
    const resolved = await this.#provider.resolveContext(principal);
    this.#assertWriteAllowed(principal, resolved.tenantId);
    const context = this.#requestContext(principal);
    const confirmed = await mutations.confirm(context, {
      preparationId: input.preparation_id,
      requestId: input.request_id,
      confirmationPhrase: input.confirmation_phrase,
    }, { objectType, operation: "CREATE_DRAFT" });
    if (["FAILED_VALIDATION", "PROVIDER_REJECTED"].includes(confirmed.state)) {
      throw new AppError(
        "APPROVAL_INVALID",
        "This one-time confirmation was already consumed by a terminal failed attempt; prepare and confirm a new proposal.",
        { httpStatus: 409 },
      );
    }
    const parsed = createDraftSupplierBillSchema.safeParse({
      ...confirmed.canonicalPayload,
      user_confirmation: "CONFIRMED_FOR_DRAFT",
    });
    if (!parsed.success) {
      await mutations.failValidation(context, {
        mutationRequestId: confirmed.mutationRequestId,
        validationReceipt: { reasonCode: "PERSISTED_INVOICE_PROPOSAL_INVALID" },
      });
      throw new AppError("APPROVAL_INVALID", "The persisted Xero invoice proposal is invalid.", {
        httpStatus: 409,
      });
    }

    let genericStartAttempted = false;
    let started: Awaited<ReturnType<XeroMutationService["start"]>> | undefined;
    const claimGenericWrite = async (): Promise<void> => {
      genericStartAttempted = true;
      started = await mutations.start(context, { mutationRequestId: confirmed.mutationRequestId });
      if (started.mode !== "CALL_PROVIDER") {
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "This confirmed mutation is already being executed or recovered; no second Xero create is allowed.",
          { httpStatus: 409, retryable: false },
        );
      }
    };

    let written: DraftSupplierBillResult | DraftSalesInvoiceResult;
    try {
      written = objectType === "SUPPLIER_BILL"
        ? await this.#createDraftSupplierBill(principal, parsed.data, claimGenericWrite)
        : await this.#createDraftSalesInvoice(principal, parsed.data, claimGenericWrite);
    } catch (error) {
      const safe = toSafeError(error);
      if (!genericStartAttempted && ["VALIDATION_FAILED", "CONFLICT"].includes(safe.code)) {
        await mutations.failValidation(context, {
          mutationRequestId: confirmed.mutationRequestId,
          validationReceipt: { reasonCode: safe.code, message: safe.message },
        });
      } else if (started?.mode === "CALL_PROVIDER" && isDefiniteProviderWriteRejection(safe)) {
        await mutations.rejectProvider(context, {
          mutationRequestId: confirmed.mutationRequestId,
          providerRejectionReceipt: {
            reasonCode: safe.code,
            message: safe.message,
            writeOutcome: "DEFINITELY_REJECTED",
          },
        });
      } else if (started?.mode === "CALL_PROVIDER") {
        try {
          await mutations.markUnknown(context, { mutationRequestId: confirmed.mutationRequestId });
        } catch (persistenceError) {
          this.#logger.warn("Generic invoice mutation uncertainty transition was skipped.", {
            mutationRequestId: confirmed.mutationRequestId,
            errorClass: persistenceError instanceof Error ? persistenceError.name : "UnknownError",
          });
        }
      }
      throw error;
    }

    try {
      const writeClaim = started ?? await mutations.start(context, {
        mutationRequestId: confirmed.mutationRequestId,
      });
      if (writeClaim.mode !== "ALREADY_VERIFIED") {
        const writeReceipt = writeClaim.request.writeReceipt ?? {
          postingRequestId: written.postingRequestId,
          providerReceipt: written.providerReceipt,
        };
        if (!writeClaim.request.writeReceipt) {
          try {
            if (writeClaim.mode === "CALL_PROVIDER") {
              await mutations.recordWriteEvidence(context, {
                mutationRequestId: confirmed.mutationRequestId,
                xeroObjectId: written.invoiceId,
                writeReceipt,
              });
            } else {
              // RECOVER_ONLY means the generic lifecycle already crossed the
              // provider boundary. The legacy posting flow has now supplied
              // exact, read-back evidence, so persist it without reopening the
              // provider claim or issuing a second create.
              await mutations.markUnknown(context, {
                mutationRequestId: confirmed.mutationRequestId,
                xeroObjectId: written.invoiceId,
                writeReceipt,
              });
            }
          } catch (error) {
            // Another instance can persist and even verify the same evidence
            // between our start snapshot and this completion. The exact
            // markReadbackVerified call below is the authoritative compatibility
            // check, so only that benign state-transition race is retried there.
            if (toSafeError(error).code !== "CONFLICT") throw error;
          }
        }
        await mutations.markReadbackVerified(context, {
          mutationRequestId: confirmed.mutationRequestId,
          writeReceipt,
          verifiedReadback: {
            xeroObjectId: written.invoiceId,
            status: "DRAFT",
            canonicalPayload: confirmed.canonicalPayload,
            evidence: {
              postingRequestId: written.postingRequestId,
              readbackVerified: written.readbackVerified,
            },
          },
        });
      }
    } catch (error) {
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The Xero DRAFT was read back, but its one-time confirmation receipt was not durably completed; do not create again.",
        {
          httpStatus: 503,
          retryable: false,
          details: { invoiceId: written.invoiceId, postingRequestId: written.postingRequestId },
          cause: error,
        },
      );
    }
    return { ...written, mutationRequestId: confirmed.mutationRequestId };
  }

  async getSupplierBill(principal: AccountingPrincipal, invoiceId: string) {
    return boundInvoiceForAgent(await this.#provider.getSupplierBill(principal, invoiceId)) as SupplierBillSnapshot;
  }

  listInvoices(principal: AccountingPrincipal, input: ListInvoicesInput) {
    return this.#provider.listInvoices(principal, input);
  }

  listCreditNotes(principal: AccountingPrincipal, input: ListCreditNotesInput) {
    return this.#provider.listCreditNotes(principal, input);
  }

  prepareCreditNoteDraft(principal: AccountingPrincipal, input: PrepareCreditNoteDraftInput) {
    return this.#requireCreditNoteManualJournalMutations()
      .prepareCreditNoteDraft(this.#requestContext(principal), input);
  }

  createCreditNoteDraft(principal: AccountingPrincipal, input: ExecutePreparedXeroMutationInput) {
    return this.#requireCreditNoteManualJournalMutations()
      .createCreditNoteDraft(this.#requestContext(principal), input);
  }

  listPayments(principal: AccountingPrincipal, input: ListPaymentsInput) {
    return this.#provider.listPayments(principal, input);
  }

  listQuotes(principal: AccountingPrincipal, input: ListQuotesInput) {
    return this.#provider.listQuotes(principal, input);
  }

  getQuote(principal: AccountingPrincipal, input: GetQuoteInput) {
    return this.#provider.getQuote(principal, input.quote_id);
  }

  listPurchaseOrders(principal: AccountingPrincipal, input: ListPurchaseOrdersInput) {
    return this.#provider.listPurchaseOrders(principal, input);
  }

  getPurchaseOrder(principal: AccountingPrincipal, input: GetPurchaseOrderInput) {
    return this.#provider.getPurchaseOrder(principal, input.purchase_order_id);
  }

  prepareQuoteDraft(principal: AccountingPrincipal, input: PrepareQuoteDraftInput) {
    return this.#requireControlledMutations().prepareQuoteDraft(this.#requestContext(principal), input);
  }

  createQuoteDraft(principal: AccountingPrincipal, input: ExecutePreparedXeroMutationInput) {
    return this.#requireControlledMutations().createQuoteDraft(this.#requestContext(principal), input);
  }

  preparePurchaseOrderDraft(principal: AccountingPrincipal, input: PreparePurchaseOrderDraftInput) {
    return this.#requireControlledMutations().preparePurchaseOrderDraft(this.#requestContext(principal), input);
  }

  createPurchaseOrderDraft(principal: AccountingPrincipal, input: ExecutePreparedXeroMutationInput) {
    return this.#requireControlledMutations().createPurchaseOrderDraft(this.#requestContext(principal), input);
  }

  listManualJournals(principal: AccountingPrincipal, input: ListManualJournalsInput) {
    return this.#provider.listManualJournals(principal, input);
  }

  getManualJournal(principal: AccountingPrincipal, input: GetManualJournalInput) {
    return this.#provider.getManualJournal(principal, input.manual_journal_id);
  }

  prepareManualJournalDraft(principal: AccountingPrincipal, input: PrepareManualJournalDraftInput) {
    return this.#requireCreditNoteManualJournalMutations()
      .prepareManualJournalDraft(this.#requestContext(principal), input);
  }

  createManualJournalDraft(principal: AccountingPrincipal, input: ExecutePreparedXeroMutationInput) {
    return this.#requireCreditNoteManualJournalMutations()
      .createManualJournalDraft(this.#requestContext(principal), input);
  }

  listItems(principal: AccountingPrincipal, input: ListItemsInput) {
    return this.#provider.listItems(principal, input);
  }

  getItem(principal: AccountingPrincipal, input: GetItemInput) {
    return this.#provider.getItem(principal, input.item_id);
  }

  prepareContactCreate(principal: AccountingPrincipal, input: PrepareContactCreateMutationInput) {
    return this.#requireContactItemMutations().prepareContactCreate(this.#requestContext(principal), input);
  }

  createContact(principal: AccountingPrincipal, input: ExecutePreparedXeroMutationInput) {
    return this.#requireContactItemMutations().createContact(this.#requestContext(principal), input);
  }

  prepareContactUpdate(principal: AccountingPrincipal, input: PrepareContactUpdateMutationInput) {
    return this.#requireContactItemMutations().prepareContactUpdate(this.#requestContext(principal), input);
  }

  updateContact(principal: AccountingPrincipal, input: ExecutePreparedXeroMutationInput) {
    return this.#requireContactItemMutations().updateContact(this.#requestContext(principal), input);
  }

  prepareItemCreate(principal: AccountingPrincipal, input: PrepareItemCreateMutationInput) {
    return this.#requireContactItemMutations().prepareItemCreate(this.#requestContext(principal), input);
  }

  createItem(principal: AccountingPrincipal, input: ExecutePreparedXeroMutationInput) {
    return this.#requireContactItemMutations().createItem(this.#requestContext(principal), input);
  }

  prepareItemUpdate(principal: AccountingPrincipal, input: PrepareItemUpdateMutationInput) {
    return this.#requireContactItemMutations().prepareItemUpdate(this.#requestContext(principal), input);
  }

  updateItem(principal: AccountingPrincipal, input: ExecutePreparedXeroMutationInput) {
    return this.#requireContactItemMutations().updateItem(this.#requestContext(principal), input);
  }

  listBankTransactions(principal: AccountingPrincipal, input: ListBankTransactionsInput) {
    return this.#provider.listBankTransactions(principal, input);
  }

  getBankTransaction(principal: AccountingPrincipal, input: GetBankTransactionInput) {
    return this.#provider.getBankTransaction(principal, input.bank_transaction_id);
  }

  async getInvoice(principal: AccountingPrincipal, input: GetInvoiceInput) {
    return boundInvoiceForAgent(await this.#provider.getInvoice(principal, input.invoice_id, input.type));
  }

  async getTrialBalance(principal: AccountingPrincipal, input: TrialBalanceInput) {
    return boundXeroTrialBalanceForAgent(await this.#provider.getTrialBalance(principal, input.date));
  }

  async createDraftSupplierBill(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
  ): Promise<DraftSupplierBillResult> {
    return this.#createDraftSupplierBill(principal, input);
  }

  async #createDraftSupplierBill(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
    beforeProviderCreate?: () => Promise<void>,
  ): Promise<DraftSupplierBillResult> {
    if (
      input.source_evidence_type === "SERVER_FINGERPRINTED_EXTRACTION" &&
      !safeEqual(input.source_sha256, hashObject(canonicalDraftExtractionFingerprint(input)))
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "source_sha256 does not match the server fingerprint of the normalized supplier bill proposal.",
        { httpStatus: 422 },
      );
    }
    const context = await this.#provider.resolveContext(principal);
    this.#assertWriteAllowed(principal, context.tenantId);
    const actorId = principalActorId(principal);
    const supplierIdentity = xeroSupplierPostingIdentity({
      contactId: input.contact_id,
      reference: input.reference,
    });
    const duplicate = await this.#repository.findActivePostingDuplicate({
      tenantId: context.tenantId,
      sourceSha256: input.source_sha256,
      ...supplierIdentity,
    });
    if (duplicate && (duplicate.actorId !== actorId || duplicate.requestId !== input.request_id)) {
      throw new AppError(
        "CONFLICT",
        "This source document or supplier reference already has an active Xero posting request.",
        {
          httpStatus: 409,
          details: {
            duplicatePostingRequestId: duplicate.postingRequestId,
            duplicateState: duplicate.state,
          },
        },
      );
    }
    await this.#validateDraftContext(principal, input);

    const canonicalRequest = canonicalDraftRequest(context.tenantId, input);
    const requestPayloadHash = hashObject(canonicalRequest);
    const createIdempotencyKey = `zc:create:${sha256(`${actorId}:${context.tenantId}:${input.request_id}:${requestPayloadHash}`)}`;
    const created = await this.#repository.createOrGetPosting({
      postingRequestId: `pr_${randomUUID()}`,
      actorId,
      tenantId: context.tenantId,
      sourceRef: input.source_ref,
      sourceSha256: input.source_sha256,
      sourceEvidenceType: input.source_evidence_type,
      providerPayload: canonicalRequest,
      requestPayloadHash,
      providerPayloadHash: requestPayloadHash,
      requestId: input.request_id,
      createIdempotencyKey,
    });

    if (!created.created) {
      if (created.posting.actorId !== actorId || created.posting.requestId !== input.request_id) {
        throw new AppError(
          "CONFLICT",
          "This source document or supplier reference already has an active Xero posting request.",
          {
            httpStatus: 409,
            details: {
              duplicatePostingRequestId: created.posting.postingRequestId,
              duplicateState: created.posting.state,
            },
          },
        );
      }
      if (created.posting.requestPayloadHash !== requestPayloadHash) {
        throw new AppError("CONFLICT", "request_id was already used with a different supplier bill payload.", {
          httpStatus: 409,
        });
      }
      return this.#resolveExistingDraftRequest(principal, input, created.posting);
    }

    let written: ProviderWriteResult | undefined;
    let writeEvidencePersisted = false;
    try {
      await beforeProviderCreate?.();
      written = await this.#provider.createDraftSupplierBill(
        principal,
        input,
        createIdempotencyKey,
        async (evidence) => {
          await this.#repository.markDraftWriteUnknown(
            created.posting.postingRequestId,
            evidence.invoiceId,
            evidence.receipt,
          );
          writeEvidencePersisted = true;
        },
      );
      this.#verifyDraftReadback(context.tenantId, input, written.bill);
      const canonicalReadback = canonicalBillForApproval(written.bill);
      const approvedPayloadHash = hashObject(canonicalReadback);
      const completion = {
        xeroInvoiceId: written.bill.invoiceId,
        providerPayload: written.bill as unknown as Record<string, unknown>,
        providerPayloadHash: approvedPayloadHash,
        writeReceipt: written.receipt,
        readbackSnapshot: written.bill as unknown as Record<string, unknown>,
      };
      const posting = writeEvidencePersisted
        ? await this.#repository.recoverDraftCreated(created.posting.postingRequestId, completion)
        : await this.#repository.markDraftCreated(created.posting.postingRequestId, completion);
      return {
        postingRequestId: posting.postingRequestId,
        invoiceId: written.bill.invoiceId,
        status: written.bill.status,
        approvedPayloadHash,
        providerReceipt: written.receipt,
        readbackVerified: true,
        reviewUrl: `${this.#config.publicBaseUrl}/review/${posting.postingRequestId}`,
        bill: written.bill,
        idempotentReplay: false,
      };
    } catch (error) {
      const safe = toSafeError(error);
      if (safe.code === "WRITE_RESULT_UNKNOWN") {
        const invoiceId = written?.bill.invoiceId ??
          (typeof safe.details?.invoiceId === "string" ? safe.details.invoiceId : undefined);
        await this.#tryMarkDraftWriteUnknown(created.posting.postingRequestId, invoiceId);
      } else if (safe.code === "READBACK_MISMATCH") {
        if (written) {
          try {
            await this.#repository.markDraftReadbackMismatch(created.posting.postingRequestId, {
              xeroInvoiceId: written.bill.invoiceId,
              writeReceipt: written.receipt,
              readbackSnapshot: written.bill as unknown as Record<string, unknown>,
            });
          } catch (persistenceError) {
            const persistenceSafe = toSafeError(persistenceError);
            if (persistenceSafe.code !== "CONFLICT") {
              await this.#tryMarkDraftWriteUnknown(created.posting.postingRequestId, written.bill.invoiceId);
              throw new AppError(
                "WRITE_RESULT_UNKNOWN",
                "Xero returned a DRAFT but its mismatched readback evidence could not be persisted; no retry is allowed.",
                {
                  httpStatus: 503,
                  retryable: false,
                  cause: persistenceError,
                  details: {
                    postingRequestId: created.posting.postingRequestId,
                    invoiceId: written.bill.invoiceId,
                  },
                },
              );
            }
          }
        } else {
          await this.#tryMarkDraftFailure(created.posting.postingRequestId, "READBACK_MISMATCH");
        }
      } else if (written) {
        // The Provider returned an exact, verified DRAFT before durable local
        // completion failed. This is never a validation-only failure: releasing
        // the business duplicate guard could let a new request create a second
        // Xero document. Preserve the known InvoiceID and require readback-only
        // recovery under the original request instead.
        await this.#tryMarkDraftWriteUnknown(created.posting.postingRequestId, written.bill.invoiceId);
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "Xero returned a verified DRAFT but durable completion is unconfirmed; no second create is allowed.",
          {
            httpStatus: 503,
            retryable: false,
            cause: error,
            details: {
              postingRequestId: created.posting.postingRequestId,
              invoiceId: written.bill.invoiceId,
            },
          },
        );
      } else if (isDefiniteProviderWriteRejection(safe)) {
        await this.#tryMarkDraftFailure(created.posting.postingRequestId, "BLOCKED_VALIDATION");
      } else {
        await this.#tryMarkDraftWriteUnknown(created.posting.postingRequestId);
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "The Xero supplier-bill write outcome is not definitely rejected; no second create is allowed.",
          {
            httpStatus: 502,
            retryable: false,
            cause: error,
            details: { postingRequestId: created.posting.postingRequestId },
          },
        );
      }
      throw safe;
    }
  }

  async createDraftSalesInvoice(
    principal: AccountingPrincipal,
    input: CreateDraftSalesInvoiceInput,
  ): Promise<DraftSalesInvoiceResult> {
    return this.#createDraftSalesInvoice(principal, input);
  }

  async #createDraftSalesInvoice(
    principal: AccountingPrincipal,
    input: CreateDraftSalesInvoiceInput,
    beforeProviderCreate?: () => Promise<void>,
  ): Promise<DraftSalesInvoiceResult> {
    if (
      input.source_evidence_type === "SERVER_FINGERPRINTED_EXTRACTION" &&
      !safeEqual(input.source_sha256, hashObject(canonicalSalesInvoiceDraftExtractionFingerprint(input)))
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "source_sha256 does not match the server fingerprint of the normalized sales invoice proposal.",
        { httpStatus: 422 },
      );
    }
    const context = await this.#provider.resolveContext(principal);
    this.#assertWriteAllowed(principal, context.tenantId);
    const actorId = principalActorId(principal);
    const identity = xeroSupplierPostingIdentity({
      invoiceType: "ACCREC",
      contactId: input.contact_id,
      reference: input.reference,
    });
    const duplicate = await this.#repository.findActivePostingDuplicate({
      tenantId: context.tenantId,
      sourceSha256: input.source_sha256,
      ...identity,
    });
    if (duplicate && (
      duplicate.documentType !== "ACCREC" ||
      duplicate.actorId !== actorId ||
      duplicate.requestId !== input.request_id
    )) {
      throw new AppError(
        "CONFLICT",
        "This source document or accounting-document reference already has an active Xero posting request.",
        {
          httpStatus: 409,
          details: {
            duplicatePostingRequestId: duplicate.postingRequestId,
            duplicateState: duplicate.state,
          },
        },
      );
    }
    await this.#validateDraftContext(principal, input);

    const canonicalRequest = canonicalSalesInvoiceDraftRequest(context.tenantId, input);
    const requestPayloadHash = hashObject(canonicalRequest);
    const createIdempotencyKey = `zc:create:ACCREC:${sha256(`${actorId}:${context.tenantId}:${input.request_id}:${requestPayloadHash}`)}`;
    const created = await this.#repository.createOrGetPosting({
      postingRequestId: `pr_${randomUUID()}`,
      actorId,
      tenantId: context.tenantId,
      sourceRef: input.source_ref,
      sourceSha256: input.source_sha256,
      sourceEvidenceType: input.source_evidence_type,
      documentType: "ACCREC",
      providerPayload: canonicalRequest,
      requestPayloadHash,
      providerPayloadHash: requestPayloadHash,
      requestId: input.request_id,
      createIdempotencyKey,
    });

    if (!created.created) {
      if (
        created.posting.documentType !== "ACCREC" ||
        created.posting.actorId !== actorId ||
        created.posting.requestId !== input.request_id
      ) {
        throw new AppError(
          "CONFLICT",
          "This source document or accounting-document reference already has an active Xero posting request.",
          {
            httpStatus: 409,
            details: {
              duplicatePostingRequestId: created.posting.postingRequestId,
              duplicateState: created.posting.state,
            },
          },
        );
      }
      if (created.posting.requestPayloadHash !== requestPayloadHash) {
        throw new AppError("CONFLICT", "request_id was already used with a different sales invoice payload.", {
          httpStatus: 409,
        });
      }
      return this.#resolveExistingSalesInvoiceDraftRequest(principal, input, created.posting);
    }

    let written: ProviderSalesInvoiceWriteResult | undefined;
    let writeEvidencePersisted = false;
    try {
      await beforeProviderCreate?.();
      written = await this.#provider.createDraftSalesInvoice(
        principal,
        input,
        createIdempotencyKey,
        async (evidence) => {
          await this.#repository.markDraftWriteUnknown(
            created.posting.postingRequestId,
            evidence.invoiceId,
            evidence.receipt,
          );
          writeEvidencePersisted = true;
        },
      );
      this.#verifySalesInvoiceDraftReadback(context.tenantId, input, written.invoice);
      const approvedPayloadHash = hashObject(canonicalInvoiceForApproval(written.invoice));
      const completion = {
        xeroInvoiceId: written.invoice.invoiceId,
        providerPayload: written.invoice as unknown as Record<string, unknown>,
        providerPayloadHash: approvedPayloadHash,
        writeReceipt: written.receipt,
        readbackSnapshot: written.invoice as unknown as Record<string, unknown>,
      };
      const posting = writeEvidencePersisted
        ? await this.#repository.recoverDraftCreated(created.posting.postingRequestId, completion)
        : await this.#repository.markDraftCreated(created.posting.postingRequestId, completion);
      return {
        postingRequestId: posting.postingRequestId,
        invoiceId: written.invoice.invoiceId,
        status: written.invoice.status,
        verifiedPayloadHash: approvedPayloadHash,
        providerReceipt: written.receipt,
        readbackVerified: true,
        invoice: written.invoice,
        idempotentReplay: false,
      };
    } catch (error) {
      const safe = toSafeError(error);
      if (safe.code === "WRITE_RESULT_UNKNOWN") {
        const invoiceId = written?.invoice.invoiceId ??
          (typeof safe.details?.invoiceId === "string" ? safe.details.invoiceId : undefined);
        await this.#tryMarkDraftWriteUnknown(created.posting.postingRequestId, invoiceId);
      } else if (safe.code === "READBACK_MISMATCH") {
        if (written) {
          try {
            await this.#repository.markDraftReadbackMismatch(created.posting.postingRequestId, {
              xeroInvoiceId: written.invoice.invoiceId,
              writeReceipt: written.receipt,
              readbackSnapshot: written.invoice as unknown as Record<string, unknown>,
            });
          } catch (persistenceError) {
            const persistenceSafe = toSafeError(persistenceError);
            if (persistenceSafe.code !== "CONFLICT") {
              await this.#tryMarkDraftWriteUnknown(created.posting.postingRequestId, written.invoice.invoiceId);
              throw new AppError(
                "WRITE_RESULT_UNKNOWN",
                "Xero returned an ACCREC DRAFT but its mismatched readback evidence could not be persisted; no retry is allowed.",
                {
                  httpStatus: 503,
                  retryable: false,
                  cause: persistenceError,
                  details: {
                    postingRequestId: created.posting.postingRequestId,
                    invoiceId: written.invoice.invoiceId,
                  },
                },
              );
            }
          }
        } else {
          await this.#tryMarkDraftFailure(created.posting.postingRequestId, "READBACK_MISMATCH");
        }
      } else if (written) {
        await this.#tryMarkDraftWriteUnknown(created.posting.postingRequestId, written.invoice.invoiceId);
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "Xero returned a verified ACCREC DRAFT but durable completion is unconfirmed; no second create is allowed.",
          {
            httpStatus: 503,
            retryable: false,
            cause: error,
            details: {
              postingRequestId: created.posting.postingRequestId,
              invoiceId: written.invoice.invoiceId,
            },
          },
        );
      } else if (isDefiniteProviderWriteRejection(safe)) {
        await this.#tryMarkDraftFailure(created.posting.postingRequestId, "BLOCKED_VALIDATION");
      } else {
        await this.#tryMarkDraftWriteUnknown(created.posting.postingRequestId);
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "The Xero sales-invoice write outcome is not definitely rejected; no second create is allowed.",
          {
            httpStatus: 502,
            retryable: false,
            cause: error,
            details: { postingRequestId: created.posting.postingRequestId },
          },
        );
      }
      throw safe;
    }
  }

  async authoriseSupplierBill(
    principal: AccountingPrincipal,
    input: AuthoriseSupplierBillInput,
  ): Promise<AuthoriseSupplierBillResult> {
    if (isOAuthPrincipal(principal)) {
      throw new AppError("FORBIDDEN", "OAuth accounting agents may create drafts but cannot authorise bills.", {
        httpStatus: 403,
      });
    }
    return this.#authoriseWithApprovalHash(principal, {
      postingRequestId: input.posting_request_id,
      invoiceId: input.invoice_id,
      approvalRefHash: sha256(input.approval_ref),
      approvedPayloadHash: input.approved_payload_hash,
      requestId: input.request_id,
    });
  }

  async authoriseReviewedSupplierBill(
    actorId: string,
    input: { postingRequestId: string; sessionHash: string; csrfToken: string },
  ): Promise<AuthoriseSupplierBillResult> {
    const posting = await this.#repository.getPosting(input.postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
    if (posting.documentType !== "ACCPAY") {
      throw new AppError("FORBIDDEN", "Only ACCPAY supplier bills can enter the authorisation workflow.", {
        httpStatus: 403,
      });
    }
    if (isCanonicalOAuthActorId(posting.actorId)) {
      throw new AppError(
        "FORBIDDEN",
        "Browser review authorisation is disabled for OAuth-bound agent postings until review sessions carry the trusted binding context.",
        { httpStatus: 403 },
      );
    }
    if (!posting.xeroInvoiceId) {
      throw new AppError("CONFLICT", "Posting request has no Xero draft invoice.", { httpStatus: 409 });
    }
    if (posting.actorId !== actorId) {
      throw new AppError("FORBIDDEN", "Posting request belongs to another actor.", { httpStatus: 403 });
    }
    if (![
      "APPROVAL_PENDING",
      "APPROVED",
      "AUTHORISING",
      "WRITE_RESULT_UNKNOWN",
      "AUTHORISED_READBACK_VERIFIED",
    ].includes(posting.state)) {
      throw new AppError("APPROVAL_REQUIRED", `Posting request cannot be approved from ${posting.state}.`, {
        httpStatus: 409,
      });
    }

    // A verified terminal replay is a local evidence read, not a write. Keep it
    // available if Xero is unavailable or the deployment write gate is later
    // closed. Every non-terminal branch still resolves and gates the exact
    // connected tenant before Review CSRF is consumed or a write is claimed.
    let tenantId = posting.tenantId;
    if (posting.state !== "AUTHORISED_READBACK_VERIFIED") {
      const context = await this.#provider.resolveContext(actorId);
      this.#assertWriteAllowed(actorId, context.tenantId);
      this.#assertPostingIdentity(posting, actorId, context.tenantId, posting.xeroInvoiceId);
      tenantId = context.tenantId;
    }

    if (posting.state === "APPROVAL_PENDING" || posting.state === "APPROVED") {
      let currentBill: SupplierBillSnapshot;
      try {
        currentBill = await this.#provider.getSupplierBill(actorId, posting.xeroInvoiceId);
      } catch (error) {
        throw toSafeError(error);
      }
      this.#assertApprovedDraft(posting, currentBill, posting.providerPayloadHash);
    }

    const requestId = `review:${posting.postingRequestId}:authorise`;
    const authoriseIdempotencyKey = this.#authoriseIdempotencyKey(
      tenantId,
      requestId,
      posting.postingRequestId,
    );
    const begin = await this.#repository.beginReviewAuthorise({
      postingRequestId: posting.postingRequestId,
      actorId,
      tenantId,
      invoiceId: posting.xeroInvoiceId,
      approvalRefHash: posting.approvalRefHash ?? sha256(randomBytes(32)),
      approvedPayloadHash: posting.providerPayloadHash,
      requestId,
      idempotencyKey: authoriseIdempotencyKey,
      sessionHash: input.sessionHash,
      csrfHash: sha256(input.csrfToken),
      approvalExpiresAt: new Date(Date.now() + 30 * 60_000),
      now: new Date(),
    });
    return this.#executeAuthoriseClaim(
      actorId,
      tenantId,
      posting.xeroInvoiceId,
      authoriseIdempotencyKey,
      begin,
    );
  }

  async #authoriseWithApprovalHash(
    principal: AccountingPrincipal,
    input: InternalAuthoriseInput,
  ): Promise<AuthoriseSupplierBillResult> {
    const context = await this.#provider.resolveContext(principal);
    this.#assertWriteAllowed(principal, context.tenantId);
    const actorId = principalActorId(principal);
    const posting = await this.#repository.getPosting(input.postingRequestId);
    if (!posting) throw new AppError("NOT_FOUND", "Posting request was not found.", { httpStatus: 404 });
    if (posting.documentType !== "ACCPAY") {
      throw new AppError("FORBIDDEN", "Only ACCPAY supplier bills can enter the authorisation workflow.", {
        httpStatus: 403,
      });
    }
    this.#assertPostingIdentity(posting, actorId, context.tenantId, input.invoiceId);

    if (posting.state === "APPROVED") {
      if (
        posting.approvalRefHash !== input.approvalRefHash ||
        posting.providerPayloadHash !== input.approvedPayloadHash
      ) {
        throw new AppError("APPROVAL_INVALID", "Approval is not bound to this payload and request.", {
          httpStatus: 409,
        });
      }
      const currentBill = await this.#provider.getSupplierBill(principal, input.invoiceId);
      this.#assertApprovedDraft(posting, currentBill, input.approvedPayloadHash);
    }

    const authoriseIdempotencyKey = this.#authoriseIdempotencyKey(
      context.tenantId,
      input.requestId,
      posting.postingRequestId,
    );
    const begin = await this.#repository.beginAuthorise({
      postingRequestId: posting.postingRequestId,
      actorId,
      tenantId: context.tenantId,
      invoiceId: input.invoiceId,
      approvalRefHash: input.approvalRefHash,
      approvedPayloadHash: input.approvedPayloadHash,
      requestId: input.requestId,
      idempotencyKey: authoriseIdempotencyKey,
      now: new Date(),
    });
    return this.#executeAuthoriseClaim(
      principal,
      context.tenantId,
      input.invoiceId,
      authoriseIdempotencyKey,
      begin,
    );
  }

  async #executeAuthoriseClaim(
    principal: AccountingPrincipal,
    tenantId: string,
    invoiceId: string,
    authoriseIdempotencyKey: string,
    begin: Awaited<ReturnType<AccountingRepository["beginAuthorise"]>>,
  ): Promise<AuthoriseSupplierBillResult> {
    if (begin.mode === "ALREADY_COMPLETE") {
      return this.#completedAuthoriseResult(begin.posting, true);
    }

    if (begin.mode === "RESUME_READBACK_ONLY") {
      return this.#resumeAuthoriseReadback(principal, tenantId, invoiceId, begin.posting);
    }

    let written: ProviderWriteResult;
    try {
      written = await this.#provider.authoriseSupplierBill(principal, invoiceId, authoriseIdempotencyKey);
    } catch (error) {
      const safe = toSafeError(error);
      await this.#tryMarkAuthoriseFailure(
        begin.posting.postingRequestId,
        safe.code === "WRITE_RESULT_UNKNOWN" ? "WRITE_RESULT_UNKNOWN" : "BLOCKED_VALIDATION",
      );
      throw safe;
    }

    const readbackHash = hashObject(canonicalBillForApproval(written.bill));
    if (
      written.bill.tenantId !== tenantId ||
      written.bill.invoiceId !== invoiceId ||
      written.bill.status !== "AUTHORISED" ||
      readbackHash !== begin.posting.providerPayloadHash
    ) {
      await this.#tryMarkAuthoriseFailure(begin.posting.postingRequestId, "READBACK_MISMATCH");
      throw new AppError("READBACK_MISMATCH", "Xero authorisation readback did not match the approved bill.", {
        httpStatus: 502,
      });
    }

    try {
      const completed = await this.#repository.completeAuthorise(
        begin.posting.postingRequestId,
        written.receipt,
        written.bill as unknown as Record<string, unknown>,
      );
      return this.#completedAuthoriseResult(completed, false);
    } catch (error) {
      await this.#tryMarkAuthoriseFailure(begin.posting.postingRequestId, "WRITE_RESULT_UNKNOWN");
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "Xero authorisation succeeded but durable completion is not yet confirmed; only readback recovery is allowed.",
        { httpStatus: 503, cause: error, details: { invoiceId } },
      );
    }
  }

  #authoriseIdempotencyKey(tenantId: string, requestId: string, postingRequestId: string): string {
    return `zc:authorise:${sha256(`${tenantId}:${requestId}:${postingRequestId}`)}`;
  }

  #assertApprovedDraft(
    posting: PostingRequest,
    currentBill: SupplierBillSnapshot,
    approvedPayloadHash: string,
  ): void {
    if (
      currentBill.tenantId !== posting.tenantId ||
      currentBill.invoiceId !== posting.xeroInvoiceId ||
      currentBill.status !== "DRAFT"
    ) {
      throw new AppError("READBACK_MISMATCH", "The Xero bill is no longer the approved DRAFT.", {
        httpStatus: 409,
      });
    }
    const currentHash = hashObject(canonicalBillForApproval(currentBill));
    if (currentHash !== approvedPayloadHash || currentHash !== posting.providerPayloadHash) {
      throw new AppError("APPROVAL_INVALID", "The Xero draft changed after review and must be reviewed again.", {
        httpStatus: 409,
      });
    }
  }

  async #resumeAuthoriseReadback(
    principal: AccountingPrincipal,
    tenantId: string,
    invoiceId: string,
    posting: PostingRequest,
  ): Promise<AuthoriseSupplierBillResult> {
    let currentBill: SupplierBillSnapshot;
    try {
      currentBill = await this.#provider.getSupplierBill(principal, invoiceId);
    } catch (error) {
      await this.#tryMarkAuthoriseFailure(posting.postingRequestId, "WRITE_RESULT_UNKNOWN");
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The prior authorisation result could not be read back; no Provider retry was attempted.",
        { httpStatus: 503, cause: error, details: { invoiceId } },
      );
    }

    const currentHash = hashObject(canonicalBillForApproval(currentBill));
    const identityAndPayloadMatch = currentBill.tenantId === tenantId &&
      currentBill.invoiceId === invoiceId &&
      currentHash === posting.providerPayloadHash;
    if (identityAndPayloadMatch && currentBill.status === "AUTHORISED") {
      try {
        const completed = await this.#repository.completeAuthorise(
          posting.postingRequestId,
          { operation: "AUTHORISE_RECOVERED_BY_READBACK", invoiceId },
          currentBill as unknown as Record<string, unknown>,
        );
        return this.#completedAuthoriseResult(completed, true);
      } catch (error) {
        await this.#tryMarkAuthoriseFailure(posting.postingRequestId, "WRITE_RESULT_UNKNOWN");
        throw new AppError(
          "WRITE_RESULT_UNKNOWN",
          "The AUTHORISED readback could not be durably completed; no Provider retry was attempted.",
          { httpStatus: 503, cause: error, details: { invoiceId } },
        );
      }
    }
    if (identityAndPayloadMatch && currentBill.status === "DRAFT") {
      await this.#tryMarkAuthoriseFailure(posting.postingRequestId, "WRITE_RESULT_UNKNOWN");
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The prior authorisation result is still unknown; no Provider retry was attempted.",
        { httpStatus: 409, details: { invoiceId } },
      );
    }

    await this.#tryMarkAuthoriseFailure(posting.postingRequestId, "READBACK_MISMATCH");
    throw new AppError("READBACK_MISMATCH", "Authorisation recovery readback did not match the approved bill.", {
      httpStatus: 409,
    });
  }

  async #tryMarkAuthoriseFailure(
    postingRequestId: string,
    state: "WRITE_RESULT_UNKNOWN" | "READBACK_MISMATCH" | "BLOCKED_VALIDATION",
  ): Promise<void> {
    try {
      await this.#repository.markAuthoriseFailure(postingRequestId, state);
    } catch (error) {
      this.#logger.error("Authorisation recovery state persistence failed.", {
        postingRequestId,
        targetState: state,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async withAudit<T>(options: {
    /** Optional boundary-generated ID so a successful mutation can return the exact persisted audit reference. */
    callId?: string;
    actorId: string;
    principal?: AccountingPrincipal;
    toolName: string;
    input: unknown;
    action: () => Promise<T>;
    recordId?: (result: T) => string | undefined;
    /**
     * Optional Agent-visible projection used only for the governance output hash.
     * The action result itself and all write receipts remain unchanged.
     */
    auditOutput?: (result: T) => unknown;
    governanceDisposition?: GovernanceDisposition;
    /** Connection status alone may report a disconnected state without a bound tenant. */
    allowUnresolvedTenant?: boolean;
    /** Receives the already-resolved server-side tenant context without causing a second Provider lookup. */
    onResolvedContext?: (context: ActorTenantContext | undefined) => void;
    /**
     * Re-resolves the server-owned binding after the Provider action and
     * withholds the result if the active organisation changed mid-call.
     * Ordinary MCP reads enable this to close the organisation-switch TOCTOU
     * window; connection-status checks deliberately remain control-plane only.
     */
    revalidateContextAfterAction?: boolean;
  }): Promise<T> {
    const callId = options.callId ?? `call_${randomUUID()}`;
    const startedAt = new Date();
    const requestHash = hashObject(options.input);
    let tenantId: string | undefined;
    try {
      const resolvedContext = await this.#provider.resolveContext(options.principal ?? options.actorId);
      tenantId = resolvedContext.tenantId;
      options.onResolvedContext?.(resolvedContext);
    } catch {
      // Connection status and failed connection calls are still audited without a tenant.
      options.onResolvedContext?.(undefined);
    }

    const intent: AuditIntent = {
      callId,
      actorId: options.actorId,
      toolName: options.toolName,
      requestHash,
      resultStatus: "IN_PROGRESS",
      startedAt,
    };
    if (tenantId) intent.tenantId = tenantId;
    await this.#beginAudit(intent);

    const principal = typeof options.principal === "object" ? options.principal : undefined;
    const streamId = principal?.oauthInstallationId
      ? `installation:${principal.oauthInstallationId}`
      : `actor:${options.actorId}`;
    const governanceBase = {
      streamId,
      schemaVersion: "zcloak.governance-event.v1" as const,
      source: principal ? "MCP" as const : "USER_UI" as const,
      action: options.toolName,
      actorId: options.actorId,
      ...(principal?.workspaceId ? { workspaceId: principal.workspaceId } : {}),
      ...(principal?.agentId ? { agentId: principal.agentId } : {}),
      ...(principal?.oauthInstallationId ? { installationId: principal.oauthInstallationId } : {}),
      ...(principal?.bindingId ? { bindingId: principal.bindingId } : {}),
      ...(principal?.connectionId ? { connectionId: principal.connectionId } : {}),
      ...(tenantId ? { tenantId } : {}),
      correlationId: callId,
      inputHash: requestHash,
    };
    try {
      await this.#repository.appendGovernanceAuditEvent({
        ...governanceBase,
        eventId: `${callId}:proposed`,
        eventType: principal ? "mcp.tool.proposed" : "user.action.proposed",
        disposition: options.governanceDisposition ?? "NOT_EVALUATED",
        outcome: "PROPOSED",
        evidence: {
          toolName: options.toolName,
          legacyDemo: principal?.legacyDemo ?? false,
          credentialMode: principal?.legacyDemo ? "LEGACY_DEMO" : principal ? "MCP_OAUTH" : "USER_SESSION",
        },
        occurredAt: startedAt,
      });
    } catch (error) {
      await this.#completeAudit(callId, options.toolName, {
        resultStatus: "FAILED",
        errorClass: "GOVERNANCE_AUDIT_UNAVAILABLE",
        finishedAt: new Date(),
      });
      this.#logger.error("Governance audit proposal persistence failed.", {
        callId,
        toolName: options.toolName,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      throw new AppError("CONFIGURATION_ERROR", "Governance audit evidence could not be persisted; the tool was not run.", {
        httpStatus: 503,
        cause: error,
      });
    }

    let result: T;
    let auditOutput: unknown;
    try {
      if (!tenantId && !options.allowUnresolvedTenant) {
        throw new AppError(
          "CONFIGURATION_ERROR",
          "The Xero action could not be bound to a verified server-side organisation.",
          { httpStatus: 503 },
        );
      }
      result = await options.action();
      if (options.revalidateContextAfterAction) {
        let revalidatedContext: ActorTenantContext;
        try {
          revalidatedContext = await this.#provider.resolveContext(options.principal ?? options.actorId);
        } catch (error) {
          throw new AppError(
            "CONFIGURATION_ERROR",
            "The Xero organisation binding could not be revalidated after the read.",
            { httpStatus: 503, cause: error },
          );
        }
        if (!tenantId || revalidatedContext.tenantId !== tenantId) {
          throw new AppError(
            "CONFIGURATION_ERROR",
            "The Xero organisation binding changed while the read was running; the result was withheld.",
            { httpStatus: 503 },
          );
        }
      }
      if (principal?.legacyDemo && !options.allowUnresolvedTenant) {
        let revalidatedContext: ActorTenantContext;
        try {
          revalidatedContext = await this.#provider.resolveContext(principal);
        } catch (error) {
          throw new AppError(
            "CONFIGURATION_ERROR",
            "The legacy Xero tenant binding could not be revalidated after the action.",
            { httpStatus: 503, cause: error },
          );
        }
        if (!tenantId || revalidatedContext.tenantId !== tenantId) {
          throw new AppError(
            "CONFIGURATION_ERROR",
            "The legacy Xero tenant binding changed while the action was running.",
            { httpStatus: 503 },
          );
        }
      }
      auditOutput = options.auditOutput ? options.auditOutput(result) : result;
    } catch (error) {
      const safe = toSafeError(error);
      const completion: AuditCompletion = {
        resultStatus: safe.httpStatus < 500 ? "REJECTED" : "FAILED",
        errorClass: safe.code,
        finishedAt: new Date(),
      };
      await this.#completeAudit(callId, options.toolName, completion, safe);
      try {
        await this.#repository.appendGovernanceAuditEvent({
          ...governanceBase,
          eventId: `${callId}:completed`,
          eventType: principal ? "mcp.tool.completed" : "user.action.completed",
          disposition: "DENY",
          outcome: completion.resultStatus === "REJECTED" ? "REJECTED" : "FAILED",
          outputHash: hashObject({ code: safe.code, httpStatus: safe.httpStatus }),
          evidence: {
            toolName: options.toolName,
            errorClass: safe.code,
            providerMutationCompletion: safe.code === "WRITE_RESULT_UNKNOWN" ? "UNKNOWN" : "NOT_REPORTED",
          },
          occurredAt: completion.finishedAt,
        });
      } catch (governanceError) {
        this.#logger.error("Governance audit rejection persistence failed.", {
          callId,
          toolName: options.toolName,
          originalErrorCode: safe.code,
          errorClass: governanceError instanceof Error ? governanceError.name : "UnknownError",
        });
      }
      throw safe;
    }

    const completion: AuditCompletion = {
      resultStatus: "SUCCEEDED",
      finishedAt: new Date(),
    };
    const recordId = options.recordId?.(result);
    if (recordId) completion.recordId = recordId;
    await this.#completeAudit(callId, options.toolName, completion);
    try {
      await this.#repository.appendGovernanceAuditEvent({
        ...governanceBase,
        eventId: `${callId}:completed`,
        eventType: principal ? "mcp.tool.completed" : "user.action.completed",
        disposition: options.governanceDisposition ?? "NOT_EVALUATED",
        outcome: "SUCCEEDED",
        outputHash: hashObject(auditOutput),
        evidence: {
          toolName: options.toolName,
          policyEvaluation: "RECORDED_BY_EXISTING_CAPABILITY_AND_WRITE_GATES",
          providerMutationCompletion: "SEE_TOOL_RECEIPT_AND_READBACK_EVIDENCE",
        },
        occurredAt: completion.finishedAt,
      });
    } catch (error) {
      this.#logger.error("Governance audit completion persistence failed.", {
        callId,
        toolName: options.toolName,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      throw new AppError("CONFIGURATION_ERROR", "Governance audit completion failed; the tool result was withheld.", {
        httpStatus: 503,
        details: { auditCallId: callId, governanceAuditCompletionStatus: "UNKNOWN" },
        cause: error,
      });
    }
    return result;
  }

  #existingSalesInvoiceDraftResult(posting: PostingRequest): DraftSalesInvoiceResult {
    if (
      posting.documentType !== "ACCREC" ||
      !posting.xeroInvoiceId ||
      !posting.readbackSnapshot ||
      posting.state !== "DRAFT_READBACK_VERIFIED"
    ) {
      if (posting.state === "WRITE_RESULT_UNKNOWN") {
        throw new AppError("WRITE_RESULT_UNKNOWN", "The prior ACCREC draft result is unknown; automatic retry is blocked.", {
          httpStatus: 409,
        });
      }
      throw new AppError("CONFLICT", `The existing ACCREC draft request is in ${posting.state}.`, { httpStatus: 409 });
    }
    const invoice = posting.readbackSnapshot as unknown as SalesInvoiceSnapshot;
    if (invoice.type !== "ACCREC" || invoice.status !== "DRAFT") {
      throw new AppError("READBACK_MISMATCH", "Stored ACCREC draft evidence is not an exact DRAFT sales invoice.", {
        httpStatus: 409,
      });
    }
    return {
      postingRequestId: posting.postingRequestId,
      invoiceId: posting.xeroInvoiceId,
      status: invoice.status,
      verifiedPayloadHash: posting.providerPayloadHash,
      providerReceipt: posting.draftWriteReceipt ?? posting.writeReceipt ?? null,
      readbackVerified: true,
      invoice,
      idempotentReplay: true,
    };
  }

  async #resolveExistingSalesInvoiceDraftRequest(
    principal: AccountingPrincipal,
    input: CreateDraftSalesInvoiceInput,
    initialPosting: PostingRequest,
  ): Promise<DraftSalesInvoiceResult> {
    const deadline = Date.now() + EXISTING_DRAFT_WAIT_MS;
    let pollDelayMs = EXISTING_DRAFT_INITIAL_POLL_MS;
    let posting = initialPosting;
    while (posting.state === "VALIDATED" && Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollDelayMs, remainingMs)));
      posting = await this.#repository.getPosting(posting.postingRequestId) ?? posting;
      pollDelayMs = Math.min(pollDelayMs * 2, EXISTING_DRAFT_MAX_POLL_MS);
    }
    if (posting.state === "VALIDATED") {
      throw new AppError(
        "CONFLICT",
        "The matching ACCREC draft request is still in progress; no second Xero write was attempted.",
        {
          httpStatus: 409,
          retryable: true,
          details: { postingRequestId: posting.postingRequestId, state: posting.state },
        },
      );
    }
    if (posting.state === "WRITE_RESULT_UNKNOWN" && !posting.authoriseRequestId) {
      return this.#recoverUnknownSalesInvoiceDraft(principal, input, posting);
    }
    return this.#existingSalesInvoiceDraftResult(posting);
  }

  async #recoverUnknownSalesInvoiceDraft(
    principal: AccountingPrincipal,
    input: CreateDraftSalesInvoiceInput,
    posting: PostingRequest,
  ): Promise<DraftSalesInvoiceResult> {
    if (!posting.xeroInvoiceId) {
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The prior ACCREC draft write has no known Xero InvoiceID; automatic retry is blocked.",
        { httpStatus: 409 },
      );
    }
    try {
      const invoice = await this.#provider.getInvoice(principal, posting.xeroInvoiceId, "ACCREC") as SalesInvoiceSnapshot;
      this.#verifySalesInvoiceDraftReadback(posting.tenantId, input, invoice);
      const approvedPayloadHash = hashObject(canonicalInvoiceForApproval(invoice));
      let recovered: PostingRequest;
      try {
        recovered = await this.#repository.recoverDraftCreated(posting.postingRequestId, {
          xeroInvoiceId: invoice.invoiceId,
          providerPayload: invoice as unknown as Record<string, unknown>,
          providerPayloadHash: approvedPayloadHash,
          writeReceipt: { operation: "CREATE_ACCREC_DRAFT_RECOVERED_BY_READBACK", invoiceId: invoice.invoiceId },
          readbackSnapshot: invoice as unknown as Record<string, unknown>,
        });
      } catch (error) {
        const latest = await this.#repository.getPosting(posting.postingRequestId);
        if (latest) return this.#existingSalesInvoiceDraftResult(latest);
        throw error;
      }
      return {
        postingRequestId: recovered.postingRequestId,
        invoiceId: invoice.invoiceId,
        status: invoice.status,
        verifiedPayloadHash: approvedPayloadHash,
        providerReceipt: recovered.writeReceipt ?? null,
        readbackVerified: true,
        invoice,
        idempotentReplay: true,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "READBACK_MISMATCH") {
        await this.#tryMarkDraftFailure(posting.postingRequestId, "READBACK_MISMATCH");
        throw error;
      }
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The prior ACCREC draft write is still unverified; no second create was attempted.",
        { httpStatus: 409, cause: error, details: { invoiceId: posting.xeroInvoiceId } },
      );
    }
  }

  async #validateDraftContext(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput | CreateDraftSalesInvoiceInput,
  ): Promise<void> {
    const [accounts, taxRates, contact] = await Promise.all([
      this.#provider.listAccounts(principal),
      this.#provider.listTaxRates(principal),
      this.#provider.getContact(principal, input.contact_id),
    ]);
    if (!contact || (contact.status && contact.status !== "ACTIVE")) {
      throw new AppError("VALIDATION_FAILED", "The selected Xero contact does not exist or is inactive.", {
        httpStatus: 422,
      });
    }

    for (const line of input.lines) {
      const account = accounts.find((candidate) => candidate.code === line.account_code);
      if (
        !account ||
        (account.status && account.status !== "ACTIVE") ||
        account.type === "BANK" ||
        ["DEBTORS", "CREDITORS"].includes(account.systemAccount ?? "")
      ) {
        throw new AppError("VALIDATION_FAILED", `Account ${line.account_code} is not eligible for this draft invoice.`, {
          httpStatus: 422,
        });
      }
      const tax = taxRates.find((candidate) => candidate.taxType === line.tax_type);
      if (!tax || (tax.status && tax.status !== "ACTIVE")) {
        throw new AppError("VALIDATION_FAILED", `Tax type ${line.tax_type} is not active in Xero.`, {
          httpStatus: 422,
        });
      }
      if (!canTaxApplyToAccountClass(tax, account.class)) {
        const accountClass = account.class?.toLowerCase() ?? "selected";
        throw new AppError("VALIDATION_FAILED", `Tax type ${line.tax_type} cannot be used with ${accountClass} accounts.`, {
          httpStatus: 422,
        });
      }
    }
  }

  #verifyDraftReadback(
    tenantId: string,
    input: CreateDraftSupplierBillInput,
    bill: SupplierBillSnapshot,
  ): void {
    const datesMatch = bill.invoiceDate?.slice(0, 10) === input.invoice_date && bill.dueDate?.slice(0, 10) === input.due_date;
    const linesMatch = bill.lines.length === input.lines.length && bill.lines.every((line, index) => {
      const requested = input.lines[index];
      return requested !== undefined &&
        line.description === requested.description &&
        line.quantity === requested.quantity.toFixed(4) &&
        line.unitAmount === requested.unit_amount.toFixed(4) &&
        line.accountCode === requested.account_code &&
        line.taxType === requested.tax_type;
    });
    const totalsMatch = this.#totalsAreInternallyConsistent(bill);

    if (
      bill.tenantId !== tenantId ||
      bill.type !== "ACCPAY" ||
      bill.status !== "DRAFT" ||
      bill.contact.contactId !== input.contact_id ||
      !datesMatch ||
      bill.currency !== input.currency ||
      bill.reference !== input.reference ||
      bill.lineAmountType !== input.line_amount_type ||
      !linesMatch ||
      !totalsMatch
    ) {
      throw new AppError("READBACK_MISMATCH", "Xero draft readback did not match the validated request.", {
        httpStatus: 502,
      });
    }
  }

  #verifySalesInvoiceDraftReadback(
    tenantId: string,
    input: CreateDraftSalesInvoiceInput,
    invoice: SalesInvoiceSnapshot,
  ): void {
    const datesMatch = invoice.invoiceDate?.slice(0, 10) === input.invoice_date &&
      invoice.dueDate?.slice(0, 10) === input.due_date;
    const linesMatch = invoice.lines.length === input.lines.length && invoice.lines.every((line, index) => {
      const requested = input.lines[index];
      return requested !== undefined &&
        line.description === requested.description &&
        line.quantity === requested.quantity.toFixed(4) &&
        line.unitAmount === requested.unit_amount.toFixed(4) &&
        line.accountCode === requested.account_code &&
        line.taxType === requested.tax_type;
    });
    if (
      invoice.tenantId !== tenantId ||
      invoice.type !== "ACCREC" ||
      invoice.status !== "DRAFT" ||
      invoice.contact.contactId !== input.contact_id ||
      !datesMatch ||
      invoice.currency !== input.currency ||
      invoice.reference !== input.reference ||
      invoice.lineAmountType !== input.line_amount_type ||
      !linesMatch ||
      !this.#totalsAreInternallyConsistent(invoice)
    ) {
      throw new AppError("READBACK_MISMATCH", "Xero ACCREC draft readback did not match the validated request.", {
        httpStatus: 502,
      });
    }
  }

  #totalsAreInternallyConsistent(bill: InvoiceSnapshot): boolean {
    if (bill.subTotal === undefined || bill.totalTax === undefined || bill.total === undefined) return false;
    const toMinorFour = (value: string): bigint | undefined => {
      if (!/^-?\d+\.\d{4}$/.test(value)) return undefined;
      try {
        return BigInt(value.replace(".", ""));
      } catch {
        return undefined;
      }
    };
    const subTotal = toMinorFour(bill.subTotal);
    const totalTax = toMinorFour(bill.totalTax);
    const total = toMinorFour(bill.total);
    const absolute = (value: bigint) => value < 0n ? -value : value;
    if (
      subTotal === undefined ||
      totalTax === undefined ||
      total === undefined ||
      absolute(subTotal + totalTax - total) > 1n
    ) {
      return false;
    }
    const lineAmounts = bill.lines.map((line) => line.lineAmount === undefined ? undefined : toMinorFour(line.lineAmount));
    if (lineAmounts.some((value) => value === undefined)) return false;
    const lineSum = lineAmounts.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
    return absolute(lineSum - (bill.lineAmountType === "Inclusive" ? total : subTotal)) <= 1n;
  }

  #assertPostingIdentity(posting: PostingRequest, actorId: string, tenantId: string, invoiceId: string): void {
    if (posting.actorId !== actorId || posting.tenantId !== tenantId || posting.xeroInvoiceId !== invoiceId) {
      throw new AppError("FORBIDDEN", "Posting request does not match the current actor and Xero organisation.", {
        httpStatus: 403,
      });
    }
  }

  #existingDraftResult(posting: PostingRequest): DraftSupplierBillResult {
    if (
      !posting.xeroInvoiceId ||
      !posting.readbackSnapshot ||
      !["APPROVAL_PENDING", "APPROVED", "AUTHORISING", "AUTHORISED_READBACK_VERIFIED"].includes(posting.state)
    ) {
      if (posting.state === "WRITE_RESULT_UNKNOWN") {
        throw new AppError("WRITE_RESULT_UNKNOWN", "The prior draft write result is unknown; automatic retry is blocked.", {
          httpStatus: 409,
        });
      }
      throw new AppError("CONFLICT", `The existing posting request is in ${posting.state}.`, { httpStatus: 409 });
    }
    const bill = posting.readbackSnapshot as unknown as SupplierBillSnapshot;
    const draftReceipt = posting.draftWriteReceipt ??
      (posting.state !== "AUTHORISED_READBACK_VERIFIED" ? posting.writeReceipt : undefined);
    return {
      postingRequestId: posting.postingRequestId,
      invoiceId: posting.xeroInvoiceId,
      status: bill.status,
      approvedPayloadHash: posting.providerPayloadHash,
      providerReceipt: draftReceipt ?? null,
      readbackVerified: true,
      reviewUrl: `${this.#config.publicBaseUrl}/review/${posting.postingRequestId}`,
      bill,
      idempotentReplay: true,
    };
  }

  /**
   * A matching request can observe the first request's repository row while
   * the Provider create/readback is still in flight. Wait only for repository
   * state movement; never issue a second Provider create. This also works
   * across application instances that share the same repository.
   */
  async #resolveExistingDraftRequest(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
    initialPosting: PostingRequest,
  ): Promise<DraftSupplierBillResult> {
    const deadline = Date.now() + EXISTING_DRAFT_WAIT_MS;
    let pollDelayMs = EXISTING_DRAFT_INITIAL_POLL_MS;
    let posting = initialPosting;
    while (posting.state === "VALIDATED" && Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollDelayMs, remainingMs)));
      posting = await this.#repository.getPosting(posting.postingRequestId) ?? posting;
      pollDelayMs = Math.min(pollDelayMs * 2, EXISTING_DRAFT_MAX_POLL_MS);
    }

    if (posting.state === "VALIDATED") {
      throw new AppError(
        "CONFLICT",
        "The matching supplier bill draft request is still in progress; no second Xero write was attempted.",
        {
          httpStatus: 409,
          retryable: true,
          details: { postingRequestId: posting.postingRequestId, state: posting.state },
        },
      );
    }
    if (posting.state === "WRITE_RESULT_UNKNOWN" && !posting.authoriseRequestId) {
      return this.#recoverUnknownDraft(principal, input, posting);
    }
    return this.#existingDraftResult(posting);
  }

  async #recoverUnknownDraft(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
    posting: PostingRequest,
  ): Promise<DraftSupplierBillResult> {
    if (!posting.xeroInvoiceId) {
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The prior draft write has no known Xero InvoiceID; automatic retry is blocked.",
        { httpStatus: 409 },
      );
    }
    try {
      const bill = await this.#provider.getSupplierBill(principal, posting.xeroInvoiceId);
      this.#verifyDraftReadback(posting.tenantId, input, bill);
      const approvedPayloadHash = hashObject(canonicalBillForApproval(bill));
      let recovered: PostingRequest;
      try {
        recovered = await this.#repository.recoverDraftCreated(posting.postingRequestId, {
          xeroInvoiceId: bill.invoiceId,
          providerPayload: bill as unknown as Record<string, unknown>,
          providerPayloadHash: approvedPayloadHash,
          writeReceipt: { operation: "CREATE_DRAFT_RECOVERED_BY_READBACK", invoiceId: bill.invoiceId },
          readbackSnapshot: bill as unknown as Record<string, unknown>,
        });
      } catch (error) {
        // Another instance may have completed the same readback-only recovery
        // after this instance read WRITE_RESULT_UNKNOWN. Re-read durable state
        // and replay it; never turn that benign race into another create.
        const latest = await this.#repository.getPosting(posting.postingRequestId);
        if (latest) return this.#existingDraftResult(latest);
        throw error;
      }
      return {
        postingRequestId: recovered.postingRequestId,
        invoiceId: bill.invoiceId,
        status: bill.status,
        approvedPayloadHash,
        providerReceipt: recovered.writeReceipt ?? null,
        readbackVerified: true,
        reviewUrl: `${this.#config.publicBaseUrl}/review/${recovered.postingRequestId}`,
        bill,
        idempotentReplay: true,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "READBACK_MISMATCH") {
        await this.#tryMarkDraftFailure(posting.postingRequestId, "READBACK_MISMATCH");
        throw error;
      }
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "The prior draft write is still unverified; no second create was attempted.",
        { httpStatus: 409, cause: error, details: { invoiceId: posting.xeroInvoiceId } },
      );
    }
  }

  async #tryMarkDraftFailure(
    postingRequestId: string,
    state: "BLOCKED_VALIDATION" | "READBACK_MISMATCH",
  ): Promise<void> {
    try {
      await this.#repository.markPostingState(postingRequestId, state);
    } catch (error) {
      this.#logger.warn("Draft failure state transition was skipped.", {
        postingRequestId,
        targetState: state,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async #tryMarkDraftWriteUnknown(postingRequestId: string, invoiceId?: string): Promise<void> {
    try {
      await this.#repository.markDraftWriteUnknown(postingRequestId, invoiceId);
    } catch (error) {
      // A failed uncertainty update must not replace the safer client-visible
      // WRITE_RESULT_UNKNOWN outcome. The original VALIDATED row remains an
      // active duplicate guard and operations can repair it from durable state.
      this.#logger.warn("Draft write uncertainty state transition was skipped.", {
        postingRequestId,
        hasKnownInvoiceId: invoiceId !== undefined,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  #completedAuthoriseResult(posting: PostingRequest, idempotentReplay: boolean): AuthoriseSupplierBillResult {
    if (!posting.xeroInvoiceId || !posting.readbackSnapshot) {
      throw new AppError("READBACK_MISMATCH", "Completed posting request has no verified Xero readback.", {
        httpStatus: 500,
      });
    }
    return {
      postingRequestId: posting.postingRequestId,
      invoiceId: posting.xeroInvoiceId,
      status: "AUTHORISED",
      verified: true,
      bill: posting.readbackSnapshot as unknown as SupplierBillSnapshot,
      idempotentReplay,
    };
  }

  async #beginAudit(intent: AuditIntent): Promise<void> {
    try {
      await this.#repository.beginAudit(intent);
    } catch (error) {
      this.#logger.error("Audit intent persistence failed.", {
        callId: intent.callId,
        toolName: intent.toolName,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      throw new AppError("CONFIGURATION_ERROR", "Accounting audit intent could not be persisted; the tool was not run.", {
        httpStatus: 503,
      });
    }
  }

  async #completeAudit(
    callId: string,
    toolName: string,
    completion: AuditCompletion,
    originalActionError?: AppError,
  ): Promise<void> {
    try {
      await this.#repository.completeAudit(callId, completion);
    } catch (error) {
      this.#logger.error("Audit completion persistence failed.", {
        callId,
        toolName,
        errorClass: error instanceof Error ? error.name : "UnknownError",
        ...(originalActionError ? { originalErrorCode: originalActionError.code } : {}),
      });
      if (originalActionError) {
        throw new AppError(originalActionError.code, originalActionError.message, {
          httpStatus: originalActionError.httpStatus,
          retryable: originalActionError.retryable,
          details: {
            ...(originalActionError.details ?? {}),
            auditCallId: callId,
            auditCompletionStatus: "UNKNOWN",
          },
          cause: new AggregateError(
            [originalActionError, error],
            "The accounting action and its audit completion both failed.",
          ),
        });
      }
      throw new AppError("CONFIGURATION_ERROR", "Accounting audit completion failed; the tool result was withheld.", {
        httpStatus: 503,
        details: { auditCallId: callId, auditCompletionStatus: "UNKNOWN" },
        cause: error,
      });
    }
  }

  #requireControlledMutations(): XeroControlledMutationService {
    if (!this.#controlledMutations) {
      throw new AppError("CONFIGURATION_ERROR", "The controlled Xero mutation service is unavailable.", {
        httpStatus: 503,
      });
    }
    return this.#controlledMutations;
  }

  #requireCreditNoteManualJournalMutations(): XeroCreditNoteManualJournalService {
    if (!this.#creditNoteManualJournalMutations) {
      throw new AppError("CONFIGURATION_ERROR", "The controlled Xero ledger-adjustment service is unavailable.", {
        httpStatus: 503,
      });
    }
    return this.#creditNoteManualJournalMutations;
  }

  #requireContactItemMutations(): XeroContactItemMutationService {
    if (!this.#contactItemMutations) {
      throw new AppError("CONFIGURATION_ERROR", "The controlled Xero Contact/Item service is unavailable.", {
        httpStatus: 503,
      });
    }
    return this.#contactItemMutations;
  }

  #requireMutationFoundation(): XeroMutationService {
    if (!this.#mutationFoundation) {
      throw new AppError("CONFIGURATION_ERROR", "The one-time Xero mutation service is unavailable.", {
        httpStatus: 503,
      });
    }
    return this.#mutationFoundation;
  }

  #requestContext(principal: AccountingPrincipal): RequestContext {
    if (typeof principal === "string") {
      throw new AppError("FORBIDDEN", "Controlled Xero mutations require a bound MCP request context.", {
        httpStatus: 403,
      });
    }
    return principal;
  }

  #assertWriteAllowed(principal: AccountingPrincipal, tenantId: string): void {
    if (!this.#config.xeroWriteEnabled) {
      throw new AppError("FORBIDDEN", "Xero write operations are disabled for this deployment.", {
        httpStatus: 403,
      });
    }
    if (isOAuthPrincipal(principal)) {
      const context = requireOAuthBoundRequestContext(principal as Exclude<AccountingPrincipal, string>);
      if (!context.scopes.includes("xero.draft.write")) {
        throw new AppError("FORBIDDEN", "This OAuth connection does not grant draft write access.", {
          httpStatus: 403,
        });
      }
      return;
    }
    if (!this.#config.xeroAllowedTenantId || tenantId !== this.#config.xeroAllowedTenantId) {
      throw new AppError("FORBIDDEN", "The connected Xero organisation is not allowlisted for writes.", {
        httpStatus: 403,
      });
    }
  }
}
