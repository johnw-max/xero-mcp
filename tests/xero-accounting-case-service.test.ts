import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import { createAccountingMcpServer } from "../src/mcp/createServer.js";
import { XeroAccountingCaseService } from "../src/services/xeroAccountingCaseService.js";
import type {
  AccountingProvider,
  CreditNoteSnapshot,
  InvoiceSnapshot,
  TaxRateSummary,
} from "../src/providers/types.js";
import type { AccountingService } from "../src/services/accountingService.js";
import {
  xeroMutationRequestIdForPreparation,
  type AutonomousActionsPreflightReceipt,
  type XeroMutationService,
} from "../src/services/xeroMutationService.js";
import {
  createOAuthRequestContext,
  requireOAuthBoundRequestContext,
  type RequestContext,
} from "../src/security/requestContext.js";
import { AppError } from "../src/errors.js";
import { hashObject, sha256 } from "../src/security/hash.js";
import type { XeroMutationRequest } from "../src/domain/xeroMutation.js";
import {
  accountingCasePlanHash,
  type AccountingCaseBinding,
  type AccountingCaseVersionRecord,
} from "../src/domain/accountingCasePersistence.js";
import type { ContactDurableIdentity } from "../src/domain/accountingCase.js";
import { buildCreditNoteDraftPrimitive } from "../src/domain/xeroCreditNoteManualJournalDraft.js";
import type { PrepareAccountingCasePublicInput } from "../src/domain/accountingCaseSchemas.js";
import { prepareAccountingCasePublicSchema } from "../src/domain/accountingCaseSchemas.js";
import {
  normalizeXeroAccountingCaseBusinessIntake,
  xeroAccountingCaseBusinessIntakeSchema,
} from "../src/mcp/xeroAccountingCaseBusinessIntake.js";
import {
  testXeroAccounts,
  testXeroBusinessAuthorityProfile,
} from "./helpers/xeroTenantCoaProfile.js";
import type { XeroDeclaredLedgerExecutionConstraints } from "../src/policy/xeroDeclaredLedgerBinding.js";
import {
  parseXeroAccountingCaseBusinessAuthorityProfiles,
  type XeroAccountingCaseBusinessAuthorityProfile,
} from "../src/policy/xeroBusinessCoordinateAuthority.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const continuationSecret = Buffer.alloc(32, 7);
const liveTargetCreatedAt = new Date(Date.now() - 60_000);
const liveTargetExpiresAt = new Date(Date.now() + 3 * 60 * 60_000);

function context(options: {
  scopes?: Array<"xero.read" | "xero.draft.write">;
  targetSessionId?: string;
  targetSessionHash?: string;
} = {}): RequestContext {
  const base = createOAuthRequestContext({
    issuer: "https://xero-mcp.example.test",
    resolvedToken: {
      tokenId: "case-token",
      clientId: "case-client",
      resource: "https://xero-mcp.example.test/mcp",
      audience: "https://xero-mcp.example.test/mcp",
      grantedScopes: options.scopes ?? ["xero.read", "xero.draft.write"],
      issuedAt: new Date("2026-08-13T03:00:00.000Z"),
      expiresAt: new Date("2026-08-13T05:00:00.000Z"),
      installationId: "case-installation",
      bindingId: "case-binding",
      bindingRevision: 1,
      workspaceId: "case-workspace",
      subjectType: "USER",
      subjectId: "case-user",
      agentId: "case-agent",
      connectionId: "case-connection",
      authorizationId: "case-authorization",
      tenantId,
      policyId: "case-policy",
    },
  });
  return Object.freeze({
    ...base,
    targetSessionId: options.targetSessionId ?? "case-target-session",
    targetSessionHash: options.targetSessionHash ?? "a".repeat(64),
    targetSessionExpiresAt: new Date(liveTargetExpiresAt),
  });
}

function source(
  documentValidity: "VALID_FOR_LIVE_BOOKS" | "TEST_OR_NOT_VALID" | "UNKNOWN" = "VALID_FOR_LIVE_BOOKS",
  declaredNet = "100.00",
  lineUnitAmount = "100",
  declaredTax = "9.00",
  declaredGross = "109.00",
): PrepareAccountingCasePublicInput {
  return {
    case_id: "case-service-1",
    expected_version: 0,
    sources: [{
      artifactId: "invoice-artifact",
      label: "Sales invoice",
      units: [{ unitId: "invoice-page-1", expectedFactKinds: ["NATIVE_DOCUMENT" as const] }],
    }],
    facts: [{
      factId: "sales-invoice-v1",
      lineageKey: "sales-invoice",
      eventKey: "sales-invoice-event",
      sourceUnitIds: ["invoice-page-1"],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "NATIVE_DOCUMENT" as const,
      documentKind: "INVOICE" as const,
      counterpartyRole: "CUSTOMER" as const,
      reference: "INV-CASE-001",
      referenceKind: "FORMAL_DOCUMENT_NUMBER" as const,
      documentDate: "2026-07-20",
      dueDate: "2026-08-20",
      currency: "SGD",
      contactName: "Exact Customer",
      taxPolicyBasis: "DOCUMENT_DATE_NON_TRANSITION" as const,
      lineAmountType: "EXCLUSIVE" as const,
      lines: [{
        lineId: "line-1",
        description: "Consulting",
        quantity: "1",
        unitAmount: lineUnitAmount,
        sourceTax: declaredTax,
        accountCode: "200",
        taxType: "OUTPUTY24",
      }],
      declaredNet,
      declaredTax,
      declaredGross,
      documentValidity,
    }],
  };
}

function supplierBillSource(): PrepareAccountingCasePublicInput {
  const input = source();
  const fact = input.facts[0];
  if (!fact || fact.kind !== "NATIVE_DOCUMENT") throw new Error("test native document missing");
  return {
    ...input,
    case_id: "case-service-supplier-bill",
    facts: [{
      ...fact,
      factId: "supplier-bill-v1",
      lineageKey: "supplier-bill",
      eventKey: "supplier-bill-event",
      counterpartyRole: "SUPPLIER",
      reference: "BILL-CASE-001",
      contactName: "Exact Supplier",
    }],
  };
}

function exactProviderSalesInvoice(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    invoiceId: "44444444-4444-4444-8444-444444444444",
    tenantId,
    type: "ACCREC",
    status: "DRAFT",
    contact: { contactId: "22222222-2222-4222-8222-222222222222", name: "Exact Customer" },
    invoiceDate: "2026-07-20",
    dueDate: "2026-08-20",
    currency: "SGD",
    invoiceNumber: "INV-CASE-001",
    reference: "supplementary-reference",
    subTotal: "100.0000",
    totalTax: "9.0000",
    total: "109.0000",
    lineAmountType: "Exclusive",
    lines: [{
      description: "Consulting",
      quantity: "1.0000",
      unitAmount: "100.0000",
      lineAmount: "100.0000",
      taxAmount: "9.0000",
      accountId: "33333333-3333-4333-8333-333333333333",
      accountCode: "200",
      taxType: "OUTPUTY24",
    }],
    lineItemCount: 1,
    linesTruncated: false,
    ...overrides,
  };
}

function recurringSource(caseId: string, documentDate: string, dueDate: string): PrepareAccountingCasePublicInput {
  const input = source();
  const fact = input.facts[0];
  if (!fact || fact.kind !== "NATIVE_DOCUMENT") throw new Error("test recurring invoice is missing");
  return {
    ...input,
    case_id: caseId,
    facts: [{
      ...fact,
      factId: `recurring-${documentDate}`,
      lineageKey: `recurring-${documentDate}`,
      eventKey: `recurring-${documentDate}`,
      reference: "MONTHLY-RETAINER",
      referenceKind: "GENERIC_RECURRING_REFERENCE",
      documentDate,
      dueDate,
    }],
  };
}

function noTaxSource(): PrepareAccountingCasePublicInput {
  const input = source("VALID_FOR_LIVE_BOOKS", "100.00", "100", "0.00", "100.00");
  const document = input.facts[0];
  if (!document || document.kind !== "NATIVE_DOCUMENT") throw new Error("test native document missing");
  document.lineAmountType = "NO_TAX";
  document.lines[0]!.taxType = "NONE";
  return input;
}

function twoInvoiceSource() {
  const first = source();
  return {
    ...first,
    case_id: "case-service-two-invoices",
    sources: [
      ...first.sources,
      {
        artifactId: "invoice-artifact-2",
        label: "Second sales invoice",
        units: [{ unitId: "invoice-page-2", expectedFactKinds: ["NATIVE_DOCUMENT" as const] }],
      },
    ],
    facts: [
      ...first.facts,
      {
        ...structuredClone(first.facts[0]!),
        factId: "sales-invoice-v2-other-document",
        lineageKey: "sales-invoice-other",
        eventKey: "sales-invoice-event-other",
        sourceUnitIds: ["invoice-page-2"],
        reference: "INV-CASE-002",
      },
    ],
  };
}

function threeInvoiceSource() {
  const firstTwo = twoInvoiceSource();
  return {
    ...firstTwo,
    case_id: "case-service-three-invoices",
    sources: [
      ...firstTwo.sources,
      {
        artifactId: "invoice-artifact-3",
        label: "Third sales invoice",
        units: [{ unitId: "invoice-page-3", expectedFactKinds: ["NATIVE_DOCUMENT" as const] }],
      },
    ],
    facts: [
      ...firstTwo.facts,
      {
        ...structuredClone(firstTwo.facts[0]!),
        factId: "sales-invoice-v3-other-document",
        lineageKey: "sales-invoice-third",
        eventKey: "sales-invoice-event-third",
        sourceUnitIds: ["invoice-page-3"],
        reference: "INV-CASE-003",
      },
    ],
  };
}

function contactDependentSource() {
  const invoice = source();
  return {
    ...invoice,
    case_id: "case-service-contact-dependency",
    sources: [
      {
        artifactId: "contact-artifact",
        label: "Customer master data",
        units: [{ unitId: "contact-page-1", expectedFactKinds: ["CONTACT_CANDIDATE" as const] }],
      },
      ...invoice.sources,
    ],
    facts: [
      {
        factId: "contact-candidate-v1",
        lineageKey: "contact-candidate",
        eventKey: "contact-candidate-event",
        sourceUnitIds: ["contact-page-1"],
        origin: "MODEL_EXTRACTED" as const,
        revision: 1,
        kind: "CONTACT_CANDIDATE" as const,
        usageRoles: ["CUSTOMER"] as const,
        name: "Exact Customer",
        email: "customer@example.test",
        durableIdentity: {
          kind: "LEGAL_REGISTRY" as const,
          jurisdiction: "SG",
          registryScheme: "ACRA_UEN",
          number: "202699999Z",
        },
        companyNumber: "202699999Z",
        bankVerification: "NOT_APPLICABLE" as const,
      },
      ...invoice.facts.map((fact) => fact.kind === "NATIVE_DOCUMENT" ? {
        ...fact,
        contactDurableIdentity: {
          kind: "LEGAL_REGISTRY" as const,
          jurisdiction: "SG",
          registryScheme: "ACRA_UEN",
          number: "202699999Z",
        },
      } : fact),
    ],
  };
}

function publicContactDependentBusinessIntake() {
  return {
    case_id: "case-public-contact-dependency",
    expected_version: 0,
    source_label: "Public new customer invoice",
    source_set_complete: true,
    documents: [{
      document_type: "CUSTOMER_INVOICE",
      reference: "INV-PUBLIC-CONTINUATION-001",
      reference_kind: "FORMAL_DOCUMENT_NUMBER",
      document_date: "2026-07-20",
      due_date: "2026-08-20",
      currency: "SGD",
      contact: {
        name: "Exact Customer",
        durable_identity: {
          kind: "LEGAL_REGISTRY",
          jurisdiction: "SG",
          registry_scheme: "ACRA_UEN",
          number: "202699999Z",
        },
      },
      lines: [{
        description: "Consulting",
        quantity: "1",
        unit_amount_excluding_tax: "100.00",
        source_tax_amount: "9.00",
        account_code: "200",
        tax_type: "OUTPUTY24",
      }],
      declared_net: "100.00",
      declared_tax: "9.00",
      declared_gross: "109.00",
      document_validity: "VALID_FOR_LIVE_BOOKS",
    }],
    new_contacts: [{
      usage_roles: ["CUSTOMER"],
      contact: {
        name: "Exact Customer",
        email: "customer@example.test",
        durable_identity: {
          kind: "LEGAL_REGISTRY",
          jurisdiction: "SG",
          registry_scheme: "ACRA_UEN",
          number: "202699999Z",
        },
        company_number: "202699999Z",
      },
    }],
  };
}

function twoContactDependentBusinessIntake() {
  const first = publicContactDependentBusinessIntake();
  const secondIdentity = {
    kind: "LEGAL_REGISTRY" as const,
    jurisdiction: "SG",
    registry_scheme: "ACRA_UEN",
    number: "202688888K",
  };
  return {
    ...first,
    case_id: "case-public-two-contact-expired-recovery",
    source_label: "Two new customers and their invoices",
    documents: [
      first.documents[0]!,
      {
        ...structuredClone(first.documents[0]!),
        reference: "INV-PUBLIC-CONTINUATION-002",
        contact: {
          name: "Second Exact Customer",
          durable_identity: secondIdentity,
        },
      },
    ],
    new_contacts: [
      first.new_contacts[0]!,
      {
        usage_roles: ["CUSTOMER"] as const,
        contact: {
          name: "Second Exact Customer",
          email: "second-customer@example.test",
          durable_identity: secondIdentity,
          company_number: secondIdentity.number,
        },
      },
    ],
  };
}

function dualRoleContactDependentBusinessIntake() {
  const base = publicContactDependentBusinessIntake();
  const contact = base.new_contacts[0]!.contact;
  return {
    ...base,
    case_id: "case-public-dual-role-contact",
    source_label: "One legal counterparty used for AR and AP",
    documents: [
      base.documents[0]!,
      {
        ...structuredClone(base.documents[0]!),
        document_type: "SUPPLIER_BILL" as const,
        reference: "BILL-DUAL-ROLE-001",
        contact: structuredClone(contact),
        lines: [{
          description: "Consulting",
          quantity: "1",
          unit_amount_excluding_tax: "100.00",
          source_tax_amount: "9.00",
          account_code: "453",
          tax_type: "INPUTY24",
        }],
      },
    ],
    new_contacts: [{ contact: structuredClone(contact) }],
  };
}

function mixedSupplierBillBusinessIntake(sourceTaxForOffice = "9.00") {
  return {
    case_id: "case-mixed-supplier-bill",
    expected_version: 0,
    source_label: "One supplier bill with two accounting semantics",
    source_set_complete: true as const,
    documents: [{
      document_type: "SUPPLIER_BILL" as const,
      reference: "BILL-MIXED-001",
      reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
      document_date: "2026-07-20",
      due_date: "2026-08-20",
      currency: "SGD",
      contact: { name: "Exact Supplier" },
      lines: [{
        description: "Office supplies",
        quantity: "1",
        unit_amount_excluding_tax: "100.00",
        source_tax_amount: sourceTaxForOffice,
        account_code: "453",
        tax_type: "INPUTY24",
      }, {
        description: "Cloud subscription",
        quantity: "1",
        unit_amount_excluding_tax: "50.00",
        source_tax_amount: "0.00",
        account_code: "485",
        tax_type: "NONE",
      }],
      declared_net: "150.00",
      declared_tax: sourceTaxForOffice,
      declared_gross: sourceTaxForOffice === "9.00" ? "159.00" : "158.00",
      document_validity: "TEST_OR_NOT_VALID" as const,
    }],
  };
}

function historicalCreditBusinessIntake(role: "CUSTOMER" | "SUPPLIER") {
  const customer = role === "CUSTOMER";
  return {
    case_id: `case-historical-${customer ? "customer" : "supplier"}-credit`,
    expected_version: 0,
    source_label: "Credit-only Case against a historical posted original",
    source_set_complete: true as const,
    documents: [{
      document_type: customer ? "CUSTOMER_CREDIT_NOTE" as const : "SUPPLIER_CREDIT_NOTE" as const,
      reference: customer ? "CN-HIST-001" : "SCN-HIST-001",
      reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
      document_date: "2026-08-01",
      currency: "SGD",
      contact: { name: customer ? "Historical Customer" : "Historical Supplier" },
      lines: [{
        description: "Partial historical credit",
        quantity: "1",
        unit_amount_excluding_tax: "100.00",
        source_tax_amount: "9.00",
        account_code: customer ? "200" : "453",
        tax_type: customer ? "OUTPUTY24" : "INPUTY24",
      }],
      declared_net: "100.00",
      declared_tax: "9.00",
      declared_gross: "109.00",
      document_validity: "VALID_FOR_LIVE_BOOKS" as const,
      original_document: {
        reference: customer ? "INV-HIST-001" : "BILL-HIST-001",
        reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
        document_date: "2026-07-01",
      },
    }],
  };
}

function historicalSameCaseCreditBusinessIntake() {
  const creditOnly = historicalCreditBusinessIntake("CUSTOMER");
  return {
    ...creditOnly,
    documents: [
      creditOnly.documents[0]!,
      {
        document_type: "CUSTOMER_INVOICE" as const,
        reference: "INV-HIST-001",
        reference_kind: "FORMAL_DOCUMENT_NUMBER" as const,
        document_date: "2026-07-01",
        due_date: "2026-07-31",
        currency: "SGD",
        contact: { name: "Historical Customer" },
        // Deliberately false economics: this submitted support must never be
        // used as original authority or produce an invoice write operation.
        lines: [{
          description: "Fabricated submitted original economics",
          quantity: "1",
          unit_amount_excluding_tax: "999.00",
          source_tax_amount: "89.91",
          account_code: "200",
          tax_type: "OUTPUTY24",
        }],
        declared_net: "999.00",
        declared_tax: "89.91",
        declared_gross: "1088.91",
        document_validity: "VALID_FOR_LIVE_BOOKS" as const,
      },
    ],
  };
}

function historicalOriginal(role: "CUSTOMER" | "SUPPLIER", overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  const customer = role === "CUSTOMER";
  return {
    invoiceId: customer
      ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      : "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    tenantId,
    type: customer ? "ACCREC" : "ACCPAY",
    status: "AUTHORISED",
    contact: {
      contactId: customer
        ? "22222222-2222-4222-8222-222222222222"
        : "23232323-2323-4232-8232-232323232323",
      name: customer ? "Historical Customer" : "Historical Supplier",
    },
    invoiceDate: "2026-07-01",
    currency: "SGD",
    invoiceNumber: customer ? "INV-HIST-001" : "BILL-HIST-001",
    reference: "supplementary-reference-is-not-the-provider-identifier",
    subTotal: "200.0000",
    totalTax: "18.0000",
    total: "218.0000",
    lineAmountType: "Exclusive",
    lines: [{
      description: "Original two-unit transaction",
      quantity: "2.0000",
      unitAmount: "100.0000",
      lineAmount: "200.0000",
      taxAmount: "18.0000",
      accountId: customer
        ? "33333333-3333-4333-8333-333333333333"
        : "33333333-3333-4333-8333-333333333353",
      accountCode: customer ? "200" : "453",
      taxType: customer ? "OUTPUTY24" : "INPUTY24",
    }],
    lineItemCount: 1,
    linesTruncated: false,
    ...overrides,
  };
}

function goldenHistoricalOriginal(role: "CUSTOMER" | "SUPPLIER"): InvoiceSnapshot {
  const customer = role === "CUSTOMER";
  return {
    invoiceId: customer
      ? "abababab-abab-4bab-8bab-abababababab"
      : "acacacac-acac-4cac-8cac-acacacacacac",
    tenantId,
    type: customer ? "ACCREC" : "ACCPAY",
    status: "AUTHORISED",
    contact: {
      contactId: customer
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333",
      name: customer ? "Lion City Digital Pte. Ltd." : "OfficeHub Singapore Pte. Ltd.",
    },
    invoiceNumber: customer ? "INV-2026-0702" : "OH-260701",
    reference: "supplementary-reference-must-not-authorise-provider-identifier",
    invoiceDate: customer ? "2026-07-02" : "2026-07-03",
    currency: "SGD",
    lineAmountType: "Exclusive",
    subTotal: customer ? "4000.0000" : "800.0000",
    totalTax: customer ? "360.0000" : "72.0000",
    total: customer ? "4360.0000" : "872.0000",
    lines: [{
      description: customer ? "Consulting services - July 2026" : "Premium copier paper",
      quantity: customer ? "20.0000" : "10.0000",
      unitAmount: customer ? "200.0000" : "80.0000",
      lineAmount: customer ? "4000.0000" : "800.0000",
      taxAmount: customer ? "360.0000" : "72.0000",
      accountId: customer
        ? "33333333-3333-4333-8333-333333333333"
        : "33333333-3333-4333-8333-333333333353",
      accountCode: customer ? "200" : "453",
      taxType: customer ? "OUTPUTY24" : "INPUTY24",
    }],
    lineItemCount: 1,
    linesTruncated: false,
  };
}

function goldenOriginalHistory() {
  return {
    invoices: [goldenHistoricalOriginal("CUSTOMER"), goldenHistoricalOriginal("SUPPLIER")],
    creditNotes: [],
  };
}

function mcpResult<T>(response: { structuredContent?: Record<string, unknown> }): T {
  const result = response.structuredContent?.result;
  if (!result || typeof result !== "object") throw new Error("MCP result payload is missing");
  return result as T;
}

function onlyUnresolvedContactSource(): PrepareAccountingCasePublicInput {
  return {
    case_id: "case-service-contact-only",
    expected_version: 0,
    sources: [{
      artifactId: "contact-artifact-only",
      label: "Customer master data",
      units: [{ unitId: "contact-page-only", expectedFactKinds: ["CONTACT_CANDIDATE" as const] }],
    }],
    facts: [{
      factId: "contact-candidate-only-v1",
      lineageKey: "contact-candidate-only",
      eventKey: "contact-candidate-only-event",
      sourceUnitIds: ["contact-page-only"],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "CONTACT_CANDIDATE" as const,
      usageRoles: ["CUSTOMER"] as const,
      name: "Exact Customer",
      email: "customer@example.test",
      bankVerification: "NOT_APPLICABLE" as const,
    }],
  };
}

