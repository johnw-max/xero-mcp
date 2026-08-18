import {
  bindXeroTenantCoaProfile,
  parseXeroTenantCoaProfiles,
  type XeroTenantCoaProfile,
} from "../../src/policy/xeroTenantCoaProfile.js";
import type { AccountSummary } from "../../src/providers/types.js";
import {
  createXeroAccountingCaseProviderContract,
  projectXeroAccountingCaseCompilerInput,
  validateXeroCompiledOperationAgainstSource,
} from "../../src/policy/xeroAccountingCaseProviderContract.js";
import type { AccountingCaseOperation, AccountingFact, NativeDocumentFact } from "../../src/domain/accountingCase.js";
import type { XeroAccountingCaseBusinessAuthorityProfile } from "../../src/policy/xeroBusinessCoordinateAuthority.js";
import { compileAccountingCase } from "../../src/control-kernel/accountingCaseCompiler.js";
import { createXeroSingaporeAccountingPolicy } from "../../src/policy/xeroSingaporeAccountingPolicy.js";
import { resolveSupportedAccountingMonetaryRule } from "../../src/control-kernel/accountingMonetary.js";
import {
  createXeroOriginalTransactionEvidence,
} from "../../src/policy/xeroOriginalTransactionEvidence.js";
import type { InvoiceSnapshot } from "../../src/providers/types.js";
import { createTestXeroGovernanceArtifacts } from "./xeroGovernanceAuthority.js";

export const TEST_XERO_TENANT_ID = "11111111-1111-4111-8111-111111111111";
const TEST_BUSINESS_AUTHORITIES = new Map<string, XeroAccountingCaseBusinessAuthorityProfile>();

export function testXeroBusinessAuthorityProfile(
  tenantId = TEST_XERO_TENANT_ID,
): XeroAccountingCaseBusinessAuthorityProfile {
  const existing = TEST_BUSINESS_AUTHORITIES.get(tenantId);
  if (existing) return structuredClone(existing);
  const created = createTestXeroGovernanceArtifacts(tenantId).authorityProfiles[0]!;
  TEST_BUSINESS_AUTHORITIES.set(tenantId, created);
  return structuredClone(created);
}

export function testXeroTenantCoaProfile(
  tenantId = TEST_XERO_TENANT_ID,
  revision = 1,
): XeroTenantCoaProfile {
  return parseXeroTenantCoaProfiles([{
    profile_id: `test-sg-coa-${tenantId}`,
    revision,
    tenant_id: tenantId,
    jurisdiction: "SG",
    categories: {
      CONSULTING_REVENUE: {
        account_id: "33333333-3333-4333-8333-333333333333",
        account_code: "200",
        expected_type: "REVENUE",
        expected_class: "REVENUE",
      },
      OFFICE_SUPPLIES: {
        account_id: "33333333-3333-4333-8333-333333333353",
        account_code: "453",
        expected_type: "EXPENSE",
        expected_class: "EXPENSE",
      },
      CLOUD_SUBSCRIPTIONS: {
        account_id: "33333333-3333-4333-8333-333333333385",
        account_code: "485",
        expected_type: "EXPENSE",
        expected_class: "EXPENSE",
      },
    },
  }])[0]!;
}

export function testXeroAccounts(profile = testXeroTenantCoaProfile()): AccountSummary[] {
  return Object.values(profile.categories).map((category) => ({
    accountId: category.account_id,
    code: category.account_code,
    status: "ACTIVE",
    type: category.expected_type,
    class: category.expected_class,
  }));
}

export function testXeroTenantCoaBinding(
  tenantId = TEST_XERO_TENANT_ID,
  revision = 1,
) {
  const profile = testXeroTenantCoaProfile(tenantId, revision);
  return bindXeroTenantCoaProfile(profile, testXeroAccounts(profile));
}

/** Internal fixture helper for legacy compiler tests whose tenant IDs predate UUID-bound public targets. */
export function testXeroTenantCoaBindingForTarget(tenantId: string) {
  return testXeroTenantCoaBinding(tenantId);
}

/*
 * Test-only server history. These exact snapshots are deliberately independent
 * of the submitted same-Case invoice/bill facts in golden-14: compiler tests
 * may inject provider evidence, but submitted originals never become authority.
 */
const TEST_HISTORICAL_ORIGINALS: readonly InvoiceSnapshot[] = Object.freeze([{
  invoiceId: "44444444-4444-4444-8444-444444444444",
  tenantId: TEST_XERO_TENANT_ID,
  type: "ACCREC",
  status: "AUTHORISED",
  contact: { contactId: "22222222-2222-4222-8222-222222222222", name: "Lion City Digital Pte. Ltd." },
  invoiceNumber: "INV-2026-0702",
  invoiceDate: "2026-07-02",
  currency: "SGD",
  lineAmountType: "Exclusive",
  subTotal: "4000.0000",
  totalTax: "360.0000",
  total: "4360.0000",
  lines: [{
    description: "Consulting services - July 2026",
    quantity: "20.0000",
    unitAmount: "200.0000",
    lineAmount: "4000.0000",
    taxAmount: "360.0000",
    accountId: "33333333-3333-4333-8333-333333333333",
    accountCode: "200",
    taxType: "OUTPUTY24",
  }],
  lineItemCount: 1,
  linesTruncated: false,
}, {
  invoiceId: "55555555-5555-4555-8555-555555555555",
  tenantId: TEST_XERO_TENANT_ID,
  type: "ACCPAY",
  status: "AUTHORISED",
  contact: { contactId: "33333333-3333-4333-8333-333333333333", name: "OfficeHub Singapore Pte. Ltd." },
  invoiceNumber: "OH-260701",
  reference: "supplementary-reference-must-not-authorise-provider-identifier",
  invoiceDate: "2026-07-03",
  currency: "SGD",
  lineAmountType: "Exclusive",
  subTotal: "800.0000",
  totalTax: "72.0000",
  total: "872.0000",
  lines: [{
    description: "Premium copier paper",
    quantity: "10.0000",
    unitAmount: "80.0000",
    lineAmount: "800.0000",
    taxAmount: "72.0000",
    accountId: "33333333-3333-4333-8333-333333333353",
    accountCode: "453",
    taxType: "INPUTY24",
  }],
  lineItemCount: 1,
  linesTruncated: false,
}]);