function typedContactOnlySource(
  caseId: string,
  name: string,
  durableIdentity: ContactDurableIdentity,
): PrepareAccountingCasePublicInput {
  const input = onlyUnresolvedContactSource();
  const fact = input.facts[0];
  if (!fact || fact.kind !== "CONTACT_CANDIDATE") throw new Error("test contact fact missing");
  return {
    ...input,
    case_id: caseId,
    facts: [{
      ...fact,
      name,
      email: `${caseId}@example.test`,
      durableIdentity,
      ...(durableIdentity.kind === "LEGAL_REGISTRY"
        ? { companyNumber: durableIdentity.number }
        : { accountNumber: durableIdentity.number }),
    }],
  };
}

type FakeExecutionOutcome =
  | "SUCCESS"
  | "DEFINITE_FAILURE"
  | "PREWRITE_FAILURE"
  | "WRITE_UNCERTAIN"
  | "APPROVAL_EXPIRED";

function durableCaseBinding(): AccountingCaseBinding {
  return {
    actorId: "case-workspace:user:case-user",
    workspaceId: "case-workspace",
    subjectType: "USER",
    subjectId: "case-user",
    agentId: "case-agent",
    installationId: "case-installation",
    bindingId: "case-binding",
    bindingRevision: 1,
    connectionId: "case-connection",
    tenantId,
    targetSessionId: "case-target-session",
    targetSessionHash: "a".repeat(64),
    targetSessionExpiresAt: new Date(liveTargetExpiresAt),
  };
}

function runtime(options?: {
  testTenant?: boolean;
  initialContacts?: Array<{
    contactId: string;
    name: string;
    status: "ACTIVE" | "ARCHIVED" | "GDPRREQUEST";
    email?: string;
    companyNumber?: string;
    accountNumber?: string;
    isCustomer?: boolean;
    isSupplier?: boolean;
  }>;
  executionOutcomes?: readonly FakeExecutionOutcome[];
  tamperReadbackEconomicsAtOrdinals?: readonly number[];
  clock?: { value: Date };
  preparationTtlMs?: number;
  preparationPayloadMutator?: (
    payload: Record<string, unknown>,
    input: Record<string, unknown>,
  ) => Record<string, unknown>;
  onSalesInvoicePrepared?: (contacts: Array<{
    contactId: string;
    name: string;
    status: "ACTIVE" | "ARCHIVED" | "GDPRREQUEST";
    email?: string;
    companyNumber?: string;
    accountNumber?: string;
    isCustomer?: boolean;
    isSupplier?: boolean;
  }>) => void;
  beforeContactProviderClaim?: (contacts: Array<{
    contactId: string;
    name: string;
    status: "ACTIVE" | "ARCHIVED" | "GDPRREQUEST";
    email?: string;
    companyNumber?: string;
    accountNumber?: string;
    isCustomer?: boolean;
    isSupplier?: boolean;
  }>) => void;
  accounts?: Array<{
    accountId: string;
    code: string;
    status: string;
    class: string;
    type: string;
    systemAccount?: string;
  }>;
  taxRates?: TaxRateSummary[];
  providerHistorySequence?: Array<{
    invoices?: InvoiceSnapshot[];
    creditNotes?: CreditNoteSnapshot[];
    incomplete?: boolean;
  }>;
  businessAuthorityProfiles?: readonly XeroAccountingCaseBusinessAuthorityProfile[];
}) {
  const repository = new InMemoryAccountingRepository({
    now: () => options?.clock?.value
      ? new Date(options.clock.value.getTime())
      : new Date(),
  });
  const seededAt = new Date("2026-08-13T03:30:00.000Z");
  const repositoryReady = (async () => {
    await repository.saveProviderAuthorization({
      authorizationId: "case-authorization",
      workspaceId: "case-workspace",
      authorizedBySubject: "case-user",
      provider: "xero",
      providerSubject: "case-xero-user",
      grantedScopes: ["accounting.transactions", "accounting.contacts", "accounting.settings.read"],
      tokenCiphertext: "encrypted-test-token",
      tokenExpiresAt: new Date("2026-08-13T08:00:00.000Z"),
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt: seededAt,
      updatedAt: seededAt,
    });
    await repository.upsertAuthorizedProviderConnection("case-workspace", {
      connectionId: "case-connection",
      authorizationId: "case-authorization",
      provider: "xero",
      providerConnectionId: "case-provider-connection",
      tenantId,
      tenantName: "Case Company",
      status: "ACTIVE",
      lastVerifiedAt: seededAt,
      createdAt: seededAt,
      updatedAt: seededAt,
    });
    await repository.saveOAuthInstallation({
      installationId: "case-installation",
      workspaceId: "case-workspace",
      subjectType: "USER",
      subjectId: "case-user",
      agentId: "case-agent",
      clientId: "case-client",
      status: "ACTIVE",
      createdAt: seededAt,
      updatedAt: seededAt,
    });
    await repository.saveAgentConnectionBinding({
      bindingId: "case-binding",
      installationId: "case-installation",
      workspaceId: "case-workspace",
      subjectType: "USER",
      subjectId: "case-user",
      agentId: "case-agent",
      connectionId: "case-connection",
      policyId: "case-policy",
      status: "ACTIVE",
      createdAt: seededAt,
      updatedAt: seededAt,
    });
    await repository.saveLedgerTargetSession({
      sessionId: "case-target-session",
      sessionHash: "a".repeat(64),
      installationId: "case-installation",
      bindingId: "case-binding",
      connectionId: "case-connection",
      bindingRevision: 1,
      createdAt: liveTargetCreatedAt,
      expiresAt: liveTargetExpiresAt,
    });
  })();
  const executionOutcomes = [...(options?.executionOutcomes ?? [])];
  const tamperReadbackEconomicsAtOrdinals = new Set(options?.tamperReadbackEconomicsAtOrdinals ?? []);
  const providerWrite = vi.fn();
  const providerWritePermit = vi.fn();
  const exactProviderGet = vi.fn();
  const preparedOperationIds = new Map<string, number>();
  const coaConstraintsByPreparation = new Map<string, XeroDeclaredLedgerExecutionConstraints>();
  const operationRequestIds: string[] = [];
  let nextPreparationOrdinal = 0;
  const contacts = structuredClone(options?.initialContacts ?? [{
    contactId: "22222222-2222-4222-8222-222222222222",
    name: "Exact Customer",
    email: "customer@example.test",
    status: "ACTIVE" as const,
  }]);
  const providerHistorySequence = [...(options?.providerHistorySequence ?? [{}])];
  let providerHistoryReadIndex = 0;
  let currentProviderHistory = providerHistorySequence[0] ?? {};
  const providerHistoryPagination = (returned: number, incomplete = false) => incomplete
    ? {
        page: 1,
        pageSize: 100,
        returned,
        hasNextPage: false,
        hasNextPageIsEstimated: true,
        omittedInvalid: 0,
      }
    : {
        page: 1,
        pageSize: 100,
        returned,
        providerPageCount: 1,
        providerItemCount: returned,
        hasNextPage: false,
        hasNextPageIsEstimated: false,
        omittedInvalid: 0,
      };
  const nextProviderHistory = () => {
    currentProviderHistory = providerHistorySequence[
      Math.min(providerHistoryReadIndex, providerHistorySequence.length - 1)
    ] ?? {};
    providerHistoryReadIndex += 1;
    return currentProviderHistory;
  };
  const provider = {
    resolveContext: vi.fn(async () => {
      await repositoryReady;
      return { actorId: context().actorId, tenantId, tenantName: "Case Company" };
    }),
    getOrganisation: vi.fn(async () => {
      await repositoryReady;
      return {
        organisationId: tenantId,
        name: "Case Company",
        countryCode: "SG",
        baseCurrency: "SGD",
        paysTax: true,
        organisationStatus: "ACTIVE",
      };
    }),
    listInvoices: vi.fn(async () => {
      const history = nextProviderHistory();
      const invoices = structuredClone(history.invoices ?? []);
      return {
        invoices,
        pagination: providerHistoryPagination(invoices.length, history.incomplete),
      };
    }),
    listCreditNotes: vi.fn(async () => {
      const history = nextProviderHistory();
      const creditNotes = structuredClone(history.creditNotes ?? []);
      return {
        creditNotes,
        pagination: providerHistoryPagination(creditNotes.length, history.incomplete),
      };
    }),
    getInvoice: vi.fn(async (_context: RequestContext, invoiceId: string) => {
      const invoice = currentProviderHistory.invoices?.find((candidate) => candidate.invoiceId === invoiceId);
      if (!invoice) throw new AppError("NOT_FOUND", "Provider invoice is absent.", { httpStatus: 404 });
      return structuredClone(invoice);
    }),
    getCreditNote: vi.fn(async (_context: RequestContext, creditNoteId: string) => {
      const credit = currentProviderHistory.creditNotes?.find((candidate) => candidate.creditNoteId === creditNoteId);
      if (!credit) throw new AppError("NOT_FOUND", "Provider credit note is absent.", { httpStatus: 404 });
      return structuredClone(credit);
    }),
  } as unknown as AccountingProvider;
  const bindingFor = (requestContext: RequestContext) => {
    const principal = requireOAuthBoundRequestContext(requestContext);
    if (!principal.targetSessionId) throw new Error("test target session missing");
    return {
      actorId: principal.actorId,
      workspaceId: principal.workspaceId,
      tenantId,
      installationId: principal.oauthInstallationId,
      bindingId: principal.bindingId,
      bindingRevision: principal.bindingRevision,
      connectionId: principal.connectionId,
      targetSessionId: principal.targetSessionId,
    };
  };
  const caseBindingFor = (requestContext: RequestContext): AccountingCaseBinding => {
    const principal = requireOAuthBoundRequestContext(requestContext);
    if (
      !principal.targetSessionId || !principal.targetSessionHash ||
      !(principal.targetSessionExpiresAt instanceof Date)
    ) throw new Error("test target session binding is incomplete");
    return {
      actorId: principal.actorId,
      workspaceId: principal.workspaceId,
      subjectType: principal.subjectType,
      subjectId: principal.subjectId,
      agentId: principal.agentId,
      installationId: principal.oauthInstallationId,
      bindingId: principal.bindingId,
      bindingRevision: principal.bindingRevision,
      connectionId: principal.connectionId,
      tenantId,
      targetSessionId: principal.targetSessionId,
      targetSessionHash: principal.targetSessionHash,
      targetSessionExpiresAt: principal.targetSessionExpiresAt,
    };
  };
  const persistPreparedSalesInvoiceDraft = async (
    requestContext: RequestContext,
    input: Record<string, unknown>,
    serverCoaConstraints?: XeroDeclaredLedgerExecutionConstraints,
  ) => {
    const serverAccountIds = serverCoaConstraints?.lines.map((line) => line.accountId);
    const requestedTaxTypes = Array.isArray(input.lines)
      ? input.lines.flatMap((line) => line && typeof line === "object" && !Array.isArray(line) &&
        typeof (line as Record<string, unknown>).tax_type === "string"
        ? [(line as Record<string, unknown>).tax_type as string]
        : [])
      : [];
    const activeTaxTypes = new Set((options?.taxRates ?? [{ taxType: "OUTPUTY24" }])
      .filter((tax) => !tax.status || tax.status === "ACTIVE")
      .map((tax) => tax.taxType));
    if (requestedTaxTypes.some((taxType) => !activeTaxTypes.has(taxType))) {
      return {
        technicallyReady: false,
        preparation_id: null,
        blockers: [{ code: "NO_EXACT_MATCH", path: "lines[0].tax_rate" }],
      };
    }
    const sourceRef = input.source_ref;
    const sourceUnitKey = input.source_unit_key;
    const sourceSha256 = input.source_sha256;
    if (typeof sourceRef !== "string" || typeof sourceUnitKey !== "string" || typeof sourceSha256 !== "string") {
      throw new Error("test preparation requires complete source evidence");
    }
    const preparationId = `xmp_${hashObject({ sourceUnitKey, sourceSha256, nextPreparationOrdinal }).slice(0, 32)}`;
    const requestedContactName = typeof input.customer_name === "string"
      ? input.customer_name
      : input.supplier_name;
    const resolvedContact = contacts.filter((contact) =>
      contact.status === "ACTIVE" && contact.name.trim().toLocaleLowerCase("en") ===
        (typeof requestedContactName === "string" ? requestedContactName.trim().toLocaleLowerCase("en") : ""));
    if (resolvedContact.length !== 1) throw new Error("test preparation requires one exact active contact");
    const supplierBill = typeof input.supplier_name === "string";
    const canonicalPayloadBeforeMutation = {
      request_id: `${supplierBill ? "xero-accpay" : "xero-accrec"}-draft:${hashObject(input).slice(0, 48)}`,
      source_ref: sourceRef,
      contact_id: resolvedContact[0]!.contactId,
      invoice_date: input.invoice_date,
      due_date: input.due_date,
      currency: input.currency,
      ...(input.currency_rate !== undefined ? { currency_rate: input.currency_rate } : {}),
      reference: input.reference,
      authoritative_provider_field: input.authoritative_provider_field,
      line_amount_type: input.line_amount_type,
      lines: Array.isArray(input.lines)
        ? input.lines.map((line, index) => ({
            ...(line as Record<string, unknown>),
            ...(serverAccountIds?.[index] ? { account_id: serverAccountIds[index] } : {}),
          }))
        : input.lines,
      source_sha256: sourceSha256,
      source_evidence_type: "AGENT_ASSERTED_UNVERIFIED",
    };
    const canonicalPayload = options?.preparationPayloadMutator
      ? options.preparationPayloadMutator(canonicalPayloadBeforeMutation, input)
      : canonicalPayloadBeforeMutation;
    const preparedAt = options?.clock?.value ?? new Date("2026-08-13T04:00:00.000Z");
    await repository.createXeroMutationPreparation({
      ...bindingFor(requestContext),
      preparationId,
      objectType: supplierBill ? "SUPPLIER_BILL" : "SALES_INVOICE",
      operation: "CREATE_DRAFT",
      canonicalPayload,
      canonicalPayloadHash: hashObject(canonicalPayload),
      sourceRef,
      sourceUnitKey,
      sourceSha256,
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationSummaryHash: hashObject({ preparationId, type: "summary" }),
      confirmationPhraseHash: hashObject({ preparationId, type: "phrase" }),
      expiresAt: options?.preparationTtlMs === undefined
        ? new Date("2099-08-13T05:00:00.000Z")
        : new Date(preparedAt.getTime() + options.preparationTtlMs),
      now: preparedAt,
    });
    if (serverCoaConstraints) {
      coaConstraintsByPreparation.set(preparationId, structuredClone(serverCoaConstraints));
    }
    preparedOperationIds.set(preparationId, nextPreparationOrdinal++);
    options?.onSalesInvoicePrepared?.(contacts);
    return {
      technicallyReady: true,
      preparation_id: preparationId,
      blockers: [],
    };
  };
  const persistPreparedCreditNoteDraft = async (
    requestContext: RequestContext,
    input: Record<string, unknown>,
    serverCoaConstraints?: XeroDeclaredLedgerExecutionConstraints,
  ) => {
    const prepared = buildCreditNoteDraftPrimitive(input);
    const canonicalPayloadBeforeMutation = prepared.canonicalPayload as unknown as Record<string, unknown>;
    const canonicalPayload = options?.preparationPayloadMutator
      ? options.preparationPayloadMutator(canonicalPayloadBeforeMutation, input)
      : canonicalPayloadBeforeMutation;
    const preparationId = `xmp_${hashObject({
      sourceUnitKey: prepared.sourceUnitKey,
      sourceSha256: prepared.sourceSha256,
      kind: "credit",
    }).slice(0, 32)}`;
    const preparedAt = options?.clock?.value ?? new Date("2026-08-13T04:00:00.000Z");
    await repository.createXeroMutationPreparation({
      ...bindingFor(requestContext),
      preparationId,
      objectType: "CREDIT_NOTE",
      operation: "CREATE_DRAFT",
      canonicalPayload,
      canonicalPayloadHash: hashObject(canonicalPayload),
      sourceRef: prepared.sourceRef,
      sourceUnitKey: prepared.sourceUnitKey,
      sourceSha256: prepared.sourceSha256,
      sourceEvidenceType: prepared.sourceEvidenceType,
      confirmationSummaryHash: prepared.confirmationSummaryHash,
      confirmationPhraseHash: sha256(prepared.confirmationPhrase),
      expiresAt: new Date("2099-08-13T05:00:00.000Z"),
      now: preparedAt,
    });
    if (serverCoaConstraints) {
      coaConstraintsByPreparation.set(preparationId, structuredClone(serverCoaConstraints));
    }
    preparedOperationIds.set(preparationId, nextPreparationOrdinal++);
    return { preparation_id: preparationId };
  };
  const persistPreparedContact = async (
    requestContext: RequestContext,
    input: Record<string, unknown>,
  ) => {
    const sourceRef = input.source_ref;
    const sourceUnitKey = input.source_unit_key;
    const sourceSha256 = input.source_sha256;
    const name = input.name;
    if (
      typeof sourceRef !== "string" || typeof sourceUnitKey !== "string" ||
      typeof sourceSha256 !== "string" || typeof name !== "string"
    ) throw new Error("test contact preparation requires complete source evidence");
    const externalKey = hashObject({
      semantics: "xero-contact-source-key:v1",
      sourceRef,
      sourceUnitKey,
    });
    const preparationId = `xmp_${hashObject({ sourceUnitKey, sourceSha256, kind: "contact" }).slice(0, 32)}`;
    const canonicalPayload = {
      schemaVersion: "xero-contact-safe-v1",
      objectType: "CONTACT",
      operation: "CREATE",
      externalReference: `ZC:case:${sha256(`xero-contact-external-key:v1:${externalKey}`).slice(0, 32)}`,
      target: {
        name,
        ...(typeof input.email === "string" ? { email: input.email.toLowerCase() } : {}),
        ...(typeof input.company_number === "string" ? { companyNumber: input.company_number } : {}),
        ...(typeof input.account_number === "string" ? { accountNumber: input.account_number } : {}),
      },
    };
    const preparedAt = options?.clock?.value ?? new Date("2026-08-13T04:00:00.000Z");
    await repository.createXeroMutationPreparation({
      ...bindingFor(requestContext),
      preparationId,
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload,
      canonicalPayloadHash: hashObject(canonicalPayload),
      sourceRef,
      sourceUnitKey,
      sourceSha256,
      sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
      confirmationSummaryHash: hashObject({ preparationId, type: "summary" }),
      confirmationPhraseHash: hashObject({ preparationId, type: "phrase" }),
      expiresAt: options?.preparationTtlMs === undefined
        ? new Date("2099-08-13T05:00:00.000Z")
        : new Date(preparedAt.getTime() + options.preparationTtlMs),
      now: preparedAt,
    });
    preparedOperationIds.set(preparationId, nextPreparationOrdinal++);
    return { preparation_id: preparationId };
  };
  const mutationBoundInput = (request: XeroMutationRequest) => ({
    actorId: request.actorId,
    workspaceId: request.workspaceId,
    tenantId: request.tenantId,
    installationId: request.installationId,
    bindingId: request.bindingId,
    ...(request.bindingRevision !== undefined ? { bindingRevision: request.bindingRevision } : {}),
    connectionId: request.connectionId,
    ...(request.targetSessionId ? { targetSessionId: request.targetSessionId } : {}),
    mutationRequestId: request.mutationRequestId,
    objectType: request.objectType,
    operation: request.operation,
    ...(request.targetXeroObjectId ? { targetXeroObjectId: request.targetXeroObjectId } : {}),
    canonicalPayloadHash: request.canonicalPayloadHash,
    ...(request.sourceRef ? { sourceRef: request.sourceRef } : {}),
    sourceUnitKey: request.sourceUnitKey,
    sourceSha256: request.sourceSha256,
    sourceEvidenceType: request.sourceEvidenceType,
    now: new Date("2026-08-13T04:00:00.000Z"),
  });
  const completeReadback = async (
    requestContext: RequestContext,
    request: XeroMutationRequest,
    serverCoaConstraints?: XeroDeclaredLedgerExecutionConstraints,
  ) => {
    const ordinal = preparedOperationIds.get(request.preparationId) ?? 0;
    const xeroObjectId = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    ][ordinal] ?? `invoice-${ordinal}`;
    const writeReceipt = { providerRequestId: `provider-request-${ordinal + 1}` };
    if (!request.xeroObjectId || !request.writeReceipt) {
      request = await repository.recordXeroMutationWriteEvidence({
        ...mutationBoundInput(request),
        xeroObjectId,
        writeReceipt,
      });
    }
    const caseRecord = await repository.getAccessibleAccountingCase({
      currentAccessBinding: caseBindingFor(requestContext),
      caseId: typeof request.sourceRef === "string" && request.sourceRef.startsWith("case:")
        ? request.sourceRef.slice("case:".length)
        : "",
      mode: "STATUS",
      now: options?.clock?.value ?? new Date("2026-08-13T04:00:00.000Z"),
    });
    const caseOperation = caseRecord?.operations.find(
      (candidate) => candidate.operation.operationId === request.sourceUnitKey,
    )?.operation;
    if (!caseOperation || !Array.isArray(caseOperation.canonicalPayload.lines)) {
      throw new Error("test mutation has no linked Accounting Case economics");
    }
    const casePayload = caseOperation.canonicalPayload;
    const caseLines = casePayload.lines as Array<Record<string, unknown>>;
    const tamperEconomics = tamperReadbackEconomicsAtOrdinals.has(ordinal);
    // One bad provider read is followed by a corrected exact GET during
    // recovery. This models provider-side eventual correction without ever
    // reopening the create boundary.
    if (tamperEconomics) tamperReadbackEconomicsAtOrdinals.delete(ordinal);
    const shiftFour = (value: unknown): string => {
      if (typeof value !== "string" || !/^-?\d+\.\d{4}$/u.test(value)) throw new Error("test amount is not fixed-four");
      const shifted = BigInt(value.replace(".", "")) + 10_000n;
      const digits = shifted.toString().padStart(5, "0");
      return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
    };
    const totalTax = tamperEconomics ? shiftFour(casePayload.tax) : casePayload.tax;
    const total = tamperEconomics ? shiftFour(casePayload.gross) : casePayload.gross;
    const readbackSnapshot = {
      xeroObjectId,
      status: "DRAFT",
      canonicalPayload: request.canonicalPayload,
      evidence: {
        providerDocumentReadback: {
          invoiceId: xeroObjectId,
          type: caseOperation.nativeRoute === "SUPPLIER_BILL" ? "ACCPAY" : "ACCREC",
          status: "DRAFT",
          subTotal: casePayload.net,
          totalTax,
          total,
          lineItemCount: caseLines.length,
          linesTruncated: false,
          lines: caseLines.map((line, index) => ({
            lineAmount: line.net,
            taxAmount: tamperEconomics && index === 0 ? shiftFour(line.tax) : line.tax,
            accountId: line.accountId,
            accountCode: line.accountCode,
            taxType: line.taxType,
          })),
        },
      },
      ...(serverCoaConstraints ? {
        serverCoaExecutionConstraints: structuredClone(serverCoaConstraints),
      } : {}),
    };
    const verified = await repository.markXeroMutationReadbackVerified({
      ...mutationBoundInput(request),
      xeroObjectId,
      writeReceipt,
      readbackSnapshot,
      readbackSnapshotHash: hashObject(readbackSnapshot),
      readbackCanonicalPayload: request.canonicalPayload,
      readbackPayloadHash: request.canonicalPayloadHash,
      readbackStatus: "DRAFT",
    });
    return { verified, xeroObjectId, writeReceipt, readbackSnapshot };
  };
  const executePreparedSalesInvoiceDraft = vi.fn(async (
    requestContext: RequestContext,
    input: { preparation_id: string; request_id: string },
    serverCoaConstraints?: XeroDeclaredLedgerExecutionConstraints,
    beforeProviderWriteClaim?: () => Promise<void>,
  ) => {
    operationRequestIds.push(input.request_id);
    const preparation = await repository.getXeroMutationPreparation(input.preparation_id);
    if (!preparation) throw new Error("test mutation preparation missing");
    const mutationRequestId = xeroMutationRequestIdForPreparation(preparation.preparationId);
    const existing = await repository.getXeroMutationRequest(mutationRequestId);
    if (existing?.state === "READBACK_VERIFIED") {
      return {
        invoiceId: existing.xeroObjectId,
        mutationRequestId,
        providerReceipt: existing.writeReceipt,
        invoice: existing.readbackSnapshot,
      };
    }
    if (existing && ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(existing.state)) {
      exactProviderGet({ mutationRequestId });
      const recovered = await completeReadback(
        requestContext,
        existing,
        serverCoaConstraints ?? coaConstraintsByPreparation.get(preparation.preparationId),
      );
      return {
        invoiceId: recovered.xeroObjectId,
        mutationRequestId,
        providerReceipt: recovered.writeReceipt,
        invoice: recovered.readbackSnapshot,
      };
    }

    const outcome = executionOutcomes.shift() ?? "SUCCESS";
    if (outcome === "APPROVAL_EXPIRED") {
      const expiredAt = new Date(preparation.expiresAt.getTime() + 1);
      if (options?.clock) {
        options.clock.value = expiredAt;
      }
      await repository.confirmXeroMutationPreparation({
        ...bindingFor(requestContext),
        mutationRequestId,
        preparationId: preparation.preparationId,
        requestId: input.request_id,
        objectType: preparation.objectType,
        operation: preparation.operation,
        canonicalPayload: preparation.canonicalPayload,
        canonicalPayloadHash: preparation.canonicalPayloadHash,
        ...(preparation.sourceRef ? { sourceRef: preparation.sourceRef } : {}),
        sourceUnitKey: preparation.sourceUnitKey,
        sourceSha256: preparation.sourceSha256,
        sourceEvidenceType: preparation.sourceEvidenceType,
        confirmationSummaryHash: preparation.confirmationSummaryHash,
        confirmationPhraseHash: preparation.confirmationPhraseHash,
        authorizationReceipt: { receiptType: "TEST_AUTONOMOUS_AUTHORITY" },
        successfulValidationReceipt: { result: "PASS" },
        claimForWrite: true,
        now: expiredAt,
      });
      throw new AppError("APPROVAL_INVALID", "Mutation preparation has expired.", { httpStatus: 409 });
    }
    if (outcome === "PREWRITE_FAILURE") {
      throw new AppError("FORBIDDEN", "Provider permission check failed before the mutation claim.", {
        httpStatus: 403,
      });
    }
    await beforeProviderWriteClaim?.();
    const confirmed = await repository.confirmXeroMutationPreparation({
      ...bindingFor(requestContext),
      mutationRequestId,
      preparationId: preparation.preparationId,
      requestId: input.request_id,
      objectType: preparation.objectType,
      operation: preparation.operation,
      canonicalPayload: preparation.canonicalPayload,
      canonicalPayloadHash: preparation.canonicalPayloadHash,
      ...(preparation.sourceRef ? { sourceRef: preparation.sourceRef } : {}),
      sourceUnitKey: preparation.sourceUnitKey,
      sourceSha256: preparation.sourceSha256,
      sourceEvidenceType: preparation.sourceEvidenceType,
      confirmationSummaryHash: preparation.confirmationSummaryHash,
      confirmationPhraseHash: preparation.confirmationPhraseHash,
      authorizationReceipt: { receiptType: "TEST_AUTONOMOUS_AUTHORITY" },
      successfulValidationReceipt: { result: "PASS" },
      claimForWrite: true,
      now: options?.clock?.value ?? new Date("2026-08-13T04:00:00.000Z"),
    });
    if (!confirmed) throw new Error("test mutation confirmation failed");
    providerWritePermit({ mutationRequestId });
    providerWrite({ preparationId: preparation.preparationId, requestId: input.request_id });
    if (outcome === "DEFINITE_FAILURE") {
      await repository.rejectXeroMutationProvider({
        ...mutationBoundInput(confirmed.request),
        providerRejectionReceipt: { reasonCode: "PROVIDER_ERROR", writeOutcome: "DEFINITELY_REJECTED" },
      });
      throw new AppError("PROVIDER_ERROR", "Xero definitely rejected the draft.", {
        httpStatus: 422,
        details: { writeOutcome: "DEFINITELY_REJECTED" },
      });
    }
    if (outcome === "WRITE_UNCERTAIN") {
      const ordinal = preparedOperationIds.get(confirmed.request.preparationId) ?? 0;
      const xeroObjectId = [
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
      ][ordinal] ?? `invoice-${ordinal}`;
      const writeReceipt = { providerRequestId: `provider-request-${ordinal + 1}` };
      const withEvidence = await repository.recordXeroMutationWriteEvidence({
        ...mutationBoundInput(confirmed.request),
        xeroObjectId,
        writeReceipt,
      });
      await repository.markXeroMutationWriteUnknown({
        ...mutationBoundInput(withEvidence),
        xeroObjectId,
        writeReceipt,
      });
      throw new AppError("WRITE_RESULT_UNKNOWN", "The write completed but readback was interrupted.", {
        httpStatus: 502,
        retryable: true,
      });
    }
    const completed = await completeReadback(
      requestContext,
      confirmed.request,
      serverCoaConstraints ?? coaConstraintsByPreparation.get(preparation.preparationId),
    );
    return {
      invoiceId: completed.xeroObjectId,
      mutationRequestId,
      providerReceipt: completed.writeReceipt,
      invoice: completed.readbackSnapshot,
    };
  });
  const createCreditNoteDraft = vi.fn(async (
    requestContext: RequestContext,
    input: { preparation_id: string; request_id: string },
    serverCoaConstraints?: XeroDeclaredLedgerExecutionConstraints,
    beforeProviderWriteClaim?: () => Promise<void>,
  ) => {
    const preparation = await repository.getXeroMutationPreparation(input.preparation_id);
    if (!preparation || preparation.objectType !== "CREDIT_NOTE" || preparation.operation !== "CREATE_DRAFT") {
      throw new Error("test credit mutation preparation missing");
    }
    const mutationRequestId = xeroMutationRequestIdForPreparation(preparation.preparationId);
    const existing = await repository.getXeroMutationRequest(mutationRequestId);
    if (existing?.state === "READBACK_VERIFIED") return { mutation_request_id: mutationRequestId };
    await beforeProviderWriteClaim?.();
    const confirmed = await repository.confirmXeroMutationPreparation({
      ...bindingFor(requestContext),
      mutationRequestId,
      preparationId: preparation.preparationId,
      requestId: input.request_id,
      objectType: "CREDIT_NOTE",
      operation: "CREATE_DRAFT",
      canonicalPayload: preparation.canonicalPayload,
      canonicalPayloadHash: preparation.canonicalPayloadHash,
      ...(preparation.sourceRef ? { sourceRef: preparation.sourceRef } : {}),
      sourceUnitKey: preparation.sourceUnitKey,
      sourceSha256: preparation.sourceSha256,
      sourceEvidenceType: preparation.sourceEvidenceType,
      confirmationSummaryHash: preparation.confirmationSummaryHash,
      confirmationPhraseHash: preparation.confirmationPhraseHash,
      authorizationReceipt: { receiptType: "TEST_AUTONOMOUS_AUTHORITY" },
      successfulValidationReceipt: { result: "PASS" },
      claimForWrite: true,
      now: options?.clock?.value ?? new Date("2026-08-13T04:00:00.000Z"),
    });
    if (!confirmed) throw new Error("test credit mutation confirmation failed");
    providerWritePermit({ mutationRequestId });
    providerWrite({ preparationId: preparation.preparationId, requestId: input.request_id, objectType: "CREDIT_NOTE" });
    const creditNoteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const receipt = { operation: "CREATE_CREDIT_NOTE_DRAFT", creditNoteId };
    const withWrite = await repository.recordXeroMutationWriteEvidence({
      ...mutationBoundInput(confirmed.request),
      xeroObjectId: creditNoteId,
      writeReceipt: receipt,
    });
    const caseRecord = await repository.getAccessibleAccountingCase({
      currentAccessBinding: caseBindingFor(requestContext),
      caseId: typeof preparation.sourceRef === "string" && preparation.sourceRef.startsWith("case:")
        ? preparation.sourceRef.slice("case:".length)
        : "",
      mode: "STATUS",
      now: options?.clock?.value ?? new Date("2026-08-13T04:00:00.000Z"),
    });
    const operation = caseRecord?.operations.find((candidate) =>
      candidate.operation.operationId === preparation.sourceUnitKey)?.operation;
    if (!operation || !Array.isArray(operation.canonicalPayload.lines) ||
        !Array.isArray(preparation.canonicalPayload.lines)) {
      throw new Error("test credit mutation has no linked Case economics");
    }
    const caseLines = operation.canonicalPayload.lines as Array<Record<string, unknown>>;
    const preparedLines = preparation.canonicalPayload.lines as Array<Record<string, unknown>>;
    const readbackSnapshot = {
      xeroObjectId: creditNoteId,
      status: "DRAFT",
      canonicalPayload: preparation.canonicalPayload,
      evidence: {
        objectType: "CREDIT_NOTE",
        creditNoteId,
        providerEconomicsEvidence: {
          lineAmounts: caseLines.map((line) => line.net),
          taxAmounts: caseLines.map((line) => line.tax),
          subTotal: operation.canonicalPayload.net,
          totalTax: operation.canonicalPayload.tax,
          total: operation.canonicalPayload.gross,
          accountIds: preparedLines.map((line) => line.accountId),
          accountCodes: preparedLines.map((line) => line.accountCode),
          taxTypes: preparedLines.map((line) => line.taxType),
          noDiscountsVerified: true,
        },
      },
      ...(serverCoaConstraints ? { serverCoaExecutionConstraints: structuredClone(serverCoaConstraints) } : {}),
    };
    await repository.markXeroMutationReadbackVerified({
      ...mutationBoundInput(withWrite),
      xeroObjectId: creditNoteId,
      writeReceipt: receipt,
      readbackSnapshot,
      readbackSnapshotHash: hashObject(readbackSnapshot),
      readbackCanonicalPayload: preparation.canonicalPayload,
      readbackPayloadHash: preparation.canonicalPayloadHash,
      readbackStatus: "DRAFT",
    });
    return { mutation_request_id: mutationRequestId };
  });
  const createContact = vi.fn(async (
    requestContext: RequestContext,
    input: { preparation_id: string; request_id: string },
    beforeProviderWriteClaim?: () => Promise<void>,
  ) => {
    const preparation = await repository.getXeroMutationPreparation(input.preparation_id);
    if (!preparation || preparation.objectType !== "CONTACT" || preparation.operation !== "CREATE") {
      throw new Error("test contact mutation preparation missing");
    }
    const mutationRequestId = xeroMutationRequestIdForPreparation(preparation.preparationId);
    const existing = await repository.getXeroMutationRequest(mutationRequestId);
    if (existing?.state === "READBACK_VERIFIED") {
      return { mutation_request_id: mutationRequestId };
    }
    const target = preparation.canonicalPayload.target;
    if (!target || typeof target !== "object" || Array.isArray(target) || typeof target.name !== "string") {
      throw new Error("test contact target missing");
    }
    const completeContactReadback = async (request: XeroMutationRequest) => {
      const ordinal = preparedOperationIds.get(request.preparationId) ?? 0;
      const objectId = [
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
        "99999999-9999-4999-8999-999999999999",
      ][ordinal] ?? `contact-${ordinal}`;
      const writeReceipt = request.writeReceipt ?? { providerRequestId: `provider-contact-request-${ordinal + 1}` };
      if (!request.xeroObjectId || !request.writeReceipt) {
        request = await repository.recordXeroMutationWriteEvidence({
          ...mutationBoundInput(request),
          xeroObjectId: objectId,
          writeReceipt,
        });
      }
      const readbackSnapshot = {
        xeroObjectId: objectId,
        status: "ACTIVE",
        canonicalPayload: preparation.canonicalPayload,
        evidence: {
          snapshot: {
            ...target,
            contactId: objectId,
            status: "ACTIVE",
          },
        },
      };
      await repository.markXeroMutationReadbackVerified({
        ...mutationBoundInput(request),
        xeroObjectId: objectId,
        writeReceipt,
        readbackSnapshot,
        readbackSnapshotHash: hashObject(readbackSnapshot),
        readbackCanonicalPayload: preparation.canonicalPayload,
        readbackPayloadHash: preparation.canonicalPayloadHash,
        readbackStatus: "ACTIVE",
      });
      if (!contacts.some((contact) => contact.contactId === objectId)) {
        contacts.push({
          contactId: objectId,
          name: target.name,
          status: "ACTIVE",
          ...(typeof target.email === "string" ? { email: target.email } : {}),
          ...(typeof target.companyNumber === "string" ? { companyNumber: target.companyNumber } : {}),
          ...(typeof target.accountNumber === "string" ? { accountNumber: target.accountNumber } : {}),
        });
      }
    };
    if (existing && ["WRITE_IN_FLIGHT", "WRITE_UNCERTAIN", "READBACK_MISMATCH"].includes(existing.state)) {
      exactProviderGet({ mutationRequestId });
      await completeContactReadback(existing);
      return { mutation_request_id: mutationRequestId };
    }
    const outcome = executionOutcomes.shift() ?? "SUCCESS";
    options?.beforeContactProviderClaim?.(contacts);
    await beforeProviderWriteClaim?.();
    const confirmed = await repository.confirmXeroMutationPreparation({
      ...bindingFor(requestContext),
      mutationRequestId,
      preparationId: preparation.preparationId,
      requestId: input.request_id,
      objectType: "CONTACT",
      operation: "CREATE",
      canonicalPayload: preparation.canonicalPayload,
      canonicalPayloadHash: preparation.canonicalPayloadHash,
      ...(preparation.sourceRef ? { sourceRef: preparation.sourceRef } : {}),
      sourceUnitKey: preparation.sourceUnitKey,
      sourceSha256: preparation.sourceSha256,
      sourceEvidenceType: preparation.sourceEvidenceType,
      confirmationSummaryHash: preparation.confirmationSummaryHash,
      confirmationPhraseHash: preparation.confirmationPhraseHash,
      authorizationReceipt: { receiptType: "TEST_AUTONOMOUS_AUTHORITY" },
      successfulValidationReceipt: { receiptType: "TEST_VALIDATION" },
      claimForWrite: true,
      now: new Date("2026-08-13T04:00:00.000Z"),
    });
    if (!confirmed) throw new Error("test contact mutation confirmation failed");
    providerWritePermit({ mutationRequestId });
    providerWrite({ preparationId: preparation.preparationId, requestId: input.request_id });
    if (outcome === "WRITE_UNCERTAIN") {
      const ordinal = preparedOperationIds.get(confirmed.request.preparationId) ?? 0;
      const objectId = [
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
        "99999999-9999-4999-8999-999999999999",
      ][ordinal] ?? `contact-${ordinal}`;
      const writeReceipt = { providerRequestId: `provider-contact-request-${ordinal + 1}` };
      const withEvidence = await repository.recordXeroMutationWriteEvidence({
        ...mutationBoundInput(confirmed.request),
        xeroObjectId: objectId,
        writeReceipt,
      });
      await repository.markXeroMutationWriteUnknown({
        ...mutationBoundInput(withEvidence),
        xeroObjectId: objectId,
        writeReceipt,
      });
      throw new AppError("WRITE_RESULT_UNKNOWN", "The contact write completed but readback was interrupted.", {
        httpStatus: 502,
        retryable: true,
      });
    }
    await completeContactReadback(confirmed.request);
    return { mutation_request_id: mutationRequestId };
  });
  const accounting = {
    withAudit: vi.fn(async ({ action }: { action: () => Promise<unknown> }) => action()),
    listContacts: vi.fn(async (
      _context: RequestContext,
      input: { status: "ACTIVE" | "ARCHIVED" | "GDPRREQUEST"; page: number; limit: number },
    ) => {
      const matching = contacts.filter((contact) => contact.status === input.status);
      const start = (input.page - 1) * input.limit;
      const page = matching.slice(start, start + input.limit);
      return {
        contacts: structuredClone(page),
        pagination: {
          page: input.page,
          pageSize: input.limit,
          returned: page.length,
          providerPageCount: Math.max(1, Math.ceil(matching.length / input.limit)),
          providerItemCount: matching.length,
          hasNextPage: start + input.limit < matching.length,
          hasNextPageIsEstimated: false,
          omittedInvalid: 0,
        },
      };
    }),
    searchContacts: vi.fn(async (_context: RequestContext, input: { query: string }) => {
      const matches = contacts.filter((contact) =>
        contact.name.trim().toLocaleLowerCase("en") === input.query.trim().toLocaleLowerCase("en"));
      return {
        contacts: structuredClone(matches),
        pagination: { page: 1, pageSize: 100, returned: matches.length, hasNextPage: false, hasNextPageIsEstimated: false, omittedInvalid: 0 },
      };
    }),
    getContact: vi.fn(async (_context: RequestContext, input: { contact_id: string }) => {
      const contact = contacts.find((candidate) => candidate.contactId === input.contact_id);
      if (!contact) throw new AppError("NOT_FOUND", "The requested Xero contact was not found.", { httpStatus: 404 });
      return structuredClone(contact);
    }),
    listAccounts: vi.fn().mockResolvedValue((() => {
      const configured = options?.accounts ?? testXeroAccounts();
      return [...configured, ...testXeroAccounts().filter((fallback) => !configured.some((candidate) =>
        candidate.accountId === fallback.accountId || candidate.code === fallback.code))];
    })()),
    listTaxRates: vi.fn().mockResolvedValue(options?.taxRates ?? [{
      taxType: "OUTPUTY24",
      status: "ACTIVE",
      displayTaxRate: "9.0000",
      effectiveRate: "9.0000",
      canApplyToRevenue: true,
    }]),
    prepareSalesInvoiceDraft: vi.fn(persistPreparedSalesInvoiceDraft),
    prepareSupplierBillDraft: vi.fn(persistPreparedSalesInvoiceDraft),
    prepareContactCreate: vi.fn(persistPreparedContact),
    prepareCreditNoteDraft: vi.fn(persistPreparedCreditNoteDraft),
    createCreditNoteDraft,
    createContact,
    executePreparedSalesInvoiceDraft,
    executePreparedSupplierBillDraft: vi.fn(executePreparedSalesInvoiceDraft),
  } as unknown as AccountingService;
  const authorityReceipt: AutonomousActionsPreflightReceipt = {
    receiptType: "XERO_AUTONOMOUS_ACTIONS_PREFLIGHT",
    tenantId,
    targetSessionId: "case-target-session",
    bindingRevision: 1,
    checkedAt: "2026-08-13T04:00:00.000Z",
    checks: [],
    receiptHash: "e".repeat(64),
  };
  const mutations = {
    preflightAutonomousActions: vi.fn().mockResolvedValue(authorityReceipt),
    markUnknown: vi.fn(async (_context: RequestContext, input: { mutationRequestId: string }) => {
      const request = await repository.getXeroMutationRequest(input.mutationRequestId);
      if (!request) throw new Error("test mutation request missing");
      return repository.markXeroMutationWriteUnknown(mutationBoundInput(request));
    }),
  } as unknown as Pick<XeroMutationService, "preflightAutonomousActions" | "markUnknown">;
  const service = new XeroAccountingCaseService(repository, provider, accounting, mutations, {
    continuationSecret,
    testTenantIds: options?.testTenant ? [tenantId] : [],
    businessAuthorityProfiles: options?.businessAuthorityProfiles ??
      [testXeroBusinessAuthorityProfile(tenantId)],
    clock: () => new Date(options?.clock?.value ?? "2026-08-13T04:00:00.000Z"),
  });
  return {
    repository,
    provider,
    accounting,
    mutations,
    service,
    providerWrite,
    providerWritePermit,
    exactProviderGet,
    operationRequestIds,
    preparedOperationIds,
    contacts,
    persistPreparedSalesInvoiceDraft,
  };
}