function normalized(value: string | undefined): string | undefined {
  return value?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
}

function exactTestHistoricalOriginal(
  credit: NativeDocumentFact,
  tenantId: string,
  contactId: string,
): InvoiceSnapshot | undefined {
  const expectedType = credit.counterpartyRole === "CUSTOMER" ? "ACCREC" : "ACCPAY";
  const requestedReference = normalized(credit.originalDocumentReference);
  const matches = TEST_HISTORICAL_ORIGINALS.filter((snapshot) =>
    snapshot.type === expectedType &&
    snapshot.contact.contactId === contactId &&
    (() => {
      const fixtureReference = normalized(snapshot.invoiceNumber);
      return requestedReference === fixtureReference || (
        fixtureReference !== undefined && requestedReference?.startsWith(`${fixtureReference}-`) === true &&
        /^[A-F0-9]{12}$/u.test(requestedReference.slice(fixtureReference.length + 1))
      );
    })() &&
    snapshot.invoiceDate === credit.originalDocumentDate && snapshot.currency === credit.currency);
  return matches.length === 1
    ? {
        ...structuredClone(matches[0]!),
        tenantId,
        invoiceNumber: credit.originalDocumentReference,
      }
    : undefined;
}

/** Injects only fixed server-side exact-GET evidence for legacy direct compiler tests. */
function injectTestOriginalTransactionEvidence(
  facts: readonly AccountingFact[],
  tenantId: string,
  contactBindings: ReturnType<typeof projectXeroAccountingCaseCompilerInput>["contactBindings"],
  tenantCoaBinding: ReturnType<typeof testXeroTenantCoaBindingForTarget>,
  accountingPolicy: ReturnType<typeof createXeroSingaporeAccountingPolicy>,
) {
  const sealedFacts = structuredClone([...facts]) as AccountingFact[];
  const evidenceFacts: AccountingFact[] = [];
  const evidenceBindings = new Map();
  const supersededFactIds = new Set(sealedFacts.flatMap((fact) =>
    fact.supersedesFactId ? [fact.supersedesFactId] : []));
  for (let index = 0; index < sealedFacts.length; index += 1) {
    const fact = sealedFacts[index]!;
    if (fact.kind !== "NATIVE_DOCUMENT" || fact.documentKind !== "CREDIT_NOTE") continue;
    if (supersededFactIds.has(fact.factId)) continue;
    const contactId = contactBindings.get(fact.factId)?.contactId;
    if (!contactId) continue;
    const snapshot = exactTestHistoricalOriginal(fact, tenantId, contactId);
    if (!snapshot) continue;
    const monetary = resolveSupportedAccountingMonetaryRule(accountingPolicy, fact.currency);
    if (!monetary.rule) continue;
    const resolved = createXeroOriginalTransactionEvidence({
      credit: fact,
      snapshot,
      expectedTenantId: tenantId,
      expectedContactId: contactId,
      checkedObjectCount: 1,
      tenantCoaProfile: tenantCoaBinding,
      monetaryRule: monetary.rule,
      accountingPolicy,
    });
    sealedFacts[index] = { ...fact, originalTransactionEvidenceHash: resolved.evidence.evidenceHash };
    evidenceFacts.push(resolved.evidence);
    evidenceBindings.set(resolved.evidence.evidenceHash, resolved.binding);
  }
  return Object.freeze({ facts: [...sealedFacts, ...evidenceFacts], evidenceBindings });
}

export function compileTestXeroAccountingCase(
  raw: unknown,
  businessAuthority?: XeroAccountingCaseBusinessAuthorityProfile,
) {
  const candidate = raw as { target?: { tenantId?: unknown } };
  const tenantId = typeof candidate?.target?.tenantId === "string"
    ? candidate.target.tenantId
    : TEST_XERO_TENANT_ID;
  const tenantCoaBinding = testXeroTenantCoaBindingForTarget(tenantId);
  const projected = projectXeroAccountingCaseCompilerInput(raw);
  const accountingPolicy = createXeroSingaporeAccountingPolicy({ paysTax: projected.paysTax });
  const injected = injectTestOriginalTransactionEvidence(
    projected.input.facts,
    tenantId,
    projected.contactBindings,
    tenantCoaBinding,
    accountingPolicy,
  );
  return compileAccountingCase(
    { ...projected.input, facts: injected.facts },
    accountingPolicy,
    createXeroAccountingCaseProviderContract(
      projected.contactBindings,
      tenantCoaBinding,
      undefined,
      businessAuthority,
      injected.evidenceBindings,
    ),
  );
}

export function validateTestXeroCompiledOperationAgainstSource(
  operation: AccountingCaseOperation,
  source: NativeDocumentFact,
  policyProjection: Readonly<Record<string, unknown>>,
) {
  return validateXeroCompiledOperationAgainstSource(
    operation,
    source,
    policyProjection,
    testXeroTenantCoaBindingForTarget(operation.target.tenantId),
  );
}