describe("XeroAccountingCaseService", () => {
  it.each(["CUSTOMER", "SUPPLIER"] as const)(
    "executes a credit-only %s Case as one credit write while the historical original remains evidence-only",
    async (role) => {
      const original = historicalOriginal(role);
      const history = { invoices: [original], creditNotes: [] };
      const harness = runtime({
        initialContacts: [{
          contactId: original.contact.contactId,
          name: original.contact.name!,
          status: "ACTIVE",
          isCustomer: role === "CUSTOMER",
          isSupplier: role === "SUPPLIER",
        }],
        providerHistorySequence: [history, history, history, history, history],
        taxRates: [{
          taxType: role === "CUSTOMER" ? "OUTPUTY24" : "INPUTY24",
          status: "ACTIVE",
          displayTaxRate: "9.0000",
          effectiveRate: "9.0000",
          ...(role === "CUSTOMER" ? { canApplyToRevenue: true } : { canApplyToExpenses: true }),
        }],
      });
      const publicInput = normalizeXeroAccountingCaseBusinessIntake(
        xeroAccountingCaseBusinessIntakeSchema.parse(historicalCreditBusinessIntake(role)),
      );
      const prepared = await harness.service.prepare(context(), publicInput);
      expect(prepared.operations).toHaveLength(1);
      expect(prepared.operations[0]).toMatchObject({ action_id: "credit_note.create_draft" });
      expect(prepared.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ disposition: "EVIDENCE_ONLY" }),
      ]));
      const preparedJson = JSON.stringify(prepared);
      expect(preparedJson).not.toContain(original.invoiceId);
      expect(preparedJson).not.toContain("invoiceId");
      expect(preparedJson).not.toContain("providerObjectId");

      const executed = await harness.service.execute(context(), {
        case_id: prepared.case_id,
        case_version: prepared.case_version,
        request_id: `execute-historical-${role.toLowerCase()}-credit`,
      });
      expect(executed.state).toBe("TERMINAL");
      expect(executed.operations).toEqual([
        expect.objectContaining({ state: "READBACK_VERIFIED", action_id: "credit_note.create_draft" }),
      ]);
      expect(harness.providerWrite).toHaveBeenCalledTimes(1);
      expect(harness.providerWrite).toHaveBeenCalledWith(expect.objectContaining({ objectType: "CREDIT_NOTE" }));
      expect(harness.providerWritePermit).toHaveBeenCalledTimes(1);
      expect(harness.accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
      expect(harness.accounting.prepareSupplierBillDraft).not.toHaveBeenCalled();
      const executedJson = JSON.stringify(executed);
      expect(executedJson).not.toContain(original.invoiceId);
      expect(executedJson).not.toContain("invoiceId");
      expect(executedJson).not.toContain("providerObjectId");
    },
  );

  it("allows a formal customer credit under provider uniqueness without exclusive-writer authority", async () => {
    const original = historicalOriginal("CUSTOMER");
    const history = { invoices: [original], creditNotes: [] };
    const harness = runtime({
      businessAuthorityProfiles: [],
      initialContacts: [{
        contactId: original.contact.contactId,
        name: original.contact.name!,
        status: "ACTIVE",
        isCustomer: true,
      }],
      providerHistorySequence: [history, history, history, history, history],
      taxRates: [{
        taxType: "OUTPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToRevenue: true,
      }],
    });
    const prepared = await harness.service.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse(historicalCreditBusinessIntake("CUSTOMER")),
    ));
    await expect(harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "customer-credit-provider-unique-no-writer",
    })).resolves.toMatchObject({ state: "TERMINAL" });
    expect(harness.providerWrite).toHaveBeenCalledOnce();
  });

  // Superseded deliberately. Firm-governance exclusive-writer authority is no
  // longer required to create a supplier credit note, even though Xero does
  // not enforce credit-note-number uniqueness for the supplier direction. The
  // residual that authority used to guard -- another writer creating the same
  // coordinate -- is carried instead by the provider coordinate-history
  // lookup already run above (`providerHistorySequence`), the durable
  // business-coordinate reservation, the idempotency identity, and the
  // receipt-plus-exact-readback chain asserted below. This is now the
  // positive case: the write must succeed end to end.
  it("writes a formal supplier credit though Xero never enforces credit-note-number uniqueness", async () => {
    const original = historicalOriginal("SUPPLIER");
    const history = { invoices: [original], creditNotes: [] };
    const harness = runtime({
      businessAuthorityProfiles: [],
      initialContacts: [{
        contactId: original.contact.contactId,
        name: original.contact.name!,
        status: "ACTIVE",
        isSupplier: true,
      }],
      providerHistorySequence: [history, history, history],
      taxRates: [{
        taxType: "INPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToExpenses: true,
      }],
    });
    const prepared = await harness.service.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse(historicalCreditBusinessIntake("SUPPLIER")),
    ));
    const executed = await harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "supplier-credit-no-writer",
    });
    expect(executed.state).toBe("TERMINAL");
    expect(executed.operations).toEqual([
      expect.objectContaining({
        action_id: "credit_note.create_draft",
        state: "READBACK_VERIFIED",
        provider_receipt_recorded: true,
        exact_readback_recorded: true,
        xero_object_id: expect.any(String),
      }),
    ]);
    expect(harness.providerWrite).toHaveBeenCalledOnce();
    expect(harness.providerWrite).toHaveBeenCalledWith(expect.objectContaining({ objectType: "CREDIT_NOTE" }));
    expect(harness.providerWritePermit).toHaveBeenCalledOnce();
  });

  it("blocks at the permit edge when a second original takes the same ordinary coordinate after preparation", async () => {
    const original = historicalOriginal("CUSTOMER");
    const duplicate = historicalOriginal("CUSTOMER", {
      invoiceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    const single = { invoices: [original], creditNotes: [] };
    const harness = runtime({
      initialContacts: [{
        contactId: original.contact.contactId,
        name: original.contact.name!,
        status: "ACTIVE",
        isCustomer: true,
      }],
      providerHistorySequence: [single, single, single, { invoices: [original, duplicate], creditNotes: [] }],
    });
    const prepared = await harness.service.prepare(
      context(),
      normalizeXeroAccountingCaseBusinessIntake(
        xeroAccountingCaseBusinessIntakeSchema.parse(historicalCreditBusinessIntake("CUSTOMER")),
      ),
    );
    await expect(harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "historical-original-became-ambiguous",
    })).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
      details: expect.objectContaining({
        reasonCodes: ["ORIGINAL_TRANSACTION_BECAME_AMBIGUOUS"],
        providerMutationPossible: false,
      }),
    });
    expect(harness.providerWritePermit).not.toHaveBeenCalled();
    expect(harness.providerWrite).not.toHaveBeenCalled();
    const status = await harness.service.status(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    });
    expect(status.operations[0]?.state).not.toBe("WRITE_IN_FLIGHT");
  });

  it("resolves same-Case submitted original support from Xero and never turns its fabricated economics into an original write", async () => {
    const original = historicalOriginal("CUSTOMER");
    const history = { invoices: [original], creditNotes: [] };
    const harness = runtime({
      initialContacts: [{
        contactId: original.contact.contactId,
        name: original.contact.name!,
        status: "ACTIVE",
        isCustomer: true,
      }],
      providerHistorySequence: [history],
    });
    const prepared = await harness.service.prepare(
      context(),
      normalizeXeroAccountingCaseBusinessIntake(
        xeroAccountingCaseBusinessIntakeSchema.parse(historicalSameCaseCreditBusinessIntake()),
      ),
    );
    expect(prepared.operations).toEqual([
      expect.objectContaining({ action_id: "credit_note.create_draft" }),
    ]);
    expect(prepared.events.filter((event) => event.disposition === "EVIDENCE_ONLY")).toHaveLength(2);
    expect(harness.provider.listInvoices).toHaveBeenCalledTimes(1);
    expect(harness.provider.getInvoice).toHaveBeenCalledWith(
      expect.anything(),
      original.invoiceId,
      "ACCREC",
    );
    expect(harness.accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(JSON.stringify(prepared)).not.toContain(original.invoiceId);
    expect(JSON.stringify(prepared)).not.toContain("999.00");
  });

  it.each([
    ["contact", { contact: { contactId: "99999999-9999-4999-8999-999999999999", name: "Other" } }],
    ["currency", { currency: "USD" }],
    ["status", { status: "DRAFT" }],
    ["tax", {
      lines: [{
        ...historicalOriginal("CUSTOMER").lines[0]!,
        taxAmount: "17.0000",
      }],
    }],
    ["account", {
      lines: [{
        ...historicalOriginal("CUSTOMER").lines[0]!,
        accountId: "99999999-9999-4999-8999-999999999999",
      }],
    }],
    ["economics", { amountPaid: "1.0000" }],
  ] as const)(
    "blocks permit/write when the sealed historical original has %s drift",
    async (_label, patch) => {
      const original = historicalOriginal("CUSTOMER");
      const drifted = historicalOriginal("CUSTOMER", patch as Partial<InvoiceSnapshot>);
      const stable = { invoices: [original], creditNotes: [] };
      const harness = runtime({
        initialContacts: [{
          contactId: original.contact.contactId,
          name: original.contact.name!,
          status: "ACTIVE",
          isCustomer: true,
        }],
        providerHistorySequence: [stable, stable, stable, { invoices: [drifted], creditNotes: [] }],
      });
      const prepared = await harness.service.prepare(
        context(),
        normalizeXeroAccountingCaseBusinessIntake(
          xeroAccountingCaseBusinessIntakeSchema.parse(historicalCreditBusinessIntake("CUSTOMER")),
        ),
      );
      await expect(harness.service.execute(context(), {
        case_id: prepared.case_id,
        case_version: prepared.case_version,
        request_id: `historical-original-${_label}-drift`,
      })).rejects.toMatchObject({
        code: "STALE_PREFLIGHT",
        details: expect.objectContaining({ providerMutationPossible: false }),
      });
      expect(harness.providerWritePermit).not.toHaveBeenCalled();
      expect(harness.providerWrite).not.toHaveBeenCalled();
      const status = await harness.service.status(context(), {
        case_id: prepared.case_id,
        case_version: prepared.case_version,
      });
      expect(status.operations[0]?.state).not.toBe("WRITE_IN_FLIGHT");
    },
  );

  it("returns NO_WRITE_REQUIRED_EXISTING when Xero history already has the exact invoice and local DB is empty", async () => {
    const harness = runtime({
      providerHistorySequence: [{ invoices: [exactProviderSalesInvoice()] }],
    });
    const prepared = await harness.service.prepare(context(), source());
    const executed = await harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "history-existing-exact",
    });
    expect(executed.state).toBe("TERMINAL");
    expect(executed.operations).toEqual([
      expect.objectContaining({ state: "NO_WRITE_REQUIRED", exact_readback_recorded: true }),
    ]);
    expect(harness.accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(harness.providerWrite).not.toHaveBeenCalled();
    expect(harness.providerWritePermit).not.toHaveBeenCalled();
  });

  it("fails closed before preparation when provider history pagination is incomplete", async () => {
    const harness = runtime({ providerHistorySequence: [{ incomplete: true }] });
    const prepared = await harness.service.prepare(context(), source());
    await expect(harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "history-incomplete-pagination",
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        reasonCodes: expect.arrayContaining(["PROVIDER_PAGINATION_ESTIMATED"]),
        providerMutationPossible: false,
      }),
    });
    expect(harness.accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(harness.providerWrite).not.toHaveBeenCalled();
  });

  it("allows a provider-unique formal sales invoice without exclusive-writer authority", async () => {
    const harness = runtime({ businessAuthorityProfiles: [] });
    const prepared = await harness.service.prepare(context(), source());
    await expect(harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "history-no-exclusive-writer",
    })).resolves.toMatchObject({ state: "TERMINAL" });
    expect(harness.accounting.prepareSalesInvoiceDraft).toHaveBeenCalledOnce();
    expect(harness.providerWrite).toHaveBeenCalledOnce();
  });

  // Superseded deliberately. Firm-governance exclusive-writer authority is no
  // longer required to create a supplier bill, even though Xero does not
  // enforce uniqueness on ACCPAY bill numbers -- the residual that authority
  // used to guard is carried instead by the provider coordinate-history
  // lookup, the durable business-coordinate reservation, the idempotency
  // identity, and the receipt-plus-exact-readback chain asserted below. This
  // is now the positive case the product decision exists to enable: the
  // write must succeed end to end.
  it("writes a supplier bill though Xero never enforces ACCPAY bill-number uniqueness", async () => {
    const harness = runtime({
      businessAuthorityProfiles: [],
      initialContacts: [{
        contactId: "23232323-2323-4232-8232-232323232323",
        name: "Exact Supplier",
        status: "ACTIVE",
        isSupplier: true,
      }],
    });
    const prepared = await harness.service.prepare(context(), supplierBillSource());
    const executed = await harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "supplier-history-no-exclusive-writer",
    });
    expect(executed.state).toBe("TERMINAL");
    expect(executed.operations).toEqual([
      expect.objectContaining({
        action_id: "supplier_bill.create_draft",
        state: "READBACK_VERIFIED",
        provider_receipt_recorded: true,
        exact_readback_recorded: true,
        xero_object_id: expect.any(String),
      }),
    ]);
    expect(harness.accounting.prepareSupplierBillDraft).toHaveBeenCalledOnce();
    expect(harness.providerWrite).toHaveBeenCalledOnce();
  });

  it("rechecks provider history inside the final permit callback and blocks economic drift with zero write", async () => {
    const harness = runtime({
      providerHistorySequence: [
        {},
        { invoices: [exactProviderSalesInvoice({ total: "999.0000" })] },
      ],
    });
    const prepared = await harness.service.prepare(context(), source());
    await expect(harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "history-final-drift",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: expect.objectContaining({
        reasonCodes: expect.arrayContaining([
          "PROVIDER_BUSINESS_COORDINATE_ECONOMIC_MISMATCH",
          "TOTAL_MISMATCH",
        ]),
        providerMutationPossible: false,
      }),
    });
    expect(harness.accounting.prepareSalesInvoiceDraft).toHaveBeenCalledTimes(1);
    expect(harness.providerWritePermit).not.toHaveBeenCalled();
    expect(harness.providerWrite).not.toHaveBeenCalled();
  });

  it("blocks a tenant-wide provider-unique formal number owned by a different contact with zero permit/write", async () => {
    const harness = runtime({
      businessAuthorityProfiles: [],
      providerHistorySequence: [{
        invoices: [exactProviderSalesInvoice({
          contact: {
            contactId: "99999999-9999-4999-8999-999999999999",
            name: "Different Customer",
          },
        })],
      }],
    });
    const prepared = await harness.service.prepare(context(), source());
    await expect(harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "unique-number-different-contact",
    })).rejects.toMatchObject({
      code: "CONFLICT",
      details: expect.objectContaining({
        reasonCodes: expect.arrayContaining([
          "PROVIDER_BUSINESS_COORDINATE_ECONOMIC_MISMATCH",
          "CONTACT_ID_MISMATCH",
        ]),
        providerMutationPossible: false,
      }),
    });
    expect(harness.accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(harness.providerWritePermit).not.toHaveBeenCalled();
    expect(harness.providerWrite).not.toHaveBeenCalled();
  });

  it("turns an exact object appearing at the final permit recheck into no-write success", async () => {
    const harness = runtime({
      providerHistorySequence: [{}, { invoices: [exactProviderSalesInvoice()] }],
    });
    const prepared = await harness.service.prepare(context(), source());
    const executed = await harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "history-final-exact-existing",
    });
    expect(executed.operations).toEqual([
      expect.objectContaining({ state: "NO_WRITE_REQUIRED", exact_readback_recorded: true }),
    ]);
    expect(harness.providerWritePermit).not.toHaveBeenCalled();
    expect(harness.providerWrite).not.toHaveBeenCalled();
  });

  it("blocks an untrusted public generic reference without server recurring-series authority", async () => {
    const harness = runtime();
    const july = await harness.service.prepare(
      context(),
      recurringSource("case-untrusted-recurring-july", "2026-07-20", "2026-08-20"),
    );
    await expect(harness.service.execute(context(), {
      case_id: july.case_id,
      case_version: july.case_version,
      request_id: "untrusted-recurring-july",
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        reasonCodes: ["PROVIDER_RECURRING_SERIES_AUTHORITY_UNPROVEN"],
        providerMutationPossible: false,
      }),
    });
    expect(harness.providerWrite).not.toHaveBeenCalled();
  });

  it("allows separate dated occurrences only under an exact server recurring-series authority", async () => {
    const baseAuthority = testXeroBusinessAuthorityProfile(tenantId);
    const authority = parseXeroAccountingCaseBusinessAuthorityProfiles([{
      ...baseAuthority,
      recurring_series_authorities: [{
        authority_id: "case-test-monthly-retainer",
        revision: 1,
        route: "SALES_INVOICE",
        contact_id: "22222222-2222-4222-8222-222222222222",
        reference: "MONTHLY-RETAINER",
        authoritative_provider_field: "REFERENCE",
        normalization_version: "xero-reference-coordinate:v1",
        occurrence_key: "DOCUMENT_DATE",
        verification_receipt_sha256:
          baseAuthority.writer_authority.mode === "VERIFIED_FIRM_GOVERNANCE"
            ? baseAuthority.writer_authority.verification_receipt_sha256
            : "e".repeat(64),
        ...(baseAuthority.writer_authority.mode === "VERIFIED_FIRM_GOVERNANCE" ? {
          status_manifest_sha256: baseAuthority.writer_authority.status_manifest_sha256,
          trust_bundle_sha256: baseAuthority.writer_authority.trust_bundle_sha256,
          expires_at: baseAuthority.writer_authority.expires_at,
        } : {}),
      }],
    }]);
    const harness = runtime({ businessAuthorityProfiles: authority });
    for (const [caseId, date, dueDate] of [
      ["case-trusted-recurring-july", "2026-07-20", "2026-08-20"],
      ["case-trusted-recurring-august", "2026-08-20", "2026-09-20"],
    ] as const) {
      const prepared = await harness.service.prepare(context(), recurringSource(caseId, date, dueDate));
      await harness.service.execute(context(), {
        case_id: prepared.case_id,
        case_version: prepared.case_version,
        request_id: `trusted-recurring-${date}`,
      });
    }
    expect(harness.providerWrite).toHaveBeenCalledTimes(2);
  });

  it("derives target and policy server-side, persists the plan, and never claims a prepare as a write", async () => {
    const { service, provider } = runtime();
    const requestContext = context();
    const prepared = await service.prepare(requestContext, source());
    expect(provider.resolveContext).toHaveBeenCalledWith(requestContext);
    expect(prepared).toMatchObject({
      case_id: "case-service-1",
      case_version: 1,
      state: "PLANNED_NEEDS_PREFLIGHT",
      persistence_mode: "CREATED",
      source_claim: {
        trust: "UNVERIFIED_SUBMITTED_FACTS",
        source_truth_claim: "NOT_VERIFIED",
        original_file_verified: false,
        fact_origins: ["MODEL_EXTRACTED"],
        document_validity_basis: "SUBMITTED_ASSERTION",
      },
      completion_claim: {
        supplied_set_coverage: "COMPLETE",
        eligible_write_status: "NONE",
        whole_business_completeness: "NOT_ASSERTED",
        ledger_write_claim: "NOT_WRITTEN",
      },
    });
    expect(prepared.operations).toHaveLength(1);
  });

  it("blocks test-marked documents on production tenants before any Xero write", async () => {
    const { service, accounting, mutations, providerWrite, providerWritePermit } = runtime();
    const submitted = source("TEST_OR_NOT_VALID");
    submitted.sources.push({
      artifactId: "customer-artifact",
      label: "Customer setup",
      units: [{ unitId: "customer-page-1", expectedFactKinds: ["CONTACT_CANDIDATE" as const] }],
    });
    submitted.facts.push({
      factId: "customer-v1",
      lineageKey: "customer",
      eventKey: "customer-event",
      sourceUnitIds: ["customer-page-1"],
      origin: "MODEL_EXTRACTED" as const,
      revision: 1,
      kind: "CONTACT_CANDIDATE" as const,
      usageRoles: ["CUSTOMER"] as const,
      name: "Exact Customer",
      bankVerification: "NOT_APPLICABLE" as const,
    });
    const prepared = await service.prepare(context(), submitted);
    expect(prepared.state).toBe("BLOCKED_VALIDATION");
    expect(prepared.operations).toEqual([]);
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-production-test-doc",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("rejects a read-only ordinary Case after exact state load and before preflight, preparation, permit, or write", async () => {
    const {
      service,
      accounting,
      mutations,
      providerWrite,
      providerWritePermit,
    } = runtime({ testTenant: true });
    const prepared = await service.prepare(context(), source("TEST_OR_NOT_VALID"));

    await expect(service.execute(context({ scopes: ["xero.read"] }), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-ordinary-read-only",
    })).rejects.toMatchObject({
      code: "SCOPE_MISSING",
      details: {
        failureLayer: "MCP_SCOPE",
        reasonCodes: ["MISSING_MCP_SCOPE"],
        recoveryAction: "REAUTHORISE_MCP_SCOPE",
        providerMutationPossible: false,
        requiredScopes: ["xero.draft.write"],
        caseState: "PLANNED_NEEDS_PREFLIGHT",
      },
    });
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("whole-case preflights authority and exact references, then reports success only after receipt and readback", async () => {
    const { service, accounting, mutations } = runtime({ testTenant: true });
    const requestContext = context();
    const prepared = await service.prepare(requestContext, source("TEST_OR_NOT_VALID"));
    const executed = await service.execute(requestContext, {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-case-service-1",
    });
    expect(mutations.preflightAutonomousActions).toHaveBeenCalledWith(requestContext, ["customer_invoice.create_draft"]);
    expect(accounting.prepareSalesInvoiceDraft).toHaveBeenCalledWith(requestContext, expect.objectContaining({
      customer_name: "Exact Customer",
      currency: "SGD",
      reference: "INV-CASE-001",
    }), expect.objectContaining({
      tenantId,
      bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      lines: [expect.objectContaining({
        accountCode: "200",
        accountId: "33333333-3333-4333-8333-333333333333",
        expectedType: "REVENUE",
        expectedClass: "REVENUE",
        expectedTaxType: "OUTPUTY24",
      })],
    }));
    expect(executed).toMatchObject({
      state: "TERMINAL",
      source_claim: {
        source_truth_claim: "NOT_VERIFIED",
        original_file_verified: false,
      },
      completion_claim: {
        eligible_write_status: "ALL_READBACK_VERIFIED",
        ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED",
      },
      operations: [{
        state: "READBACK_VERIFIED",
        provider_receipt_recorded: true,
        exact_readback_recorded: true,
        xero_object_id: "44444444-4444-4444-8444-444444444444",
      }],
    });
  });

  it("uses the sealed currency rounding rule when bridging a real preparation before any write", async () => {
    const { service, accounting, providerWrite } = runtime({ testTenant: true });
    const requestContext = context();
    const prepared = await service.prepare(
      requestContext,
      source("TEST_OR_NOT_VALID", "0.99", "0.99", "0.09", "1.08"),
    );
    const executed = await service.execute(requestContext, {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-case-service-rounded-sgd",
    });

    expect(accounting.prepareSalesInvoiceDraft).toHaveBeenCalledWith(requestContext, expect.objectContaining({
      currency: "SGD",
      lines: [expect.objectContaining({ quantity: 1, unit_amount: 0.99 })],
    }), expect.objectContaining({
      lines: [expect.objectContaining({ accountId: "33333333-3333-4333-8333-333333333333" })],
    }));
    expect(providerWrite).toHaveBeenCalledTimes(1);
    expect(executed).toMatchObject({
      state: "TERMINAL",
      operations: [{ state: "READBACK_VERIFIED" }],
    });
  });

  it("seals, writes once and exactly reads back one supplier bill whose lines map to accounts 453 and 485", async () => {
    const requestContext = context();
    const { service, repository, accounting, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [{
        contactId: "22222222-2222-4222-8222-222222222222",
        name: "Exact Supplier",
        status: "ACTIVE",
        isSupplier: true,
      }],
      accounts: [{
        accountId: "33333333-3333-4333-8333-333333333353",
        code: "453",
        status: "ACTIVE",
        class: "EXPENSE",
        type: "EXPENSE",
      }, {
        accountId: "33333333-3333-4333-8333-333333333385",
        code: "485",
        status: "ACTIVE",
        class: "EXPENSE",
        type: "EXPENSE",
      }],
      taxRates: [{
        taxType: "INPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToExpenses: true,
      }, {
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }],
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(mixedSupplierBillBusinessIntake());
    const prepared = await service.prepare(requestContext, normalized);
    expect(prepared.state).toBe("PLANNED_NEEDS_PREFLIGHT");
    const record = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    });
    const operation = record?.operations[0]?.operation;
    expect(operation?.nativeRoute).toBe("SUPPLIER_BILL");
    // ADR-002: accountingCategory/taxClass are opaque carriers of the caller's
    // own declared account code / TaxType now, not a semantic vocabulary.
    expect(operation?.amountBridge?.lineBridges).toEqual([
      expect.objectContaining({
        accountingCategory: "453",
        taxClass: "INPUTY24",
        effectiveTaxRateBps: 900,
        canonicalNet: "100.0000",
        canonicalTax: "9.0000",
      }),
      expect.objectContaining({
        accountingCategory: "485",
        taxClass: "NONE",
        effectiveTaxRateBps: 0,
        canonicalNet: "50.0000",
        canonicalTax: "0.0000",
      }),
    ]);
    expect(operation?.canonicalPayload.lines).toEqual([
      expect.objectContaining({ accountCode: "453", taxType: "INPUTY24" }),
      expect.objectContaining({ accountCode: "485", taxType: "NONE" }),
    ]);
    expect(operation?.canonicalPayload).not.toHaveProperty("accountingCategory");
    expect(operation?.canonicalPayload).not.toHaveProperty("taxClass");
    expect(operation?.canonicalPayload).not.toHaveProperty("effectiveTaxRateBps");

    const executed = await service.execute(requestContext, {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-mixed-supplier-bill",
    });
    expect(accounting.prepareSupplierBillDraft).toHaveBeenCalledWith(requestContext, expect.objectContaining({
      supplier_name: "Exact Supplier",
      reference: "BILL-MIXED-001",
      lines: [
        expect.objectContaining({ account_code: "453", tax_type: "INPUTY24" }),
        expect.objectContaining({ account_code: "485", tax_type: "NONE" }),
      ],
    }), expect.objectContaining({
      lines: [
        expect.objectContaining({
          accountCode: "453",
          accountId: "33333333-3333-4333-8333-333333333353",
          expectedType: "EXPENSE",
          expectedClass: "EXPENSE",
          expectedTaxType: "INPUTY24",
        }),
        expect.objectContaining({
          accountCode: "485",
          accountId: "33333333-3333-4333-8333-333333333385",
          expectedType: "EXPENSE",
          expectedClass: "EXPENSE",
          expectedTaxType: "NONE",
        }),
      ],
    }));
    expect(accounting.executePreparedSupplierBillDraft).toHaveBeenCalledWith(
      requestContext,
      expect.objectContaining({ preparation_id: expect.any(String) }),
      expect.objectContaining({
        lines: [
          expect.objectContaining({ accountId: "33333333-3333-4333-8333-333333333353" }),
          expect.objectContaining({ accountId: "33333333-3333-4333-8333-333333333385" }),
        ],
      }),
      expect.any(Function),
      expect.objectContaining({
        route: "SUPPLIER_BILL",
        referenceKind: "FORMAL_DOCUMENT_NUMBER",
        authoritativeProviderField: "INVOICE_NUMBER",
      }),
    );
    expect(providerWritePermit).toHaveBeenCalledTimes(1);
    expect(providerWrite).toHaveBeenCalledTimes(1);
    const terminalRecord = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    });
    const operationRecord = terminalRecord?.operations[0];
    expect(terminalRecord?.preflightReceipt).toMatchObject({
      operations: [expect.objectContaining({
        serverCoaExecutionConstraints: expect.objectContaining({
          tenantId,
          bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          constraintsHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          lines: [
            expect.objectContaining({
              accountCode: "453",
              accountId: "33333333-3333-4333-8333-333333333353",
            }),
            expect.objectContaining({
              accountCode: "485",
              accountId: "33333333-3333-4333-8333-333333333385",
            }),
          ],
        }),
      })],
    });
    if (!operationRecord?.mutationRequestId) throw new Error("mixed operation mutation request missing");
    await expect(repository.getXeroMutationRequest(operationRecord.mutationRequestId)).resolves.toMatchObject({
      readbackSnapshot: {
        serverCoaExecutionConstraints: expect.objectContaining({
          tenantId,
          bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          constraintsHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          lines: [
            expect.objectContaining({ accountId: "33333333-3333-4333-8333-333333333353" }),
            expect.objectContaining({ accountId: "33333333-3333-4333-8333-333333333385" }),
          ],
        }),
      },
    });
    expect(executed).toMatchObject({
      state: "TERMINAL",
      completion_claim: { ledger_write_claim: "ALL_ELIGIBLE_WRITES_READBACK_VERIFIED" },
      operations: [{ state: "READBACK_VERIFIED", exact_readback_recorded: true }],
    });
  });

  it.each([
    ["unknown declared account code", (normalized: PrepareAccountingCasePublicInput) => {
      const fact = normalized.facts.find((candidate) => candidate.kind === "NATIVE_DOCUMENT");
      if (!fact || fact.kind !== "NATIVE_DOCUMENT") throw new Error("mixed fixture has no native document");
      fact.lines[1]!.accountCode = "999";
    }, "DECLARED_ACCOUNT_NOT_FOUND"],
    ["self-consistent but wrong mixed-line source tax", (_normalized: PrepareAccountingCasePublicInput) => {}, "SOURCE_LINE_TAX_MISMATCH"],
  ] as const)("blocks %s for the whole document with zero provider write", async (_label, mutate, reasonCode) => {
    const { service, accounting, mutations, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      accounts: [{
        accountId: "33333333-3333-4333-8333-333333333353",
        code: "453",
        status: "ACTIVE",
        class: "EXPENSE",
        type: "EXPENSE",
      }, {
        accountId: "33333333-3333-4333-8333-333333333385",
        code: "485",
        status: "ACTIVE",
        class: "EXPENSE",
        type: "EXPENSE",
      }],
      taxRates: [{
        taxType: "INPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToExpenses: true,
      }, {
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }],
    });
    const normalized = normalizeXeroAccountingCaseBusinessIntake(
      mixedSupplierBillBusinessIntake(reasonCode === "SOURCE_LINE_TAX_MISMATCH" ? "8.00" : "9.00"),
    );
    mutate(normalized);
    const prepared = await service.prepare(context(), normalized);
    expect(prepared.state).toBe("BLOCKED_VALIDATION");
    expect(prepared.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason_codes: expect.arrayContaining([reasonCode]) }),
    ]));
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: `execute-blocked-${reasonCode.toLowerCase()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareSupplierBillDraft).not.toHaveBeenCalled();
    expect(accounting.executePreparedSupplierBillDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("durably stops a multi-operation Case on wrong readback economics and recovers by exact GET without another create", async () => {
    const {
      service,
      repository,
      providerWrite,
      providerWritePermit,
      exactProviderGet,
    } = runtime({ testTenant: true, tamperReadbackEconomicsAtOrdinals: [0] });
    const prepared = await service.prepare(context(), twoInvoiceSource());
    const command = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-wrong-economic-readback",
    };

    const mismatched = await service.execute(context(), command);
    expect(mismatched).toMatchObject({
      state: "RECOVERY_REQUIRED",
      operations: [{ state: "READBACK_MISMATCH" }, { state: "PREPARED" }],
    });
    expect(providerWrite).toHaveBeenCalledTimes(1);
    expect(providerWritePermit).toHaveBeenCalledTimes(1);
    const durableMismatch = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: prepared.case_id, version: prepared.case_version,
    });
    const mismatchOperation = durableMismatch?.operations[0];
    expect(mismatchOperation).toMatchObject({ state: "READBACK_MISMATCH" });
    const durableMutation = await repository.getXeroMutationRequest(mismatchOperation!.mutationRequestId!);
    expect(durableMutation).toMatchObject({
      state: "READBACK_MISMATCH",
      readbackMismatchReceipt: {
        receiptType: "ACCOUNTING_CASE_ECONOMIC_READBACK_MISMATCH",
        mismatchType: "ACCOUNTING_CASE_ECONOMICS",
        reasonCodes: expect.arrayContaining([expect.stringMatching(/MISMATCH$/u)]),
      },
    });
    expect(durableMutation).not.toHaveProperty("verifiedAt");

    const recovered = await service.execute(context(), command);
    expect(recovered).toMatchObject({
      state: "READY_TO_RESUME",
      operations: [{ state: "READBACK_VERIFIED" }, { state: "PREPARED" }],
    });
    expect(exactProviderGet).toHaveBeenCalledTimes(1);
    expect(providerWrite).toHaveBeenCalledTimes(1);
    expect(providerWritePermit).toHaveBeenCalledTimes(1);
    await expect(repository.getXeroMutationRequest(mismatchOperation!.mutationRequestId!))
      .resolves.toMatchObject({ state: "READBACK_VERIFIED" });
  });

  it("reports an exact server-resolved contact-only Case as not written", async () => {
    const { service, accounting, mutations, providerWrite, providerWritePermit } = runtime({ testTenant: true });
    const prepared = await service.prepare(context(), onlyUnresolvedContactSource());
    const executed = await service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-existing-contact-only",
    });
    expect(executed).toMatchObject({
      state: "TERMINAL",
      completion_claim: {
        eligible_write_status: "NONE",
        ledger_write_claim: "NOT_WRITTEN",
      },
      operations: [],
    });
    expect(mutations.preflightAutonomousActions).toHaveBeenCalledOnce();
    expect(accounting.prepareContactCreate).not.toHaveBeenCalled();
    expect(accounting.createContact).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("rejects A-renamed/B-took-name contact drift after sealing with zero provider create or permit", async () => {
    const aId = "22222222-2222-4222-8222-222222222222";
    const bId = "88888888-8888-4888-8888-888888888888";
    const { service, accounting, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [{ contactId: aId, name: "Exact Customer", status: "ACTIVE" }],
      onSalesInvoicePrepared: (contacts) => {
        const a = contacts.find((contact) => contact.contactId === aId);
        if (!a) throw new Error("test contact A missing");
        a.name = "Renamed Customer A";
        contacts.push({ contactId: bId, name: "Exact Customer", status: "ACTIVE" });
      },
    });
    const prepared = await service.prepare(context(), source("VALID_FOR_LIVE_BOOKS"));
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-contact-id-drift",
    })).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
      retryable: false,
      details: expect.objectContaining({
        failureLayer: "ACCOUNTING_CASE_PREFLIGHT",
        reasonCodes: ["CONTACT_BINDING_ID_MISMATCH"],
        providerMutationPossible: false,
      }),
    });
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("rechecks supplied strong identity immediately before write permit and rejects drift", async () => {
    const contactId = "77777777-7777-4777-8777-777777777777";
    const { service, accounting, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [],
      onSalesInvoicePrepared: (contacts) => {
        const contact = contacts.find((candidate) => candidate.contactId === contactId);
        if (!contact) throw new Error("test contact missing");
        contact.companyNumber = "CHANGED-REGISTRY-NUMBER";
      },
    });
    const publicFacts = contactDependentSource();
    const contactVersion = await service.prepare(context(), publicFacts);
    const executedContact = await service.execute(context(), {
      case_id: contactVersion.case_id,
      case_version: contactVersion.case_version,
      request_id: "execute-strong-contact-create",
    });
    providerWritePermit.mockClear();
    providerWrite.mockClear();
    const continuation = executedContact.continuation!;
    const prepared = await service.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse({
      ...continuation.prepare_template,
      continuation_token: continuation.token,
      }),
    ));

    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-strong-contact-drift",
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      retryable: false,
      details: expect.objectContaining({
        failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
        reasonCodes: ["XERO_CONTACT_IDENTITY_COMPANY_NUMBER_CONFLICT"],
        providerMutationPossible: false,
      }),
    });
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("requires the exact active tenant TaxType for No Tax and never falls back to a standard or display-name match", async () => {
    const blocked = runtime({ testTenant: true });
    const blockedCase = await blocked.service.prepare(context(), noTaxSource());
    await expect(blocked.service.execute(context(), {
      case_id: blockedCase.case_id,
      case_version: blockedCase.case_version,
      request_id: "execute-no-tax-without-none",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(blocked.accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(blocked.accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(blocked.providerWritePermit).not.toHaveBeenCalled();
    expect(blocked.providerWrite).not.toHaveBeenCalled();

    const allowed = runtime({ testTenant: true, taxRates: [{
      taxType: "NONE",
      name: "Tenant-renamed label must not be authoritative",
      status: "ACTIVE",
      displayTaxRate: "0.0000",
      effectiveRate: "0.0000",
      canApplyToRevenue: true,
    }] });
    const allowedContext = context();
    const allowedCase = await allowed.service.prepare(allowedContext, noTaxSource());
    const executed = await allowed.service.execute(allowedContext, {
      case_id: allowedCase.case_id,
      case_version: allowedCase.case_version,
      request_id: "execute-no-tax-with-exact-none",
    });
    expect(allowed.accounting.prepareSalesInvoiceDraft).toHaveBeenCalledWith(allowedContext, expect.objectContaining({
      line_amount_type: "NoTax",
      lines: [expect.objectContaining({ tax_type: "NONE" })],
    }), expect.objectContaining({
      lines: [expect.objectContaining({ accountId: "33333333-3333-4333-8333-333333333333" })],
    }));
    expect(executed.completion_claim.ledger_write_claim).toBe("ALL_ELIGIBLE_WRITES_READBACK_VERIFIED");
    expect(allowed.providerWrite).toHaveBeenCalledOnce();
  });

  it("invalidates a prepared Case when the Xero organisation tax or lock policy changes", async () => {
    const { service, provider, accounting, mutations, providerWritePermit, providerWrite } = runtime({ testTenant: true });
    const prepared = await service.prepare(context(), source("VALID_FOR_LIVE_BOOKS"));
    vi.mocked(provider.getOrganisation).mockResolvedValue({
      organisationId: tenantId,
      name: "Case Company",
      countryCode: "SG",
      baseCurrency: "SGD",
      paysTax: false,
      organisationStatus: "ACTIVE",
      periodLockDate: "2026-07-31",
    });
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-stale-organisation-policy",
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({ reasonCodes: ["ORGANISATION_POLICY_SNAPSHOT_STALE"] }),
    });
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it.each([
    ["missing AccountID", (rows: ReturnType<typeof testXeroAccounts>) => rows.slice(1)],
    ["same code on another AccountID", (rows: ReturnType<typeof testXeroAccounts>) => [...rows, {
      ...rows[0]!, accountId: "99999999-9999-4999-8999-999999999999",
    }]],
    ["same AccountID under another code", (rows: ReturnType<typeof testXeroAccounts>) => [{
      ...rows[0]!, code: "CHANGED",
    }, ...rows.slice(1)]],
    ["wrong account type", (rows: ReturnType<typeof testXeroAccounts>) => [{
      ...rows[0]!, type: "EXPENSE",
    }, ...rows.slice(1)]],
    ["wrong account class", (rows: ReturnType<typeof testXeroAccounts>) => [{
      ...rows[0]!, class: "EXPENSE",
    }, ...rows.slice(1)]],
  ] as const)("rejects live COA drift (%s) before preparation, authority preflight, permit, or write", async (
    _label,
    mutate,
  ) => {
    const { service, accounting, mutations, providerWritePermit, providerWrite } = runtime({ testTenant: true });
    const prepared = await service.prepare(context(), source("VALID_FOR_LIVE_BOOKS"));
    vi.mocked(accounting.listAccounts).mockClear();
    vi.mocked(accounting.listAccounts).mockResolvedValue(mutate(testXeroAccounts()));

    // ADR-002: execute-time drift is now proven by re-deriving the whole live
    // declared-ledger binding and comparing its hash against the one sealed
    // at prepare time. Every kind of live drift -- a removed account, an
    // ambiguous code, or a changed type/class -- fails the same hash
    // comparison and reports one uniform reason code rather than a per-cause
    // one; the caller is always told to prepare a fresh Case version.
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: `execute-coa-drift-${_label.toLocaleLowerCase("en").replace(/[^a-z0-9]+/gu, "-")}`,
    })).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
      retryable: false,
      details: expect.objectContaining({
        failureLayer: "XERO_DECLARED_LEDGER_BINDING",
        reasonCodes: ["XERO_DECLARED_LEDGER_BINDING_DRIFT"],
        providerMutationPossible: false,
      }),
    });
    expect(accounting.listAccounts).toHaveBeenCalledOnce();
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  // ADR-002: per-tenant COA profiles are no longer read by the runtime at
  // all -- the tenant's live chart of accounts (re-read every execute) is
  // the sole authority. A restart with a different (now inert) legacy
  // tenantCoaProfiles config must not invalidate an already-prepared Case;
  // this inverts the retired "profile revision drift" rejection into proof
  // that the removed gate stays removed.
  it("does not invalidate a prepared Case when the server restarts with a different (now inert) tenantCoaProfiles config", async () => {
    const harness = runtime({ testTenant: true });
    const prepared = await harness.service.prepare(context(), source("VALID_FOR_LIVE_BOOKS"));
    const restarted = new XeroAccountingCaseService(
      harness.repository,
      harness.provider,
      harness.accounting,
      harness.mutations,
      {
        continuationSecret,
        testTenantIds: [tenantId],
        businessAuthorityProfiles: [testXeroBusinessAuthorityProfile(tenantId)],
        clock: () => new Date("2026-08-13T04:00:00.000Z"),
      },
    );

    await expect(restarted.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-after-restart-inert-coa-profile",
    })).resolves.toMatchObject({ state: "TERMINAL" });
    expect(harness.providerWrite).toHaveBeenCalledOnce();
  });

  it.each([
    ["PLANNED_NEEDS_PREFLIGHT", "PENDING", "PREPARE_NEW_ACCOUNTING_CASE"],
    ["PREFLIGHTED", "PREPARED", "PREPARE_NEW_ACCOUNTING_CASE"],
    ["RECOVERY_REQUIRED", "WRITE_UNCERTAIN", "RESTORE_COMPATIBLE_RELEASE_AND_RECOVER_CASE"],
  ] as const)("keeps legacy %s status readable but requires a typed fail-closed upgrade path before Xero I/O", async (
    state,
    operationState,
    recoveryAction,
  ) => {
    const harness = runtime({ testTenant: true });
    const prepared = await harness.service.prepare(context(), source("VALID_FOR_LIVE_BOOKS"));
    const current = await harness.repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    });
    if (!current) throw new Error("test Accounting Case was not persisted");
    const legacy = structuredClone(current) as AccountingCaseVersionRecord;
    const policyProjection = legacy.compiled.policyProjection as Record<string, unknown>;
    const providerProjection = legacy.compiled.providerProjection as Record<string, unknown>;
    policyProjection.schemaVersion = "xero-sg-accounting-policy-projection:v3";
    providerProjection.schemaVersion = "xero-accounting-case-provider-projection:v2";
    delete providerProjection.tenantCoaProfile;
    delete providerProjection.capabilityBounds;
    legacy.state = state;
    legacy.operations = legacy.operations.map((operation) => ({
      ...operation,
      state: operationState,
      ...(operationState === "PREPARED" ? { preparationId: "xmp_legacy_prepared" } : {}),
      ...(operationState === "WRITE_UNCERTAIN"
        ? { preparationId: "xmp_legacy_uncertain", mutationRequestId: "xmr_legacy_uncertain" }
        : {}),
    }));
    legacy.compiledPlanHash = accountingCasePlanHash(legacy.binding, legacy.compiled);

    const getBound = vi.spyOn(harness.repository, "getBoundAccountingCase")
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce(legacy);
    await expect(harness.service.status(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    })).resolves.toMatchObject({ state });

    vi.mocked(harness.provider.getOrganisation).mockClear();
    vi.mocked(harness.accounting.listAccounts).mockClear();
    await expect(harness.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: `execute-legacy-${state.toLocaleLowerCase("en")}`,
    })).rejects.toMatchObject({
      code: "STALE_PREFLIGHT",
      retryable: false,
      details: expect.objectContaining({
        failureLayer: "ACCOUNTING_CASE_PROJECTION_UPGRADE",
        reasonCodes: ["ACCOUNTING_CASE_PROJECTION_UPGRADE_REQUIRED"],
        recoveryAction,
        providerMutationPossible: false,
        storedPolicyProjectionVersion: "xero-sg-accounting-policy-projection:v3",
        storedProviderProjectionVersion: "xero-accounting-case-provider-projection:v2",
      }),
    });
    expect(getBound).toHaveBeenCalledTimes(2);
    expect(harness.provider.getOrganisation).not.toHaveBeenCalled();
    expect(harness.accounting.listAccounts).not.toHaveBeenCalled();
    expect(harness.mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(harness.accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(harness.accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(harness.providerWritePermit).not.toHaveBeenCalled();
    expect(harness.providerWrite).not.toHaveBeenCalled();
  });

  it.each([
    ["missing EffectiveRate", [{
      taxType: "OUTPUTY24", status: "ACTIVE", displayTaxRate: "9.0000", canApplyToRevenue: true,
    }]],
    ["wrong effective rate", [{
      taxType: "OUTPUTY24", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "8.0000", canApplyToRevenue: true,
    }]],
    ["inactive row", [{
      taxType: "OUTPUTY24", status: "DELETED", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToRevenue: true,
    }]],
    ["duplicate active rows", [{
      taxType: "OUTPUTY24", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToRevenue: true,
    }, {
      taxType: "OUTPUTY24", status: "ACTIVE", displayTaxRate: "9.0000", effectiveRate: "9.0000", canApplyToRevenue: true,
    }]],
  ] as const)("fails closed before preparation, permit or Provider mutation for %s", async (_label, taxRates) => {
    const blocked = runtime({ testTenant: true, taxRates: [...taxRates] });
    const prepared = await blocked.service.prepare(context(), source("TEST_OR_NOT_VALID"));
    await expect(blocked.service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: `execute-tax-policy-${_label.replace(/\s+/g, "-")}`,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(blocked.accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(blocked.accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(blocked.providerWritePermit).not.toHaveBeenCalled();
    expect(blocked.providerWrite).not.toHaveBeenCalled();
  });

  it("derives distinct stable operation request IDs for two same-action operations even with a 128-character Case ID", async () => {
    const caseId = "c".repeat(128);
    const requestIdsByRun: string[][] = [];
    for (let run = 0; run < 2; run += 1) {
      const harness = runtime({ testTenant: true });
      const input = twoInvoiceSource();
      input.case_id = caseId;
      const prepared = await harness.service.prepare(context(), input);
      await harness.service.execute(context(), {
        case_id: prepared.case_id,
        case_version: prepared.case_version,
        request_id: "execute-long-case-id",
      });
      expect(harness.providerWrite).toHaveBeenCalledTimes(2);
      requestIdsByRun.push([...harness.operationRequestIds]);
    }

    expect(requestIdsByRun[0]).toHaveLength(2);
    expect(new Set(requestIdsByRun[0]).size).toBe(2);
    expect(requestIdsByRun[0]).toEqual(requestIdsByRun[1]);
    expect(requestIdsByRun[0]!.every((requestId) => /^caseop:[0-9a-f]{64}$/u.test(requestId))).toBe(true);
  });

  it.each([
    {
      label: "first operation",
      outcomes: ["DEFINITE_FAILURE"] as const,
      expectedCaseState: "TERMINAL",
      expectedOperationStates: [
        "PROVIDER_REJECTED",
        "NOT_EXECUTED_AFTER_PRIOR_FAILURE",
        "NOT_EXECUTED_AFTER_PRIOR_FAILURE",
      ],
      expectedProviderWrites: 1,
    },
    {
      label: "second operation",
      outcomes: ["SUCCESS", "DEFINITE_FAILURE"] as const,
      expectedCaseState: "PARTIALLY_COMMITTED",
      expectedOperationStates: [
        "READBACK_VERIFIED",
        "PROVIDER_REJECTED",
        "NOT_EXECUTED_AFTER_PRIOR_FAILURE",
      ],
      expectedProviderWrites: 2,
    },
  ])("terminalizes a definite failure at the $label, cancels all later operations, and replays with zero provider writes", async ({
    outcomes,
    expectedCaseState,
    expectedOperationStates,
    expectedProviderWrites,
  }) => {
    const { service, providerWrite } = runtime({ testTenant: true, executionOutcomes: outcomes });
    const prepared = await service.prepare(context(), threeInvoiceSource());
    const command = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-three-invoice-failure",
    };

    await expect(service.execute(context(), command)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    const durable = await service.status(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    });
    expect(durable.state).toBe(expectedCaseState);
    expect(durable.operations.map((operation) => operation.state)).toEqual(expectedOperationStates);
    expect(providerWrite).toHaveBeenCalledTimes(expectedProviderWrites);

    await expect(service.execute(context(), {
      ...command,
      request_id: "terminal-replay-must-not-write",
    })).resolves.toMatchObject({ state: expectedCaseState });
    expect(providerWrite).toHaveBeenCalledTimes(expectedProviderWrites);
  });

  it("pauses a Case as READY_TO_RESUME when permission fails before any mutation request exists", async () => {
    const { service, repository, providerWrite, preparedOperationIds } = runtime({
      testTenant: true,
      executionOutcomes: ["PREWRITE_FAILURE"],
    });
    const prepared = await service.prepare(context(), twoInvoiceSource());
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-prewrite-permission-failure",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const durable = await service.status(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    });
    expect(durable.state).toBe("READY_TO_RESUME");
    expect(durable.operations.map((operation) => operation.state)).toEqual(["PREPARED", "PREPARED"]);
    expect(providerWrite).not.toHaveBeenCalled();
    for (const preparationId of preparedOperationIds.keys()) {
      await expect(repository.getXeroMutationRequest(
        xeroMutationRequestIdForPreparation(preparationId),
      )).resolves.toBeUndefined();
    }
  });

  it("recovers a crash after durable contact PREPARED and before any provider mutation", async () => {
    const clock = { value: new Date("2026-08-13T04:00:00.000Z") };
    const { service, repository, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      clock,
      preparationTtlMs: 60_000,
    });
    const oldSource = typedContactOnlySource(
      "case-service-contact-crash-owner",
      "Expired Singapore owner",
      {
        kind: "LEGAL_REGISTRY",
        jurisdiction: "SG",
        registryScheme: "ACRA_UEN",
        number: "202699999Z",
      },
    );
    const prepared = await service.prepare(context(), oldSource);
    vi.spyOn(repository, "claimAccountingCaseExecution").mockRejectedValueOnce(
      new AppError("PROVIDER_UNAVAILABLE", "Synthetic crash after durable contact preflight.", {
        httpStatus: 503,
        retryable: true,
      }),
    );
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-contact-crash-owner",
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();

    const before = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    });
    expect(before).toMatchObject({
      state: "PREFLIGHTED",
      operations: [expect.objectContaining({ state: "PREPARED" })],
    });
    const oldPreparationId = before?.operations[0]?.preparationId;
    expect(oldPreparationId).toBeDefined();
    await expect(repository.getXeroMutationRequest(
      xeroMutationRequestIdForPreparation(oldPreparationId!),
    )).resolves.toBeUndefined();

    clock.value = new Date("2026-08-13T04:02:00.000Z");
    const successorSource = typedContactOnlySource(
      "case-service-contact-crash-successor",
      "Successor United States owner",
      {
        kind: "LEGAL_REGISTRY",
        jurisdiction: "US",
        registryScheme: "IRS",
        number: "202699999Z",
      },
    );
    const successorPrepared = await service.prepare(context(), successorSource);
    expect(successorPrepared).toMatchObject({
      case_id: successorSource.case_id,
      state: "PLANNED_NEEDS_PREFLIGHT",
    });

    await expect(repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    })).resolves.toMatchObject({
      state: "TERMINAL",
      operations: [expect.objectContaining({
        state: "BLOCKED_VALIDATION",
        errorReceipt: expect.objectContaining({
          receiptType: "ACCOUNTING_CASE_NO_WRITE_STARTED",
          disposition: "ABANDONED",
          mutationRequestAbsent: true,
          providerCallAbsentByPermitInvariant: true,
          successorCaseId: successorSource.case_id,
        }),
      })],
    });
    await expect(repository.getXeroMutationPreparation(oldPreparationId!))
      .resolves.toMatchObject({ state: "EXPIRED" });
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("reseals an expired durable PREFLIGHTED Case once while preserving the original receipt", async () => {
    const clock = { value: new Date("2026-08-13T04:00:00.000Z") };
    const { service, repository, accounting, providerWrite } = runtime({
      testTenant: true,
      clock,
      preparationTtlMs: 60_000,
    });
    const prepared = await service.prepare(context(), source());
    vi.spyOn(repository, "claimAccountingCaseExecution").mockRejectedValueOnce(
      new AppError("PROVIDER_UNAVAILABLE", "Synthetic crash after durable preflight.", {
        httpStatus: 503,
        retryable: true,
      }),
    );
    const command = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-expired-prefighted-reseal",
    };
    await expect(service.execute(context(), command)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const before = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: prepared.case_id, version: prepared.case_version,
    });
    const originalReceipt = structuredClone(before?.preflightReceipt);
    const originalReceiptHash = before?.preflightReceiptHash;
    const originalPreparationId = before?.operations[0]?.preparationId;

    clock.value = new Date("2026-08-13T04:02:00.000Z");
    await expect(service.execute(context(), command)).resolves.toMatchObject({ state: "TERMINAL" });
    const after = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: prepared.case_id, version: prepared.case_version,
    });
    expect(after?.preflightReceipt).toEqual(originalReceipt);
    expect(after?.preflightReceiptHash).toBe(originalReceiptHash);
    expect(after?.originalPreflightReceiptHash).toBe(originalReceiptHash);
    expect(after?.preflightResealRevision).toBe(1);
    expect(after?.preflightReseals).toHaveLength(1);
    expect(after?.operations[0]?.originalPreparationId).toBe(originalPreparationId);
    expect(after?.operations[0]?.preparationId).not.toBe(originalPreparationId);
    expect(vi.mocked(accounting.prepareSalesInvoiceDraft)).toHaveBeenCalledTimes(2);
    expect(providerWrite).toHaveBeenCalledTimes(1);
  });

  it("reseals all zero-request READY_TO_RESUME preparations and executes them", async () => {
    const clock = { value: new Date("2026-08-13T04:00:00.000Z") };
    const { service, repository, accounting, providerWrite } = runtime({
      testTenant: true,
      clock,
      preparationTtlMs: 60_000,
      executionOutcomes: ["PREWRITE_FAILURE"],
    });
    const prepared = await service.prepare(context(), twoInvoiceSource());
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-ready-to-reseal-first",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    clock.value = new Date("2026-08-13T04:02:00.000Z");
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-ready-to-reseal-second",
    })).resolves.toMatchObject({ state: "TERMINAL" });
    const durable = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: prepared.case_id, version: prepared.case_version,
    });
    expect(durable?.preflightResealRevision).toBe(1);
    expect(durable?.preflightReseals?.[0]?.receipt.operations).toHaveLength(2);
    expect(vi.mocked(accounting.prepareSalesInvoiceDraft)).toHaveBeenCalledTimes(4);
    expect(providerWrite).toHaveBeenCalledTimes(2);
  });

  it("reseals only the residual PREPARED operation after earlier readback verification", async () => {
    const clock = { value: new Date("2026-08-13T04:00:00.000Z") };
    const { service, repository, accounting, providerWrite } = runtime({
      testTenant: true,
      clock,
      preparationTtlMs: 60_000,
      executionOutcomes: ["SUCCESS", "PREWRITE_FAILURE"],
    });
    const prepared = await service.prepare(context(), twoInvoiceSource());
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-partial-reseal-first",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const before = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: prepared.case_id, version: prepared.case_version,
    });
    expect(before?.operations.map((operation) => operation.state)).toEqual(["READBACK_VERIFIED", "PREPARED"]);
    const firstPreparationId = before?.operations[0]?.preparationId;
    const secondOldPreparationId = before?.operations[1]?.preparationId;

    clock.value = new Date("2026-08-13T04:02:00.000Z");
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-partial-reseal-second",
    })).resolves.toMatchObject({ state: "TERMINAL" });
    const after = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: prepared.case_id, version: prepared.case_version,
    });
    expect(after?.preflightReseals?.[0]?.receipt.operations).toHaveLength(1);
    expect(after?.operations[0]?.preparationId).toBe(firstPreparationId);
    expect(after?.operations[1]?.preparationId).not.toBe(secondOldPreparationId);
    expect(vi.mocked(accounting.prepareSalesInvoiceDraft)).toHaveBeenCalledTimes(3);
    expect(providerWrite).toHaveBeenCalledTimes(2);
  });

  it("pauses an expiry race as READY_TO_RESUME, then reseals the TTL-expired zero-request preparation", async () => {
    const clock = { value: new Date("2026-08-13T04:00:00.000Z") };
    const { service, repository, providerWrite } = runtime({
      testTenant: true,
      clock,
      preparationTtlMs: 60_000,
      executionOutcomes: ["APPROVAL_EXPIRED"],
    });
    const prepared = await service.prepare(context(), source());
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-expiry-race",
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    await expect(service.status(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    })).resolves.toMatchObject({
      state: "READY_TO_RESUME",
      last_execution_error: { code: "STALE_PREFLIGHT" },
    });
    expect(providerWrite).not.toHaveBeenCalled();
    const paused = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: prepared.case_id, version: prepared.case_version,
    });
    const expiredPreparationId = paused?.operations[0]?.preparationId;
    expect(expiredPreparationId).toBeDefined();
    await expect(repository.getXeroMutationPreparation(expiredPreparationId!)).resolves.toMatchObject({
      state: "EXPIRED",
    });
    await expect(repository.getXeroMutationRequest(
      xeroMutationRequestIdForPreparation(expiredPreparationId!),
    )).resolves.toBeUndefined();

    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-expiry-race-reseal",
    })).resolves.toMatchObject({ state: "TERMINAL" });
    const completed = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: prepared.case_id, version: prepared.case_version,
    });
    expect(completed?.preflightResealRevision).toBe(1);
    expect(completed?.operations[0]?.originalPreparationId).toBe(expiredPreparationId);
    expect(completed?.operations[0]?.preparationId).not.toBe(expiredPreparationId);
    expect(providerWrite).toHaveBeenCalledOnce();
  });

  it("keeps a recovery invocation readback-only and never falls through to the next prepared create", async () => {
    const { service, accounting, providerWrite, preparedOperationIds } = runtime({
      testTenant: true,
      executionOutcomes: ["WRITE_UNCERTAIN"],
    });
    const prepared = await service.prepare(context(), twoInvoiceSource());
    const command = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-readback-recovery-only",
    };
    await expect(service.execute(context(), command)).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    await expect(service.status(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    })).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      operations: [{ state: "WRITE_UNCERTAIN" }, { state: "PREPARED" }],
    });
    expect(providerWrite).toHaveBeenCalledTimes(1);

    const recovered = await service.execute(context(), command);
    expect(recovered).toMatchObject({
      state: "READY_TO_RESUME",
      operations: [{ state: "READBACK_VERIFIED" }, { state: "PREPARED" }],
    });
    expect(providerWrite).toHaveBeenCalledTimes(1);
    const firstPreparationId = [...preparedOperationIds.entries()]
      .find(([, ordinal]) => ordinal === 0)?.[0];
    expect(firstPreparationId).toBeDefined();
    expect(vi.mocked(accounting.executePreparedSalesInvoiceDraft).mock.calls.map((call) =>
      call[1].preparation_id)).toEqual([firstPreparationId, firstPreparationId]);
  });

  it("routes renewed same-organisation read-only recovery through MCP with one exact GET and zero create or permit", async () => {
    const {
      service,
      repository,
      accounting,
      mutations,
      providerWrite,
      providerWritePermit,
      exactProviderGet,
    } = runtime({ testTenant: true, executionOutcomes: ["WRITE_UNCERTAIN"] });
    const prepared = await service.prepare(context(), twoInvoiceSource());
    const command = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-renewed-read-only-recovery",
    };
    await expect(service.execute(context(), command)).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });

    const recoveryContext = context({
      scopes: ["xero.read"],
      targetSessionId: "case-target-session-renewed",
      targetSessionHash: "b".repeat(64),
    });
    await repository.saveLedgerTargetSession({
      sessionId: recoveryContext.targetSessionId!,
      sessionHash: recoveryContext.targetSessionHash!,
      installationId: "case-installation",
      bindingId: "case-binding",
      connectionId: "case-connection",
      bindingRevision: 1,
      createdAt: liveTargetCreatedAt,
      expiresAt: recoveryContext.targetSessionExpiresAt!,
    });
    providerWrite.mockClear();
    providerWritePermit.mockClear();
    exactProviderGet.mockClear();
    vi.mocked(mutations.preflightAutonomousActions).mockClear();

    const server = createAccountingMcpServer(
      accounting,
      recoveryContext,
      undefined,
      undefined,
      service,
    );
    const client = new Client({ name: "case-read-only-recovery", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport as unknown as Transport);
      await client.connect(clientTransport);
      const recovered = await client.callTool({
        name: "xero_execute_accounting_case",
        arguments: command,
      });
      expect(recovered.isError).not.toBe(true);
      expect(recovered.structuredContent).toMatchObject({
        result: {
          state: "READY_TO_RESUME",
          operations: [{ state: "READBACK_VERIFIED" }, { state: "PREPARED" }],
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }

    expect(exactProviderGet).toHaveBeenCalledOnce();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
  });

  it("adopts an expired-target crash, GET-recovers only the claimed write, and continues residual intent under a new Case", async () => {
    const clock = { value: new Date() };
    const {
      service,
      repository,
      providerWrite,
      providerWritePermit,
      exactProviderGet,
    } = runtime({ testTenant: true, clock, executionOutcomes: ["WRITE_UNCERTAIN"] });
    const prepared = await service.prepare(context(), twoInvoiceSource());
    const command = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-expired-target-crash-recovery",
    };
    const simulatedProcessDeath = vi.spyOn(repository, "projectAccountingCaseOperationFromMutation")
      .mockRejectedValue(new Error("SIMULATED_PROCESS_DEATH_BEFORE_CASE_PROJECTION"));
    await expect(service.execute(context(), command)).rejects.toThrow();
    simulatedProcessDeath.mockRestore();

    const crashed = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    });
    expect(crashed).toMatchObject({
      state: "EXECUTING",
      executionRequestId: command.request_id,
      operations: [
        expect.objectContaining({ state: "PREPARED" }),
        expect.objectContaining({ state: "PREPARED" }),
      ],
    });
    const preparedWithMutations = await Promise.all((crashed?.operations ?? []).map(async (candidate) => ({
      candidate,
      request: candidate.preparationId
        ? await repository.getXeroMutationRequest(xeroMutationRequestIdForPreparation(candidate.preparationId))
        : undefined,
    })));
    const claimed = preparedWithMutations.find((entry) => entry.request?.state === "WRITE_UNCERTAIN");
    const residual = preparedWithMutations.find((entry) => entry.candidate.operation.operationId !==
      claimed?.candidate.operation.operationId);
    expect(claimed?.candidate.preparationId).toBeDefined();
    expect(residual?.candidate.preparationId).toBeDefined();
    const residualEvent = crashed?.compiled.events.find((event) =>
      event.eventId === residual?.candidate.operation.eventId);
    const residualFact = crashed?.compiled.activeFacts.find((fact) =>
      fact.factId === residualEvent?.primaryFactId);
    if (!residualFact || residualFact.kind !== "NATIVE_DOCUMENT") {
      throw new Error("test residual native-document mapping is missing");
    }
    const residualPreparationId = residual.candidate.preparationId!;

    clock.value = new Date(liveTargetExpiresAt.getTime() + 1);
    const renewedExpiry = new Date(clock.value.getTime() + 30 * 60_000);
    const recoveryContext = Object.freeze({
      ...context({
        scopes: ["xero.read"],
        targetSessionId: "case-target-session-after-crash",
        targetSessionHash: "c".repeat(64),
      }),
      targetSessionExpiresAt: renewedExpiry,
    });
    await repository.saveLedgerTargetSession({
      sessionId: recoveryContext.targetSessionId!,
      sessionHash: recoveryContext.targetSessionHash!,
      installationId: "case-installation",
      bindingId: "case-binding",
      connectionId: "case-connection",
      bindingRevision: 1,
      createdAt: clock.value,
      expiresAt: renewedExpiry,
    });
    providerWrite.mockClear();
    providerWritePermit.mockClear();
    exactProviderGet.mockClear();

    const recovered = await service.execute(recoveryContext, command);
    expect(recovered).toMatchObject({
      state: "TERMINAL",
      operations: expect.arrayContaining([
        expect.objectContaining({ state: "READBACK_VERIFIED" }),
        expect.objectContaining({
          state: "NOT_EXECUTED_AFTER_TARGET_EXPIRY",
          failure: expect.objectContaining({
            reason_codes: ["EXPIRED_TARGET_RECOVERY_CONTINUED_TO_SUCCESSOR"],
          }),
        }),
      ]),
      continuation: {
        action: "PREPARE_RECOVERY_SUCCESSOR_CASE",
        next_expected_version: 0,
        token: expect.stringMatching(/^acr_[0-9a-f]{64}$/u),
        prepare_template: {
          case_id: expect.stringMatching(/^recovery-[0-9a-f]{64}$/u),
          expected_version: 0,
          source_set_complete: true,
          documents: [expect.objectContaining({ reference: residualFact.reference })],
        },
      },
    });
    expect(exactProviderGet).toHaveBeenCalledOnce();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();

    await expect(repository.getXeroMutationPreparation(residualPreparationId!))
      .resolves.toMatchObject({ state: "EXPIRED" });
    const continuation = recovered.continuation!;
    const successorContext = Object.freeze({
      ...context({
        targetSessionId: recoveryContext.targetSessionId,
        targetSessionHash: recoveryContext.targetSessionHash,
      }),
      targetSessionExpiresAt: renewedExpiry,
    });
    const successor = await service.prepare(successorContext, normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse({
        ...continuation.prepare_template,
        continuation_token: continuation.token,
      }),
    ));
    expect(successor).toMatchObject({
      case_id: continuation.prepare_template.case_id,
      case_version: 1,
      persistence_mode: "CREATED",
      operations: [{ action_id: "customer_invoice.create_draft", state: "PENDING" }],
    });
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();

    const successorBinding: AccountingCaseBinding = {
      ...durableCaseBinding(),
      targetSessionId: recoveryContext.targetSessionId!,
      targetSessionHash: recoveryContext.targetSessionHash!,
      targetSessionExpiresAt: renewedExpiry,
    };
    const successorRecord = await repository.getBoundAccountingCase({
      binding: successorBinding,
      caseId: successor.case_id,
      version: successor.case_version,
    });
    expect(successorRecord?.operations[0]?.preparationId).toBeUndefined();

    const executedSuccessor = await service.execute(successorContext, {
      case_id: successor.case_id,
      case_version: successor.case_version,
      request_id: "execute-expired-target-residual-successor",
    });
    expect(executedSuccessor).toMatchObject({
      state: "TERMINAL",
      operations: [{ action_id: "customer_invoice.create_draft", state: "READBACK_VERIFIED" }],
    });
    expect(providerWritePermit).toHaveBeenCalledOnce();
    expect(providerWrite).toHaveBeenCalledOnce();
    const completedSuccessor = await repository.getBoundAccountingCase({
      binding: successorBinding,
      caseId: successor.case_id,
      version: successor.case_version,
    });
    expect(completedSuccessor?.operations[0]?.originalPreparationId).toBeDefined();
    expect(completedSuccessor?.operations[0]?.originalPreparationId).not.toBe(residualPreparationId);
  });

  it("continues exactly the residual contact and dependent document after the hash-ordered claimed contact is GET-recovered", async () => {
    const clock = { value: new Date() };
    const {
      service,
      repository,
      accounting,
      providerWrite,
      providerWritePermit,
      exactProviderGet,
    } = runtime({
      testTenant: true,
      initialContacts: [],
      clock,
      executionOutcomes: ["WRITE_UNCERTAIN"],
    });
    const source = normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse(twoContactDependentBusinessIntake()),
    );
    const prepared = await service.prepare(context(), source);
    expect(prepared.operations).toEqual([
      expect.objectContaining({ action_id: "contact.create_basic", state: "PENDING" }),
      expect.objectContaining({ action_id: "contact.create_basic", state: "PENDING" }),
    ]);
    const command = {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-two-contact-expired-recovery",
    };
    const simulatedProcessDeath = vi.spyOn(repository, "projectAccountingCaseOperationFromMutation")
      .mockRejectedValue(new Error("SIMULATED_PROCESS_DEATH_BEFORE_CONTACT_CASE_PROJECTION"));
    await expect(service.execute(context(), command)).rejects.toThrow();
    simulatedProcessDeath.mockRestore();

    const crashed = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    });
    expect(crashed?.operations.map((operation) => operation.state)).toEqual(["PREPARED", "PREPARED"]);
    if (!crashed) throw new Error("crashed Case missing");
    const operationMutationRequests = await Promise.all(crashed.operations.map(async (operation) => ({
      operation,
      request: operation.preparationId
        ? await repository.getXeroMutationRequest(xeroMutationRequestIdForPreparation(operation.preparationId))
        : undefined,
    })));
    const recoveredPair = operationMutationRequests.find(({ request }) => request?.state === "WRITE_UNCERTAIN");
    const residualPair = operationMutationRequests.find(({ request }) => request === undefined);
    if (!recoveredPair || !residualPair) throw new Error("exact recovered/residual operation mapping missing");
    const contactForOperation = (operationId: string) => {
      const operation = crashed.operations.find((candidate) => candidate.operation.operationId === operationId)?.operation;
      const event = crashed.compiled.events.find((candidate) => candidate.eventId === operation?.eventId);
      const fact = crashed.compiled.activeFacts.find((candidate) => candidate.factId === event?.primaryFactId);
      if (!fact || fact.kind !== "CONTACT_CANDIDATE") throw new Error("contact operation primary fact missing");
      return fact;
    };
    const recoveredContact = contactForOperation(recoveredPair.operation.operation.operationId);
    const residualContact = contactForOperation(residualPair.operation.operation.operationId);
    const dependentDocument = crashed.compiled.activeFacts.find((fact) =>
      fact.kind === "NATIVE_DOCUMENT" &&
      fact.contactDurableIdentity !== undefined && residualContact.durableIdentity !== undefined &&
      hashObject(fact.contactDurableIdentity) === hashObject(residualContact.durableIdentity));
    if (!dependentDocument || dependentDocument.kind !== "NATIVE_DOCUMENT") {
      throw new Error("residual dependent document missing");
    }
    const residualPreparationId = residualPair.operation.preparationId;
    expect(residualPreparationId).toBeDefined();

    clock.value = new Date(liveTargetExpiresAt.getTime() + 1);
    const renewedExpiry = new Date(clock.value.getTime() + 30 * 60_000);
    const recoveryContext = Object.freeze({
      ...context({
        scopes: ["xero.read"],
        targetSessionId: "case-target-session-two-contact-recovery",
        targetSessionHash: "d".repeat(64),
      }),
      targetSessionExpiresAt: renewedExpiry,
    });
    await repository.saveLedgerTargetSession({
      sessionId: recoveryContext.targetSessionId!,
      sessionHash: recoveryContext.targetSessionHash!,
      installationId: "case-installation",
      bindingId: "case-binding",
      connectionId: "case-connection",
      bindingRevision: 1,
      createdAt: clock.value,
      expiresAt: renewedExpiry,
    });
    providerWrite.mockClear();
    providerWritePermit.mockClear();
    exactProviderGet.mockClear();

    const recovered = await service.execute(recoveryContext, command);
    expect(recovered).toMatchObject({
      state: "TERMINAL",
      operations: [
        expect.objectContaining({ state: "READBACK_VERIFIED" }),
        expect.objectContaining({ state: "NOT_EXECUTED_AFTER_TARGET_EXPIRY" }),
      ],
      continuation: {
        action: "PREPARE_RECOVERY_SUCCESSOR_CASE",
        token: expect.stringMatching(/^acr_[0-9a-f]{64}$/u),
        prepare_template: {
          expected_version: 0,
          documents: [expect.objectContaining({
            reference: dependentDocument.reference,
          })],
          new_contacts: [expect.objectContaining({
            contact: expect.objectContaining({ name: residualContact.name }),
          })],
        },
      },
    });
    const recoveryTemplateJson = JSON.stringify(recovered.continuation?.prepare_template);
    expect(recoveryTemplateJson).not.toContain(`"name":"${recoveredContact.name}"`);
    expect(recoveredContact.name).not.toBe(residualContact.name);
    expect(exactProviderGet).toHaveBeenCalledOnce();
    expect(providerWrite).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();

    const exactStatus = await service.status(recoveryContext, {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    });
    expect(exactStatus.continuation).toEqual(recovered.continuation);

    const otherExpiry = new Date(clock.value.getTime() + 20 * 60_000);
    const otherContext = Object.freeze({
      ...context({
        targetSessionId: "case-target-session-other-live",
        targetSessionHash: "e".repeat(64),
      }),
      targetSessionExpiresAt: otherExpiry,
    });
    await repository.saveLedgerTargetSession({
      sessionId: otherContext.targetSessionId!,
      sessionHash: otherContext.targetSessionHash!,
      installationId: "case-installation",
      bindingId: "case-binding",
      connectionId: "case-connection",
      bindingRevision: 1,
      createdAt: clock.value,
      expiresAt: otherExpiry,
    });
    const otherStatus = await service.status(otherContext, {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    });
    expect(otherStatus.continuation).toBeUndefined();

    const continuation = recovered.continuation!;
    const successorInput = normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse({
        ...continuation.prepare_template,
        continuation_token: continuation.token,
      }),
    );
    await expect(service.prepare(otherContext, successorInput)).rejects.toMatchObject({ code: "CONFLICT" });
    const successorContext = Object.freeze({
      ...context({
        targetSessionId: recoveryContext.targetSessionId,
        targetSessionHash: recoveryContext.targetSessionHash,
      }),
      targetSessionExpiresAt: renewedExpiry,
    });
    const successor = await service.prepare(successorContext, successorInput);
    expect(successor).toMatchObject({
      persistence_mode: "CREATED",
      operations: [{ action_id: "contact.create_basic", state: "PENDING" }],
    });
    await expect(service.prepare(successorContext, successorInput)).resolves.toMatchObject({
      persistence_mode: "IDEMPOTENT_REPLAY",
      case_id: successor.case_id,
      case_version: 1,
    });
    const successorBinding: AccountingCaseBinding = {
      ...durableCaseBinding(),
      targetSessionId: recoveryContext.targetSessionId!,
      targetSessionHash: recoveryContext.targetSessionHash!,
      targetSessionExpiresAt: renewedExpiry,
    };
    const successorRecord = await repository.getBoundAccountingCase({
      binding: successorBinding,
      caseId: successor.case_id,
      version: 1,
    });
    expect(successorRecord?.compiled.activeFacts.filter((fact) => fact.kind === "CONTACT_CANDIDATE"))
      .toEqual([expect.objectContaining({ name: residualContact.name })]);

    providerWrite.mockClear();
    providerWritePermit.mockClear();
    const executed = await service.execute(successorContext, {
      case_id: successor.case_id,
      case_version: 1,
      request_id: "execute-second-contact-successor",
    });
    expect(executed).toMatchObject({
      state: "AWAITING_CONTINUATION",
      operations: [{ action_id: "contact.create_basic", state: "READBACK_VERIFIED" }],
    });
    expect(accounting.createContact).toHaveBeenCalledTimes(3);
    expect(providerWrite).toHaveBeenCalledOnce();
    expect(providerWritePermit).toHaveBeenCalledOnce();
    const successorCompleted = await repository.getBoundAccountingCase({
      binding: successorBinding,
      caseId: successor.case_id,
      version: 1,
    });
    expect(successorCompleted?.operations[0]?.originalPreparationId).toBeDefined();
    expect(successorCompleted?.operations[0]?.originalPreparationId).not.toBe(residualPreparationId);
  });

  it("rejects an 80-to-800 source mismatch before authority preflight or provider calls", async () => {
    const { service, accounting, mutations } = runtime({ testTenant: true });
    const prepared = await service.prepare(context(), source("VALID_FOR_LIVE_BOOKS", "800.00"));
    expect(prepared.state).toBe("BLOCKED_VALIDATION");
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-invalid-amount",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
  });

  it("rejects a self-consistent mapper amount mutation before the Case claim or provider write", async () => {
    const { service, repository, providerWrite, accounting } = runtime({
      testTenant: true,
      preparationPayloadMutator: (payload) => {
        const mutated = structuredClone(payload);
        const lines = mutated.lines as Array<Record<string, unknown>>;
        lines[0]!.unit_amount = 800;
        return mutated;
      },
    });
    const recordPreflight = vi.spyOn(repository, "recordAccountingCasePreflight");
    const claimCase = vi.spyOn(repository, "claimAccountingCaseExecution");
    const prepared = await service.prepare(context(), source("VALID_FOR_LIVE_BOOKS", "80.00", "80", "7.20", "87.20"));

    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-mutated-preparation",
    })).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
    expect(recordPreflight).not.toHaveBeenCalled();
    expect(claimCase).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
  });

  it("rejects a FORMAL sales-invoice preparation whose sealed provider field was replaced with REFERENCE", async () => {
    const { service, repository, accounting, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      businessAuthorityProfiles: [],
      preparationPayloadMutator: (payload) => ({
        ...payload,
        authoritative_provider_field: "REFERENCE",
      }),
    });
    const recordPreflight = vi.spyOn(repository, "recordAccountingCasePreflight");
    const claimCase = vi.spyOn(repository, "claimAccountingCaseExecution");
    const prepared = await service.prepare(context(), source());

    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-sales-invoice-wrong-provider-field",
    })).rejects.toMatchObject({
      code: "PERSISTENCE_FAILURE",
      details: expect.objectContaining({
        reasonCodes: ["ACCOUNTING_CASE_PREPARATION_PAYLOAD_MISMATCH"],
        mismatchFields: ["canonicalPayload.semanticProjection"],
      }),
    });
    expect(accounting.prepareSalesInvoiceDraft).toHaveBeenCalledOnce();
    expect(recordPreflight).not.toHaveBeenCalled();
    expect(claimCase).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
  });

  it("rejects a FORMAL customer-credit preparation whose sealed provider field was replaced with REFERENCE", async () => {
    const original = historicalOriginal("CUSTOMER");
    const history = { invoices: [original], creditNotes: [] };
    const { service, repository, accounting, providerWrite, providerWritePermit } = runtime({
      businessAuthorityProfiles: [],
      initialContacts: [{
        contactId: original.contact.contactId,
        name: original.contact.name!,
        status: "ACTIVE",
        isCustomer: true,
      }],
      providerHistorySequence: [history, history, history, history, history],
      taxRates: [{
        taxType: "OUTPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToRevenue: true,
      }],
      preparationPayloadMutator: (payload) => ({
        ...payload,
        authoritativeProviderField: "REFERENCE",
      }),
    });
    const recordPreflight = vi.spyOn(repository, "recordAccountingCasePreflight");
    const claimCase = vi.spyOn(repository, "claimAccountingCaseExecution");
    const prepared = await service.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse(historicalCreditBusinessIntake("CUSTOMER")),
    ));

    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-customer-credit-wrong-provider-field",
    })).rejects.toMatchObject({
      code: "PERSISTENCE_FAILURE",
      details: expect.objectContaining({
        reasonCodes: ["ACCOUNTING_CASE_PREPARATION_PAYLOAD_MISMATCH"],
        mismatchFields: ["canonicalPayload.semanticProjection"],
      }),
    });
    expect(accounting.prepareCreditNoteDraft).toHaveBeenCalledOnce();
    expect(recordPreflight).not.toHaveBeenCalled();
    expect(claimCase).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
    expect(accounting.createCreditNoteDraft).not.toHaveBeenCalled();
  });

  it("prepares every operation before the Case claim, so a later deterministic failure leaves provider writes at zero", async () => {
    const { service, accounting, persistPreparedSalesInvoiceDraft } = runtime({ testTenant: true });
    const operationSourceHashes: string[] = [];
    vi.mocked(accounting.prepareSalesInvoiceDraft).mockImplementation(async (requestContext, input, serverCoaConstraints) => {
      if (input.source_sha256) operationSourceHashes.push(input.source_sha256);
      if (operationSourceHashes.length === 2) {
        throw new AppError("CONFLICT", "A duplicate invoice appeared during whole-Case preflight.", {
          httpStatus: 409,
        });
      }
      return persistPreparedSalesInvoiceDraft(requestContext, input, serverCoaConstraints) as never;
    });
    const prepared = await service.prepare(context(), twoInvoiceSource());
    await expect(service.execute(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
      request_id: "execute-two-invoices",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(operationSourceHashes).toHaveLength(2);
    expect(new Set(operationSourceHashes).size).toBe(2);
    const durable = await service.status(context(), {
      case_id: prepared.case_id,
      case_version: prepared.case_version,
    });
    expect(durable.state).toBe("PLANNED_NEEDS_PREFLIGHT");
    expect(durable.operations.every((operation) => operation.state === "PENDING")).toBe(true);
  });

  it("plans a new contact separately from dependent documents instead of pretending the two Xero writes are atomic", async () => {
    const { service, accounting } = runtime({ testTenant: true });
    vi.mocked(accounting.searchContacts).mockResolvedValue({
      contacts: [],
      pagination: { page: 1, pageSize: 100, returned: 0, hasNextPage: false, hasNextPageIsEstimated: false, omittedInvalid: 0 },
    });
    const prepared = await service.prepare(context(), contactDependentSource());
    expect(prepared.operations).toEqual([
      expect.objectContaining({ action_id: "contact.create_basic", state: "PENDING" }),
    ]);
    expect(prepared.events.find((event) => event.event_key === "sales-invoice-event")).toMatchObject({
      disposition: "REVIEW_REQUIRED",
      reason_codes: ["PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION"],
    });
    expect(prepared.residual_event_count).toBe(1);
    expect(accounting.prepareContactCreate).not.toHaveBeenCalled();
    expect(accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
  });

  it("resolves every Golden14 document while keeping bare contact candidates out of durable bindings", async () => {
    const publicGolden = prepareAccountingCasePublicSchema.parse(JSON.parse(readFileSync(
      fileURLToPath(new URL("../harness/fixtures/xero/golden-14-public-case.v1.json", import.meta.url)),
      "utf8",
    )));
    const initialContacts = [
      {
        contactId: "22222222-2222-4222-8222-222222222222",
        name: "Lion City Digital Pte. Ltd.",
        email: "ap@lioncitydigital.example",
        companyNumber: "202612345K",
        accountNumber: "CUST-001",
        status: "ACTIVE" as const,
      },
      // Xero's IsCustomer/IsSupplier flags are transactional observations, not
      // role authorisation. An opposite/neutral flag must not split one legal
      // counterparty into guessed duplicate contacts.
      {
        contactId: "33333333-3333-4333-8333-333333333333",
        name: "OfficeHub Singapore Pte. Ltd.",
        email: "billing@officehub.example",
        companyNumber: "201955555H",
        accountNumber: "SUP-001",
        status: "ACTIVE" as const,
        isCustomer: true,
      },
      {
        contactId: "44444444-4444-4444-8444-444444444444",
        name: "CloudHost Inc.",
        email: "support@cloudhost.example",
        status: "ACTIVE" as const,
      },
    ];
    const { service, repository } = runtime({
      testTenant: true,
      initialContacts,
      providerHistorySequence: [goldenOriginalHistory(), goldenOriginalHistory()],
      taxRates: [{
        taxType: "OUTPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToRevenue: true,
      }, {
        taxType: "INPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToExpenses: true,
      }, {
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }],
    });
    const prepared = await service.prepare(context(), publicGolden);

    expect(prepared.operations).toHaveLength(5);
    expect(prepared.operations.every((operation) => operation.action_id !== "contact.create_basic")).toBe(true);
    const durable = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    });
    const resolvedFacts = durable?.compiled.activeFacts.filter((fact) =>
      fact.kind === "CONTACT_CANDIDATE" || fact.kind === "NATIVE_DOCUMENT");
    expect(resolvedFacts).toHaveLength(8);
    expect(JSON.stringify(resolvedFacts)).not.toContain("xeroContact");
    const contactBindings = durable?.compiled.providerProjection.contactBindings as
      | Record<string, { contactId?: unknown; identity?: { policy?: unknown } }>
      | undefined;
    expect(Object.keys(contactBindings ?? {})).toHaveLength(5);
    expect(Object.values(contactBindings ?? {}).every((binding) =>
      typeof binding.contactId === "string" && binding.identity?.policy === "CANDIDATE_COLLISION_ONLY")).toBe(true);
    expect(durable?.compiled.operations.every((operation) =>
      typeof operation.canonicalPayload.xeroContactId === "string")).toBe(true);
    expect(prepared.source_revision_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.compiled_plan_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("indexes all ACTIVE/ARCHIVED/GDPRREQUEST lifecycle pages once for a multi-document Golden14 prepare", async () => {
    const publicGolden = prepareAccountingCasePublicSchema.parse(JSON.parse(readFileSync(
      fileURLToPath(new URL("../harness/fixtures/xero/golden-14-public-case.v1.json", import.meta.url)),
      "utf8",
    )));
    const required = [
      { contactId: "22222222-2222-4222-8222-222222222222", name: "Lion City Digital Pte. Ltd.", email: "ap@lioncitydigital.example", companyNumber: "202612345K", accountNumber: "CUST-001", status: "ACTIVE" as const },
      { contactId: "33333333-3333-4333-8333-333333333333", name: "OfficeHub Singapore Pte. Ltd.", email: "billing@officehub.example", companyNumber: "201955555H", accountNumber: "SUP-001", status: "ACTIVE" as const },
      { contactId: "44444444-4444-4444-8444-444444444444", name: "CloudHost Inc.", email: "support@cloudhost.example", status: "ACTIVE" as const },
    ];
    const noise = Array.from({ length: 98 }, (_, index) => ({
      contactId: `${(index + 10).toString().padStart(8, "0")}-0000-4000-8000-${(index + 10).toString().padStart(12, "0")}`,
      name: `Unrelated Contact ${index}`,
      email: `unrelated-${index}@example.test`,
      status: "ACTIVE" as const,
    }));
    const { service, accounting } = runtime({
      testTenant: true,
      initialContacts: [...required, ...noise],
      providerHistorySequence: [goldenOriginalHistory(), goldenOriginalHistory()],
      taxRates: [{
        taxType: "OUTPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToRevenue: true,
      }, {
        taxType: "INPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToExpenses: true,
      }, {
        taxType: "NONE",
        status: "ACTIVE",
        displayTaxRate: "0.0000",
        effectiveRate: "0.0000",
        canApplyToExpenses: true,
      }],
    });
    const prepared = await service.prepare(context(), publicGolden);
    expect(prepared.operations).toHaveLength(5);
    expect(accounting.listContacts).toHaveBeenCalledTimes(4);
    expect(accounting.searchContacts).toHaveBeenCalledTimes(3);
    expect(accounting.getContact).toHaveBeenCalledTimes(3);
  });

  it("rejects two contact facts that claim the same durable identity regardless of order", async () => {
    const base = contactDependentSource();
    const complement = {
      ...structuredClone(base.facts[0]!),
      factId: "contact-company-v1",
      lineageKey: "contact-company",
      eventKey: "contact-company-event",
      companyNumber: "202699999Z",
      email: undefined,
    };
    const input = {
      ...base,
      sources: [{
        ...base.sources[0]!,
        units: [
          ...base.sources[0]!.units,
          { unitId: "contact-company-page", expectedFactKinds: ["CONTACT_CANDIDATE" as const] },
        ],
      }, ...base.sources.slice(1)],
      facts: [
        ...base.facts,
        { ...complement, sourceUnitIds: ["contact-company-page"] },
      ],
    };
    for (const facts of [input.facts, [...input.facts].reverse()]) {
      await expect(runtime({ testTenant: true, initialContacts: [] }).service.prepare(context(), {
        ...input,
        facts,
      })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({ reasonCodes: ["PLANNED_BUSINESS_DUPLICATE"] }),
      });
    }
  });

  it.each([
    ["email conflict", { email: "wrong@lioncitydigital.example" }, "XERO_CONTACT_IDENTITY_EMAIL_CONFLICT"],
    ["company conflict", { companyNumber: "WRONG-COMPANY" }, "XERO_CONTACT_IDENTITY_COMPANY_NUMBER_CONFLICT"],
    ["account conflict", { accountNumber: "WRONG-ACCOUNT" }, "XERO_CONTACT_IDENTITY_ACCOUNT_NUMBER_CONFLICT"],
    ["missing email evidence", { email: undefined }, "XERO_CONTACT_IDENTITY_EMAIL_MISSING"],
  ])("fails closed on Golden14 same-name %s before any preflight, permit, or write", async (_label, override, reason) => {
    const publicGolden = prepareAccountingCasePublicSchema.parse(JSON.parse(readFileSync(
      fileURLToPath(new URL("../harness/fixtures/xero/golden-14-public-case.v1.json", import.meta.url)),
      "utf8",
    )));
    const lion = {
      contactId: "22222222-2222-4222-8222-222222222222",
      name: "Lion City Digital Pte. Ltd.",
      email: "ap@lioncitydigital.example" as string | undefined,
      companyNumber: "202612345K",
      accountNumber: "CUST-001",
      status: "ACTIVE" as const,
      ...override,
    };
    const { service, accounting, mutations, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [lion],
    });

    await expect(service.prepare(context(), publicGolden)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reasonCodes: expect.arrayContaining([reason]) },
    });
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareContactCreate).not.toHaveBeenCalled();
    expect(accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("records CANDIDATE_COLLISION_ONLY when no typed durable identity was supplied", async () => {
    const { service, repository } = runtime({ testTenant: true });
    const prepared = await service.prepare(context(), source());
    const durable = await repository.getBoundAccountingCase({
      binding: durableCaseBinding(),
      caseId: prepared.case_id,
      version: prepared.case_version,
    });
    const document = durable?.compiled.activeFacts.find((fact) => fact.kind === "NATIVE_DOCUMENT");
    const contactBindings = durable?.compiled.providerProjection.contactBindings as
      | Record<string, { identity?: unknown }>
      | undefined;
    expect(document && contactBindings?.[document.factId]?.identity).toMatchObject({
      policy: "CANDIDATE_COLLISION_ONLY",
      contactId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("blocks a renamed tenant contact that already owns the supplied strong key instead of creating a duplicate", async () => {
    const { service, accounting, mutations, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [{
        contactId: "22222222-2222-4222-8222-222222222222",
        name: "Renamed Exact Customer",
        email: "customer@example.test",
        status: "ACTIVE",
      }],
    });
    await expect(service.prepare(context(), onlyUnresolvedContactSource())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
        reasonCodes: ["XERO_CONTACT_STRONG_KEY_COLLISION_DIFFERENT_NAME"],
        providerMutationPossible: false,
      }),
    });
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareContactCreate).not.toHaveBeenCalled();
    expect(accounting.createContact).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it.each(["ARCHIVED", "GDPRREQUEST"] as const)(
    "blocks a typed durable identity already owned by a differently named %s contact before preflight or creation",
    async (status) => {
      const input = typedContactOnlySource(`case-inactive-${status.toLowerCase()}`, "New Display Name", {
        kind: "LEGAL_REGISTRY",
        jurisdiction: "SG",
        registryScheme: "ACRA_UEN",
        number: "202600001R",
      });
      const { service, accounting, mutations, providerWrite, providerWritePermit } = runtime({
        testTenant: true,
        initialContacts: [{
          contactId: status === "ARCHIVED"
            ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          name: "Historical Display Name",
          companyNumber: "202600001R",
          status,
        }],
      });

      await expect(service.prepare(context(), input)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({
          failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
          reasonCodes: ["XERO_CONTACT_INACTIVE_STRONG_IDENTITY_COLLISION"],
          providerMutationPossible: false,
        }),
      });
      expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
      expect(accounting.prepareContactCreate).not.toHaveBeenCalled();
      expect(accounting.createContact).not.toHaveBeenCalled();
      expect(providerWritePermit).not.toHaveBeenCalled();
      expect(providerWrite).not.toHaveBeenCalled();
    },
  );

  it.each(["ARCHIVED", "GDPRREQUEST"] as const)(
    "rechecks the complete lifecycle at the claim edge when a %s strong-key owner appears after preparation",
    async (status) => {
      const input = typedContactOnlySource(`case-claim-edge-${status.toLowerCase()}`, "Claim Edge Contact", {
        kind: "LEGAL_REGISTRY",
        jurisdiction: "SG",
        registryScheme: "ACRA_UEN",
        number: "202600099N",
      });
      let injected = false;
      const { service, repository, accounting, providerWrite, providerWritePermit } = runtime({
        testTenant: true,
        initialContacts: [],
        beforeContactProviderClaim: (contacts) => {
          if (injected) return;
          injected = true;
          contacts.push({
            contactId: status === "ARCHIVED"
              ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
              : "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            name: "Prior Legal Name",
            companyNumber: "202600099N",
            status,
          });
        },
      });
      const prepared = await service.prepare(context(), input);

      await expect(service.execute(context(), {
        case_id: prepared.case_id,
        case_version: prepared.case_version,
        request_id: `execute-claim-edge-${status.toLowerCase()}`,
      })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: expect.objectContaining({
          reasonCodes: ["XERO_CONTACT_INACTIVE_STRONG_IDENTITY_COLLISION"],
          providerMutationPossible: false,
        }),
      });
      const durable = await repository.getBoundAccountingCase({
        binding: durableCaseBinding(),
        caseId: prepared.case_id,
        version: prepared.case_version,
      });
      const preparationId = durable?.operations[0]?.preparationId;
      expect(preparationId).toBeDefined();
      await expect(repository.getXeroMutationRequest(
        xeroMutationRequestIdForPreparation(preparationId!),
      )).resolves.toBeUndefined();
      expect(accounting.createContact).toHaveBeenCalledOnce();
      expect(providerWritePermit).not.toHaveBeenCalled();
      expect(providerWrite).not.toHaveBeenCalled();
    },
  );

  it("reuses an exact registered tuple but blocks a second model-extracted namespace on the same provider bare number", async () => {
    const { service, accounting, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [],
    });
    const sg = typedContactOnlySource("case-sg-acra-123", "SG Registered", {
      kind: "LEGAL_REGISTRY",
      jurisdiction: "SG",
      registryScheme: "ACRA",
      number: "123",
    });
    const preparedSg = await service.prepare(context(), sg);
    await service.execute(context(), {
      case_id: preparedSg.case_id,
      case_version: preparedSg.case_version,
      request_id: "execute-sg-acra-123",
    });
    expect(accounting.createContact).toHaveBeenCalledTimes(1);
    expect(providerWritePermit).toHaveBeenCalledTimes(1);
    expect(providerWrite).toHaveBeenCalledTimes(1);

    const exactReplay = await service.prepare(context(), {
      ...sg,
      case_id: "case-sg-acra-123-reuse",
      facts: sg.facts.map((fact) => ({
        ...fact,
        email: "case-sg-acra-123@example.test",
      })),
    });
    expect(exactReplay.operations).toEqual([]);
    expect(accounting.createContact).toHaveBeenCalledTimes(1);

    const us = typedContactOnlySource("case-us-irs-123", "US Candidate", {
      kind: "LEGAL_REGISTRY",
      jurisdiction: "US",
      registryScheme: "IRS",
      number: "123",
    });
    await expect(service.prepare(context(), us)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        failureLayer: "ACCOUNTING_CASE_CONTACT_IDENTITY",
        reasonCodes: ["XERO_CONTACT_PROVIDER_BARE_NUMBER_NAMESPACE_UNVERIFIED"],
        providerMutationPossible: false,
      }),
    });
    expect(accounting.prepareContactCreate).toHaveBeenCalledTimes(1);
    expect(accounting.createContact).toHaveBeenCalledTimes(1);
    expect(providerWritePermit).toHaveBeenCalledTimes(1);
    expect(providerWrite).toHaveBeenCalledTimes(1);
  });

  it("applies the same fail-closed namespace rule to provider tenant account identities", async () => {
    const { service, accounting, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [],
    });
    const ar = typedContactOnlySource("case-xero-ar-123", "AR Contact", {
      kind: "PROVIDER_TENANT_ACCOUNT",
      providerId: "xero",
      namespace: "AR_CUSTOMER",
      number: "CUST-123",
    });
    const preparedAr = await service.prepare(context(), ar);
    await service.execute(context(), {
      case_id: preparedAr.case_id,
      case_version: preparedAr.case_version,
      request_id: "execute-xero-ar-123",
    });

    const ap = typedContactOnlySource("case-xero-ap-123", "AP Contact", {
      kind: "PROVIDER_TENANT_ACCOUNT",
      providerId: "xero",
      namespace: "AP_SUPPLIER",
      number: "CUST-123",
    });
    await expect(service.prepare(context(), ap)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        reasonCodes: ["XERO_CONTACT_PROVIDER_BARE_NUMBER_NAMESPACE_UNVERIFIED"],
        identityEvidence: {
          providerEvidence: "BARE_NUMBER_MATCH",
          serverTupleContinuity: "NO_EXACT_REGISTERED_TUPLE",
          externalNamespaceAuthority: "UNVERIFIED",
          sourceTruth: "UNVERIFIED",
        },
        providerMutationPossible: false,
      }),
    });
    expect(accounting.prepareContactCreate).toHaveBeenCalledTimes(1);
    expect(accounting.createContact).toHaveBeenCalledTimes(1);
    expect(providerWritePermit).toHaveBeenCalledTimes(1);
    expect(providerWrite).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the ACTIVE-contact strong-key scan cannot prove its final page", async () => {
    const { service, accounting, mutations, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [],
    });
    vi.mocked(accounting.listContacts).mockImplementation(async (_requestContext, input) => ({
      contacts: [],
      pagination: {
        page: input.page,
        pageSize: input.limit,
        returned: 0,
        hasNextPage: true,
        hasNextPageIsEstimated: true,
        omittedInvalid: 0,
      },
    }));
    await expect(service.prepare(context(), onlyUnresolvedContactSource())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        reasonCodes: ["XERO_CONTACT_STRONG_IDENTITY_SCAN_INCOMPLETE"],
        providerMutationPossible: false,
      }),
    });
    expect(accounting.listContacts).toHaveBeenCalledOnce();
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareContactCreate).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("fails closed when any ARCHIVED lifecycle page omits a provider row", async () => {
    const { service, accounting, mutations, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [],
    });
    const implementation = vi.mocked(accounting.listContacts).getMockImplementation();
    if (!implementation) throw new Error("contact list implementation missing");
    vi.mocked(accounting.listContacts).mockImplementation(async (requestContext, input) => {
      const result = await implementation(requestContext, input);
      return input.status === "ARCHIVED"
        ? { ...result, pagination: { ...result.pagination, omittedInvalid: 1 } }
        : result;
    });
    await expect(service.prepare(context(), onlyUnresolvedContactSource())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        reasonCodes: ["XERO_CONTACT_STRONG_IDENTITY_SCAN_INCOMPLETE"],
        providerMutationPossible: false,
      }),
    });
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareContactCreate).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });

  it("keeps contact-only v1 awaiting a server-bound continuation and idempotently advances that intent", async () => {
    const { service, repository, provider, accounting, mutations, contacts, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [],
    });
    const publicFacts = contactDependentSource();
    const v1 = await service.prepare(context(), publicFacts);
    expect(v1.operations).toEqual([
      expect.objectContaining({ action_id: "contact.create_basic", state: "PENDING" }),
    ]);
    expect(v1.events.find((event) => event.event_key === "sales-invoice-event")).toMatchObject({
      disposition: "REVIEW_REQUIRED",
      reason_codes: ["PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION"],
    });

    const executedV1 = await service.execute(context(), {
      case_id: v1.case_id,
      case_version: v1.case_version,
      request_id: "execute-contact-v1",
    });
    expect(executedV1).toMatchObject({
      state: "AWAITING_CONTINUATION",
      operations: [{ action_id: "contact.create_basic", state: "READBACK_VERIFIED" }],
      completion_claim: {
        eligible_write_status: "PARTIAL",
        ledger_write_claim: "PARTIALLY_VERIFIED",
      },
      continuation: {
        action: "PREPARE_NEXT_CASE_VERSION",
        next_expected_version: 1,
        token: expect.stringMatching(/^acc_[a-f0-9]{64}$/u),
        prepare_template: {
          case_id: v1.case_id,
          expected_version: 1,
          source_label: expect.any(String),
          source_set_complete: true,
          documents: expect.any(Array),
        },
      },
    });
    expect(accounting.createContact).toHaveBeenCalledOnce();
    expect(contacts).toEqual([expect.objectContaining({
      contactId: "77777777-7777-4777-8777-777777777777",
      name: "Exact Customer",
      email: "customer@example.test",
      status: "ACTIVE",
    })]);

    const restarted = new XeroAccountingCaseService(repository, provider, accounting, mutations, {
      continuationSecret,
      testTenantIds: [tenantId],
      businessAuthorityProfiles: parseXeroAccountingCaseBusinessAuthorityProfiles([{
        tenant_id: tenantId,
        writer_authority: {
          mode: "EXCLUSIVE_GOVERNED_WRITER",
          authority_id: "case-test-exclusive-writer",
          revision: 1,
          covers_all_tenant_writers: true,
          verification_receipt_sha256: "f".repeat(64),
        },
        recurring_series_authorities: [],
      }]),
      clock: () => new Date("2026-08-13T04:00:00.000Z"),
    });
    const retriedV1 = await restarted.execute(context(), {
      case_id: v1.case_id,
      case_version: 1,
      request_id: "execute-contact-v1",
    });
    expect(retriedV1).toEqual(executedV1);
    expect(accounting.createContact).toHaveBeenCalledOnce();
    const v1Status = await restarted.status(context(), { case_id: v1.case_id, case_version: 1 });
    expect(v1Status).toEqual(executedV1);

    const continuation = executedV1.continuation!;
    const publicContinuation = JSON.stringify(continuation.prepare_template);
    for (const forbidden of [
      "xeroContactId", "contactId", "tenantId", "factId", "eventId", "lineId",
      "canonicalPayload", "businessIdentityHash", "mutationRequestId",
    ]) expect(publicContinuation).not.toContain(forbidden);
    await expect(restarted.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse({
      ...continuation.prepare_template,
      continuation_token: `${continuation.token.slice(0, -1)}${continuation.token.endsWith("0") ? "1" : "0"}`,
      }),
    ))).rejects.toMatchObject({ code: "CONFLICT" });
    const changedTemplate = structuredClone(continuation.prepare_template);
    changedTemplate.documents[0]!.reference = "INV-CHANGED-BY-CALLER";
    await expect(restarted.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse({
      ...changedTemplate,
      continuation_token: continuation.token,
      }),
    ))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(accounting.createContact).toHaveBeenCalledOnce();
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();
    const v2 = await restarted.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse({
      ...continuation.prepare_template,
      continuation_token: continuation.token,
      }),
    ));
    expect(v2).toMatchObject({ case_version: 2, persistence_mode: "ADVANCED" });
    expect(v2.operations).toEqual([
      expect.objectContaining({ action_id: "customer_invoice.create_draft", state: "PENDING" }),
    ]);
    expect(v2.events.some((event) => event.event_key === "contact-candidate-event")).toBe(false);
    expect(v2.events.find((event) => event.route === "SALES_INVOICE")).toMatchObject({
      disposition: "AUTO_EXECUTE",
    });
    const v2Contact = contacts[0];
    expect(v2Contact).toMatchObject({ email: "customer@example.test" });
    // Only the contact was written in v1; v2 preparation itself is never a
    // ledger-write claim and has not crossed the invoice provider boundary.
    expect(providerWrite).toHaveBeenCalledTimes(1);
    expect(providerWritePermit).toHaveBeenCalledTimes(1);
    expect(accounting.executePreparedSalesInvoiceDraft).not.toHaveBeenCalled();

    const replay = await restarted.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse({
      ...continuation.prepare_template,
      continuation_token: continuation.token,
      }),
    ));
    expect(replay).toMatchObject({
      case_version: 2,
      persistence_mode: "IDEMPOTENT_REPLAY",
    });
    await expect(restarted.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse(continuation.prepare_template),
    ))).rejects.toMatchObject({ code: "CONFLICT" });

    const executedV2 = await restarted.execute(context(), {
      case_id: v2.case_id,
      case_version: v2.case_version,
      request_id: "execute-invoice-v2",
    });
    expect(executedV2).toMatchObject({
      state: "TERMINAL",
      operations: [{ action_id: "customer_invoice.create_draft", state: "READBACK_VERIFIED" }],
    });
    expect(executedV2).not.toHaveProperty("continuation");
    expect(accounting.createContact).toHaveBeenCalledTimes(1);
    expect(accounting.executePreparedSalesInvoiceDraft).toHaveBeenCalledTimes(1);
  });

  it("creates one role-neutral legal contact then writes its AR and AP documents exactly once in v2", async () => {
    const { service, accounting, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [],
      taxRates: [{
        taxType: "OUTPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToRevenue: true,
      }, {
        taxType: "INPUTY24",
        status: "ACTIVE",
        displayTaxRate: "9.0000",
        effectiveRate: "9.0000",
        canApplyToExpenses: true,
      }],
    });
    const input = normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse(dualRoleContactDependentBusinessIntake()),
    );
    expect(input.facts.filter((fact) => fact.kind === "CONTACT_CANDIDATE")).toEqual([
      expect.objectContaining({ usageRoles: ["CUSTOMER", "SUPPLIER"] }),
    ]);
    const v1 = await service.prepare(context(), input);
    expect(v1.operations).toEqual([
      expect.objectContaining({ action_id: "contact.create_basic", state: "PENDING" }),
    ]);
    const completedV1 = await service.execute(context(), {
      case_id: v1.case_id,
      case_version: v1.case_version,
      request_id: "execute-dual-role-contact-v1",
    });
    expect(completedV1.continuation?.prepare_template.documents).toHaveLength(2);
    expect(completedV1.continuation?.prepare_template).not.toHaveProperty("new_contacts");
    expect(accounting.createContact).toHaveBeenCalledOnce();

    const continuation = completedV1.continuation!;
    const v2 = await service.prepare(context(), normalizeXeroAccountingCaseBusinessIntake(
      xeroAccountingCaseBusinessIntakeSchema.parse({
        ...continuation.prepare_template,
        continuation_token: continuation.token,
      }),
    ));
    expect(v2.operations).toHaveLength(2);
    expect(new Set(v2.operations.map((operation) => operation.action_id))).toEqual(new Set([
      "customer_invoice.create_draft",
      "supplier_bill.create_draft",
    ]));
    providerWrite.mockClear();
    providerWritePermit.mockClear();
    const completedV2 = await service.execute(context(), {
      case_id: v2.case_id,
      case_version: v2.case_version,
      request_id: "execute-dual-role-documents-v2",
    });
    expect(completedV2.operations).toHaveLength(2);
    expect(completedV2.operations.every((operation) => operation.state === "READBACK_VERIFIED")).toBe(true);
    expect(accounting.createContact).toHaveBeenCalledOnce();
    // The supplier wrapper delegates to the same deterministic fake write
    // implementation, so this spy observes one direct AR call plus the AP delegation.
    expect(accounting.executePreparedSalesInvoiceDraft).toHaveBeenCalledTimes(2);
    expect(accounting.executePreparedSupplierBillDraft).toHaveBeenCalledOnce();
    expect(providerWritePermit).toHaveBeenCalledTimes(2);
    expect(providerWrite).toHaveBeenCalledTimes(2);
  });

  it("runs public new-contact plus invoice through prepare, status, continuation and exactly-once execution", async () => {
    const { service, accounting, contacts } = runtime({ testTenant: true, initialContacts: [] });
    const server = createAccountingMcpServer(accounting, context(), undefined, undefined, service);
    const client = new Client({ name: "case-public-continuation", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport as unknown as Transport);
      await client.connect(clientTransport);
      const preparedResponse = await client.callTool({
        name: "xero_prepare_accounting_case",
        arguments: publicContactDependentBusinessIntake(),
      });
      expect(preparedResponse.isError).not.toBe(true);
      const prepared = mcpResult<{ case_id: string; case_version: number }>(preparedResponse);
      const executedV1Response = await client.callTool({
        name: "xero_execute_accounting_case",
        arguments: {
          case_id: prepared.case_id,
          case_version: prepared.case_version,
          request_id: "execute-public-contact-v1",
        },
      });
      expect(executedV1Response.isError).not.toBe(true);
      const executedV1 = mcpResult<{
        state: string;
        completion_claim: { eligible_write_status: string };
        continuation: {
          token: string;
          prepare_template: Record<string, unknown>;
        };
      }>(executedV1Response);
      expect(executedV1).toMatchObject({
        state: "AWAITING_CONTINUATION",
        completion_claim: { eligible_write_status: "PARTIAL" },
        continuation: { token: expect.stringMatching(/^acc_[0-9a-f]{64}$/u) },
      });
      const statusResponse = await client.callTool({
        name: "xero_get_accounting_case_status",
        arguments: { case_id: prepared.case_id, case_version: 1 },
      });
      expect(statusResponse.isError).not.toBe(true);
      expect(mcpResult(statusResponse)).toMatchObject(executedV1);

      const continuationInput = {
        ...executedV1.continuation.prepare_template,
        continuation_token: executedV1.continuation.token,
      };
      const preparedV2Response = await client.callTool({
        name: "xero_prepare_accounting_case",
        arguments: continuationInput,
      });
      expect(preparedV2Response.isError).not.toBe(true);
      const preparedV2 = mcpResult<{
        case_id: string;
        case_version: number;
        persistence_mode: string;
        operations: Array<{ action_id: string }>;
      }>(preparedV2Response);
      expect(preparedV2).toMatchObject({
        case_version: 2,
        persistence_mode: "ADVANCED",
        operations: [{ action_id: "customer_invoice.create_draft" }],
      });
      const replayV2Response = await client.callTool({
        name: "xero_prepare_accounting_case",
        arguments: continuationInput,
      });
      expect(replayV2Response.isError).not.toBe(true);
      expect(mcpResult(replayV2Response)).toMatchObject({
        case_version: 2,
        persistence_mode: "IDEMPOTENT_REPLAY",
      });
      const executedV2Response = await client.callTool({
        name: "xero_execute_accounting_case",
        arguments: {
          case_id: preparedV2.case_id,
          case_version: preparedV2.case_version,
          request_id: "execute-public-invoice-v2",
        },
      });
      expect(executedV2Response.isError).not.toBe(true);
      const executedV2 = mcpResult(executedV2Response);
      expect(executedV2).toMatchObject({
        state: "TERMINAL",
        operations: [{ action_id: "customer_invoice.create_draft", state: "READBACK_VERIFIED" }],
      });
      const replayedV2Response = await client.callTool({
        name: "xero_execute_accounting_case",
        arguments: {
          case_id: preparedV2.case_id,
          case_version: preparedV2.case_version,
          request_id: "execute-public-invoice-v2-replay",
        },
      });
      expect(replayedV2Response.isError).not.toBe(true);
      expect(mcpResult(replayedV2Response)).toEqual(executedV2);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
    expect(contacts).toHaveLength(1);
    expect(accounting.createContact).toHaveBeenCalledTimes(1);
    expect(accounting.executePreparedSalesInvoiceDraft).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate exact active contacts during public prepare without compiling or writing", async () => {
    const { service, repository, accounting, mutations, providerWrite, providerWritePermit } = runtime({
      testTenant: true,
      initialContacts: [
        { contactId: "22222222-2222-4222-8222-222222222222", name: "Exact Customer", status: "ACTIVE" },
        { contactId: "99999999-9999-4999-8999-999999999999", name: "Exact Customer", status: "ACTIVE" },
      ],
    });
    await expect(service.prepare(context(), source())).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        reasonCodes: ["AMBIGUOUS_EXACT_ACTIVE_XERO_CONTACT_IDENTITY"],
        providerMutationPossible: false,
      },
    });
    await expect(repository.getBoundAccountingCase({
      binding: durableCaseBinding(), caseId: "case-service-1", version: 1,
    })).resolves.toBeUndefined();
    expect(mutations.preflightAutonomousActions).not.toHaveBeenCalled();
    expect(accounting.prepareSalesInvoiceDraft).not.toHaveBeenCalled();
    expect(providerWritePermit).not.toHaveBeenCalled();
    expect(providerWrite).not.toHaveBeenCalled();
  });
});
