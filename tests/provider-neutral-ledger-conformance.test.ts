import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccountingCaseProviderEnforcementContract } from "../src/control-kernel/accountingCaseProviderContract.js";
import type { AccountingPolicyEnforcementContract } from "../src/control-kernel/accountingPolicyEnforcementContract.js";
import { compileAccountingCase } from "../src/control-kernel/accountingCaseCompiler.js";
import {
  validateAccountingCaseReadbackEconomics,
  type LedgerDurableReadbackProjection,
} from "../src/control-kernel/accountingCaseReadbackValidator.js";
import { issueDeterministicValidationReceipt } from "../src/control-kernel/deterministicValidation.js";
import {
  evaluateAutonomousLedgerWrite,
  type LedgerAutonomousAuthorizationReceipt,
  type LedgerOperationPrincipal,
  type LedgerOperationTarget,
} from "../src/control-kernel/ledgerControlKernel.js";
import {
  consumeLedgerProviderWritePermit,
  issueLedgerProviderWritePermit,
  type LedgerProviderPermitContract,
  type LedgerProviderWritePermit,
  type LedgerProviderWritePermitClaims,
} from "../src/control-kernel/ledgerProviderWritePermit.js";
import type {
  AccountingCaseOperation,
  ContactCandidateFact,
  NativeDocumentFact,
  NativeDocumentRoute,
} from "../src/domain/accountingCase.js";
import type { PrepareAccountingCaseInput } from "../src/domain/accountingCaseSchemas.js";
import { hashObject } from "../src/security/hash.js";
import { loadXeroResponse } from "./fixtures/xero-provider-responses/index.js";

const now = new Date("2026-08-13T06:00:00.000Z");
const providerId = "fakebooks";
const tenantId = "fake-tenant-1";
const adapterOperation = "FakeBooksAdapter.createDraftDocument";

const resolvedContacts = Object.freeze<Record<string, string>>({
  "Lion City Digital Pte. Ltd.": "fb-contact-lion-city",
  "OfficeHub Singapore Pte. Ltd.": "fb-contact-officehub",
  "CloudHost Inc.": "fb-contact-cloudhost",
});

function routeFor(fact: NativeDocumentFact): NativeDocumentRoute {
  if (fact.documentKind === "INVOICE") {
    return fact.counterpartyRole === "CUSTOMER" ? "SALES_INVOICE" : "SUPPLIER_BILL";
  }
  return fact.counterpartyRole === "CUSTOMER" ? "CUSTOMER_CREDIT" : "SUPPLIER_CREDIT";
}

const fakeProviderContract = Object.freeze({
  providerId,
  contractVersion: "fakebooks-provider-v1",
  routeContractVersion: "fakebooks-native-route-v1",
  unresolvedContactReasonCode: "EXACT_FAKEBOOKS_CONTACT_REQUIRED",
  capabilityBounds: Object.freeze({
    schemaVersion: "fakebooks-capability-bounds:v1",
    nativeDocuments: Object.freeze(Object.fromEntries([
      "SALES_INVOICE", "SUPPLIER_BILL", "CUSTOMER_CREDIT", "SUPPLIER_CREDIT",
    ].map((route) => [route, Object.freeze({
      maxLines: 50,
      maxQuantity: "1000000",
      maxUnitAmount: "1000000000",
      maxEnteredLineAmount: "900000000000",
    })])) as Record<NativeDocumentRoute, Readonly<{
      maxLines: number; maxQuantity: string; maxUnitAmount: string; maxEnteredLineAmount: string;
    }>>),
    contact: Object.freeze({
      maxNameLength: 255,
      maxEmailLength: 320,
      maxCompanyNumberLength: 128,
      maxAccountNumberLength: 128,
      maxDurableIdentityNumberLength: 128,
    }),
  }),
  planProjection: Object.freeze({
    schemaVersion: "fakebooks-accounting-case-provider-projection:v1",
    resolvedContacts,
  }),
  evaluateNativeRoute(fact: NativeDocumentFact) {
    const reasonCodes = fact.documentKind === "INVOICE" && !fact.dueDate
      ? ["FAKEBOOKS_INVOICE_DUE_DATE_REQUIRED"]
      : [];
    return {
      route: routeFor(fact),
      adapterCanPrepare: reasonCodes.length === 0,
      reasonCodes,
    };
  },
  contactBinding(fact: ContactCandidateFact | NativeDocumentFact) {
    const name = fact.kind === "CONTACT_CANDIDATE" ? fact.name : fact.contactName;
    const resolvedId = resolvedContacts[name];
    return {
      ...(resolvedId ? { resolvedId } : {}),
      canonicalFields: Object.freeze({ ...(resolvedId ? { providerContactId: resolvedId } : {}) }),
    };
  },
  taxBinding(_fact, semantics) {
    const providerTaxCode = `FB_${semantics}`;
    return {
      documentFields: Object.freeze({ providerTaxCode }),
      lineFields: Object.freeze({ providerTaxCode }),
    };
  },
  accountingCategoryBinding(_fact, accountingCategory) {
    return {
      canonicalFields: Object.freeze({}),
      bindingProjection: Object.freeze({
        schemaVersion: "fakebooks-category-binding:v1",
        accountingCategory,
      }),
      reasonCodes: [],
    };
  },
  businessIdentity(fact: ContactCandidateFact | NativeDocumentFact) {
    const name = fact.kind === "CONTACT_CANDIDATE" ? fact.name : fact.contactName;
    const kind = fact.kind === "CONTACT_CANDIDATE"
        ? "FAKEBOOKS_CONTACT_NAME_COLLISION"
        : "FAKEBOOKS_DOCUMENT_REFERENCE_ON_DATE";
    const canonicalFields = Object.freeze({
        contactId: resolvedContacts[name] ?? null,
        name: name.normalize("NFKC").trim().toLocaleLowerCase("en"),
        ...(fact.kind === "NATIVE_DOCUMENT"
          ? {
              route: routeFor(fact),
              reference: fact.reference.trim().toLocaleUpperCase("en"),
              documentDate: fact.documentDate,
              currency: fact.currency,
            }
          : {}),
      });
    return {
      kind,
      canonicalFields,
      reservation: Object.freeze({
        kind,
        canonicalFields,
        scope: fact.kind === "NATIVE_DOCUMENT" ? "DATED_OCCURRENCE" : "ALL_OCCURRENCES",
        ...(fact.kind === "NATIVE_DOCUMENT" ? { occurrenceDate: fact.documentDate } : {}),
      }),
    };
  },
}) satisfies AccountingCaseProviderEnforcementContract;

const fakeAccountingPolicy = Object.freeze({
  policyId: "northland-accrual",
  policyVersion: "northland-accrual-v3",
  jurisdiction: "NLX",
  planProjection: Object.freeze({
    schemaVersion: "northland-policy-projection:v2",
    chartRevision: "tenant-coa-77",
    // Keyed by the caller-declared account code -- this fake, non-Xero policy
    // owns its own opaque interpretation of that string; the shared kernel
    // never reads this map or the key it is keyed by.
    categories: Object.freeze({
      "200": "REV-4100",
      "453": "OPEX-6105",
      "485": "OPEX-6420",
    }),
    monetaryRules: Object.freeze({
      ruleVersion: "northland-currency-rounding:v1",
      roundingMode: "HALF_UP",
      taxAggregation: "PER_LINE",
      currencyMinorUnitScales: Object.freeze({ HKD: 2, JPY: 0, KWD: 3, SGD: 2, USD: 2 }),
    }),
  }),
  monetaryRule(currency: string) {
    const scales = (this.planProjection.monetaryRules as Readonly<{
      currencyMinorUnitScales: Readonly<Record<string, number>>;
    }>).currencyMinorUnitScales;
    const minorUnitScale = scales[currency];
    if (minorUnitScale === undefined || ![0, 1, 2, 3, 4].includes(minorUnitScale)) return undefined;
    return {
      currency,
      minorUnitScale: minorUnitScale as 0 | 1 | 2 | 3 | 4,
      roundingMode: "HALF_UP" as const,
      taxAggregation: "PER_LINE" as const,
    };
  },
  evaluateNativeDocument(fact: NativeDocumentFact) {
    const lineDecisions = fact.lines.map((line) => {
      // This fake, non-Xero policy owns its own reading of the caller-declared
      // coordinate: it treats the declared account code as its category key
      // and the declared TaxType as its own rate class, entirely independent
      // of what Xero's declared-ledger policy does with the same field names.
      const accountingCategory = line.accountCode;
      const taxClass = line.taxType;
      const accountRef = (this.planProjection.categories as Readonly<Record<string, string>>)[accountingCategory];
      const reasonCodes = accountRef ? [] : ["NORTHLAND_CATEGORY_UNKNOWN"];
      return {
        lineId: line.lineId,
        accountingCategory,
        taxClass,
        effectiveTaxRateBps: taxClass !== "NONE" ? 500 : 0,
        taxSemantics: fact.counterpartyRole === "CUSTOMER" ? "NLX_OUTPUT" : "NLX_INPUT",
        taxPolicyPeriodId: "NLX_5_2020_TO_2030",
        lineFields: Object.freeze({ ...(accountRef ? { accountRef } : {}) }),
        reasonCodes,
      };
    });
    const accountRefs = [...new Set(lineDecisions.flatMap((decision) =>
      typeof decision.lineFields.accountRef === "string" ? [decision.lineFields.accountRef] : []))];
    return {
      documentFields: Object.freeze({ ...(accountRefs.length === 1 ? { accountRef: accountRefs[0] } : {}) }),
      lineDecisions,
      reasonCodes: lineDecisions.flatMap((decision) => decision.reasonCodes),
    };
  },
  validatePrepayment() { return []; },
  validateEmployeeExpense() { return []; },
}) satisfies AccountingPolicyEnforcementContract;

const fakePermitContract = Object.freeze({
  providerId,
  actionByAdapterOperation: Object.freeze({
    [adapterOperation]: "customer_invoice.create_draft",
  }),
}) satisfies LedgerProviderPermitContract;

interface FakeStoredDocument {
  readonly providerObjectId: string;
  readonly tenantId: string;
  readonly canonicalPayload: Readonly<Record<string, unknown>>;
  readonly writeReceipt: Readonly<Record<string, unknown>>;
}

/** A non-Xero adapter whose only mutation exit consumes the shared permit. */
class FakeBooksAdapter {
  readonly #documents = new Map<string, FakeStoredDocument>();
  writeCount = 0;
  exactGetCount = 0;

  preflight(operation: AccountingCaseOperation) {
    if (operation.target.tenantId !== tenantId) throw new Error("wrong fake provider tenant");
    return Object.freeze({
      providerId,
      tenantId,
      actionId: operation.actionId,
      routeContractVersion: fakeProviderContract.routeContractVersion,
      capabilityReceiptHash: hashObject({
        providerId,
        tenantId,
        actionId: operation.actionId,
        routeContractVersion: fakeProviderContract.routeContractVersion,
        checkedAt: now.toISOString(),
      }),
    });
  }

  createDraft(input: Readonly<{
    permit?: LedgerProviderWritePermit;
    expectedClaims: Readonly<LedgerProviderWritePermitClaims>;
    operation: AccountingCaseOperation;
  }>) {
    // This synchronous consume is the final statement before the simulated
    // provider network boundary. Invalid/replayed authority never reaches I/O.
    consumeLedgerProviderWritePermit(input.permit, input.expectedClaims);
    this.writeCount += 1;
    const providerObjectId = `fb-doc-${this.writeCount}`;
    const writeReceipt = Object.freeze({
      providerRequestId: `fb-request-${this.writeCount}`,
      providerId,
      tenantId,
      payloadHash: input.operation.canonicalPayloadHash,
    });
    const stored = Object.freeze({
      providerObjectId,
      tenantId,
      canonicalPayload: Object.freeze(structuredClone(input.operation.canonicalPayload)),
      writeReceipt,
    });
    this.#documents.set(providerObjectId, stored);
    return Object.freeze({ providerObjectId, writeReceipt });
  }

  exactGet(requestedTenantId: string, providerObjectId: string): FakeStoredDocument {
    this.exactGetCount += 1;
    const stored = this.#documents.get(providerObjectId);
    if (!stored || stored.tenantId !== requestedTenantId) throw new Error("exact provider readback not found");
    return stored;
  }
}

function expectedClaims(
  receipt: LedgerAutonomousAuthorizationReceipt,
  operation: AccountingCaseOperation,
): Readonly<LedgerProviderWritePermitClaims> {
  return Object.freeze({
    providerId,
    adapterOperation,
    actionId: operation.actionId,
    mutationRequestId: `fake-mutation:${operation.operationId}`,
    canonicalPayloadHash: operation.canonicalPayloadHash,
    tenantId: receipt.tenantId,
    actorId: receipt.actorId,
    workspaceId: receipt.workspaceId,
    agentId: receipt.agentId,
    installationId: receipt.installationId,
    bindingId: receipt.bindingId,
    bindingRevision: receipt.bindingRevision,
    connectionId: receipt.connectionId,
    targetSessionId: receipt.targetSessionId,
  });
}

function readbackProjection(
  operation: AccountingCaseOperation,
  stored: FakeStoredDocument,
): LedgerDurableReadbackProjection {
  const payload = operation.canonicalPayload;
  const lines = payload.lines as Array<Record<string, unknown>>;
  const providerDocumentReadback = {
    documentId: stored.providerObjectId,
    type: "FAKEBOOKS_RECEIVABLE_DOCUMENT",
    status: "OPEN_DRAFT",
    subTotal: payload.net,
    totalTax: payload.tax,
    total: payload.gross,
    lineItemCount: lines.length,
    linesTruncated: false,
    lines: lines.map((line) => ({
      lineAmount: line.net,
      taxAmount: line.tax,
      accountingPolicyBindingHash: line.accountingPolicyBindingHash,
      providerAccountBindingHash: line.providerAccountBindingHash,
      providerTaxBindingHash: hashObject({ providerTaxCode: line.providerTaxCode }),
    })),
  };
  const readbackSnapshot = {
    providerObjectId: stored.providerObjectId,
    status: "OPEN_DRAFT",
    canonicalPayload: stored.canonicalPayload,
    evidence: { providerDocumentReadback },
  };
  return {
    state: "READBACK_VERIFIED",
    providerObjectId: stored.providerObjectId,
    writeReceipt: stored.writeReceipt,
    readbackSnapshot,
    readbackSnapshotHash: hashObject(readbackSnapshot),
    readbackCanonicalPayload: stored.canonicalPayload,
    readbackPayloadHash: operation.canonicalPayloadHash,
    canonicalPayload: operation.canonicalPayload,
    canonicalPayloadHash: operation.canonicalPayloadHash,
    readbackStatus: "OPEN_DRAFT",
  };
}

function typescriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = resolve(root, name);
    if (statSync(path).isDirectory()) return typescriptFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function resolveLocalTypescriptImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const absolute = resolve(dirname(importer), specifier);
  const candidates = absolute.endsWith(".js")
    ? [`${absolute.slice(0, -3)}.ts`]
    : [absolute, `${absolute}.ts`, resolve(absolute, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function transitiveSharedTypescriptFiles(roots: readonly string[]): string[] {
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    const specifiers = [...source.matchAll(
      /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    )].map((match) => match[1]).filter((value): value is string => value !== undefined);
    for (const specifier of specifiers) {
      const dependency = resolveLocalTypescriptImport(path, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited].sort();
}

describe("provider-neutral ledger kernel conformance", () => {
  it("runs a non-Xero adapter through compile, preflight, kernel authority, one-shot commit, receipt and exact readback", () => {
    const fixture = JSON.parse(readFileSync(
      fileURLToPath(new URL("../harness/fixtures/xero/golden-14-public-case.v1.json", import.meta.url)),
      "utf8",
    )) as Readonly<{
      case_id: string;
      expected_version: number;
      sources: PrepareAccountingCaseInput["sources"];
      facts: PrepareAccountingCaseInput["facts"];
    }>;
    // ADR-002: the fixture now declares a live Xero account_code/tax_type per
    // line instead of a document-level semantic taxClass. "Standard rated" is
    // read from whether the declared TaxType is the zero-rate "NONE"; this
    // fake, non-Xero policy re-simulates its own flat 5% rate on top.
    const facts = fixture.facts.map((fact) => fact.kind === "NATIVE_DOCUMENT"
      ? (() => {
          const standardRated = fact.lines.every((line) => line.taxType !== "NONE");
          return {
            ...fact,
            declaredTax: standardRated
              ? (Number(fact.declaredNet) * 0.05).toFixed(2)
              : "0.00",
            declaredGross: standardRated
              ? (Number(fact.declaredNet) * 1.05).toFixed(2)
              : fact.declaredNet,
            lines: fact.lines.map((line) => ({
              ...line,
              sourceTax: standardRated
                ? (Number(line.quantity) * Number(line.unitAmount) * 0.05).toFixed(2)
                : "0.00",
            })),
          };
        })()
      : fact.kind === "PAYMENT"
        ? {
            ...fact,
            amount: (() => {
              const related = fixture.facts.find((candidate) =>
                candidate.kind === "NATIVE_DOCUMENT" && candidate.eventKey === fact.relatedEventKey);
              const relatedStandardRated = related?.kind === "NATIVE_DOCUMENT" &&
                related.lines.every((line) => line.taxType !== "NONE");
              return relatedStandardRated
                ? (Number(related.declaredNet) * 1.05).toFixed(2)
                : fact.amount;
            })(),
          }
        : fact);
    const compiled = compileAccountingCase({
      caseId: fixture.case_id,
      expectedVersion: fixture.expected_version,
      target: {
        tenantId,
        environment: "TEST",
        baseCurrency: "SGD",
        taxJurisdiction: "NLX",
        organisationStatus: "ACTIVE",
      },
      sources: fixture.sources,
      facts,
    }, fakeAccountingPolicy, fakeProviderContract);
    expect(compiled.providerId).toBe(providerId);
    expect(compiled.policyVersion).toBe(fakeAccountingPolicy.policyVersion);
    expect(JSON.stringify(compiled.operations)).not.toContain("xeroContactId");

    const operation = compiled.operations.find((candidate) => candidate.nativeRoute === "SALES_INVOICE");
    expect(operation).toBeDefined();
    if (!operation) throw new Error("missing fake provider sales operation");
    expect(operation.canonicalPayload).toMatchObject({
      providerContactId: "fb-contact-lion-city",
      providerTaxCode: "FB_NLX_OUTPUT",
      accountRef: "REV-4100",
    });
    expect(operation.canonicalPayload.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerTaxCode: "FB_NLX_OUTPUT", accountRef: "REV-4100" }),
    ]));

    const adapter = new FakeBooksAdapter();
    const preflight = adapter.preflight(operation);
    const validation = issueDeterministicValidationReceipt({
      actionId: operation.actionId,
      canonicalPayloadHash: operation.canonicalPayloadHash,
      sourceRevisionHash: operation.sourceRevisionHash,
      caseId: operation.caseId,
      caseVersion: operation.caseVersion,
      policyVersion: fakeAccountingPolicy.policyVersion,
      compilerVersion: compiled.compilerVersion,
      checks: [{
        code: "CANONICAL_ECONOMICS_AND_PROVIDER_ROUTE_VALID",
        evidence: {
          providerId,
          route: operation.nativeRoute,
          routeContractVersion: fakeProviderContract.routeContractVersion,
        },
      }],
      now,
    });
    const principal: LedgerOperationPrincipal = Object.freeze({
      actorId: "fake-workspace:user:fake-user",
      workspaceId: "fake-workspace",
      agentId: "fake-agent",
      installationId: "fake-installation",
      bindingId: "fake-binding",
      bindingRevision: 4,
      connectionId: "fake-connection",
    });
    const target: LedgerOperationTarget = Object.freeze({
      providerId,
      tenantId,
      targetSessionId: "fake-target-session",
      targetSessionExpiresAt: new Date("2026-08-13T07:00:00.000Z"),
    });
    const decision = evaluateAutonomousLedgerWrite({
      actionId: operation.actionId,
      canonicalPayloadHash: operation.canonicalPayloadHash,
      sourceRevisionHash: operation.sourceRevisionHash,
      caseVersion: operation.caseVersion,
      authoritySnapshotRevision: 1,
      authoritySnapshotHash: "e".repeat(64),
      principal,
      target,
      standingDelegations: [Object.freeze({
        delegationId: "fake-delegation",
        revision: 2,
        status: "ACTIVE",
        providerId,
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        installationId: principal.installationId,
        tenantIds: [tenantId],
        actionIds: [operation.actionId],
      })],
      writeKillSwitchEnabled: true,
      staticActionReleased: true,
      transportScopeAllowed: true,
      providerAccessDenyReasons: [],
      providerCapabilityReceiptHash: preflight.capabilityReceiptHash,
      validation: { passed: true, receiptHash: validation.receiptHash },
      now,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("fake provider kernel authority denied");

    const claims = expectedClaims(decision.receipt, operation);
    const issuePermit = () => issueLedgerProviderWritePermit({
      contract: fakePermitContract,
      adapterOperation,
      request: {
        mutationRequestId: claims.mutationRequestId,
        canonicalPayloadHash: operation.canonicalPayloadHash,
        authorizationReceipt: decision.receipt,
      },
    });

    expect(() => adapter.createDraft({ expectedClaims: claims, operation })).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(adapter.writeCount).toBe(0);

    for (const tampered of [
      { ...claims, providerId: "other-provider" },
      { ...claims, tenantId: "other-tenant" },
      { ...claims, canonicalPayloadHash: "e".repeat(64) },
    ]) {
      expect(() => adapter.createDraft({
        permit: issuePermit(),
        expectedClaims: Object.freeze(tampered),
        operation,
      })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
      expect(adapter.writeCount).toBe(0);
    }

    const permit = issuePermit();
    const created = adapter.createDraft({ permit, expectedClaims: claims, operation });
    expect(created.writeReceipt).toMatchObject({
      providerId,
      tenantId,
      payloadHash: operation.canonicalPayloadHash,
    });
    const exact = adapter.exactGet(tenantId, created.providerObjectId);
    expect(validateAccountingCaseReadbackEconomics(operation, readbackProjection(operation, exact), {
      applicability: "INVOICE_OR_BILL",
      providerStatus: "OPEN_DRAFT",
      providerDocumentType: "FAKEBOOKS_RECEIVABLE_DOCUMENT",
    })).toEqual({
      ok: true,
      applicability: "INVOICE_OR_BILL",
    });
    expect(adapter.exactGetCount).toBe(1);

    expect(() => adapter.createDraft({ permit, expectedClaims: claims, operation })).toThrow(
      expect.objectContaining({
        code: "FORBIDDEN",
        details: expect.objectContaining({ permitReason: "CONSUMED" }),
      }),
    );
    expect(adapter.writeCount).toBe(1);
  });

  it("lets a non-Xero policy own a three-minor-unit currency without changing the shared compiler", () => {
    const input = {
      caseId: "fakebooks-kwd-rounding",
      expectedVersion: 0,
      target: {
        tenantId,
        environment: "TEST",
        baseCurrency: "KWD",
        taxJurisdiction: "NLX",
        organisationStatus: "ACTIVE",
      },
      sources: [{
        artifactId: "kwd-source",
        label: "FakeBooks KWD source",
        units: [{ unitId: "kwd-unit", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
      }],
      facts: [{
        factId: "kwd-fact",
        lineageKey: "kwd-lineage",
        eventKey: "kwd-event",
        sourceUnitIds: ["kwd-unit"],
        origin: "MODEL_EXTRACTED",
        revision: 1,
        kind: "NATIVE_DOCUMENT",
        documentKind: "INVOICE",
        counterpartyRole: "CUSTOMER",
        reference: "FB-KWD-001",
        referenceKind: "FORMAL_DOCUMENT_NUMBER",
        documentDate: "2026-07-20",
        dueDate: "2026-08-20",
        currency: "KWD",
        contactName: "Lion City Digital Pte. Ltd.",
        taxPolicyBasis: "DOCUMENT_DATE_NON_TRANSITION",
        lineAmountType: "NO_TAX",
        lines: [{
          lineId: "kwd-line",
          description: "Three-minor-unit service",
          quantity: "1",
          unitAmount: "1.2345",
          sourceTax: "0",
          accountCode: "200",
          taxType: "NONE",
        }],
        declaredNet: "1.235",
        declaredTax: "0",
        declaredGross: "1.235",
        documentValidity: "TEST_OR_NOT_VALID",
      }],
    } satisfies PrepareAccountingCaseInput;

    const compiled = compileAccountingCase(input, fakeAccountingPolicy, fakeProviderContract);
    expect(compiled.status).toBe("PLANNED_NEEDS_PREFLIGHT");
    expect(compiled.policyProjection).toMatchObject({
      monetaryRules: { currencyMinorUnitScales: { KWD: 3 } },
    });
    expect(compiled.operations[0]?.canonicalPayload).toMatchObject({
      net: "1.2350",
      tax: "0.0000",
      gross: "1.2350",
      monetaryRule: {
        currency: "KWD",
        minorUnitScale: 3,
        roundingMode: "HALF_UP",
        taxAggregation: "PER_LINE",
      },
    });
  });

  it("compiles a real captured Xero invoice's own amounts through the shared, provider-neutral compiler", () => {
    // proves: the two tests above are the only economics this shared compiler
    // has ever been checked against, and both use numbers a test author chose
    // (1.2345, or SGD figures from the golden-14 fixture built for this
    // suite). This test's net/tax/gross/reference/dates/description come from
    // a real Xero AP bill instead - NW-8842, 2400.00 USD, NO_TAX - so a
    // regression that only broke on a genuinely real-world figure (as opposed
    // to a round number nobody would ever pick by hand) would be caught here.
    // Two fields cannot come from the real capture and are substituted with
    // this suite's own fake values instead, because they name fakebooks-only
    // vocabulary that has no real Xero counterpart: "200" (not Northwind's
    // real account code 425 - this policy's category map is its own opaque
    // scheme) and the contact name (swapped for one of this file's three
    // pre-resolved fakebooks contacts, since FakeBooksAdapter only recognizes
    // those three).
    const [realInvoice] = loadXeroResponse("invoice_accpay").invoices as Array<{
      invoiceNumber: string;
      date: Date;
      dueDate: Date;
      currencyCode: string;
      contact: { name: string };
      subTotal: number;
      totalTax: number;
      total: number;
      lineItems: Array<{ description: string; quantity: number; unitAmount: number; taxType: string }>;
    }>;
    const [realLine] = realInvoice.lineItems;
    expect(realInvoice.currencyCode).toBe("USD");
    expect(realLine.taxType).toBe("NONE");

    const input = {
      caseId: "fakebooks-real-xero-invoice",
      expectedVersion: 0,
      target: {
        tenantId,
        environment: "TEST",
        baseCurrency: realInvoice.currencyCode,
        taxJurisdiction: "NLX",
        organisationStatus: "ACTIVE",
      },
      sources: [{
        artifactId: "real-xero-invoice-source",
        label: "Real captured Xero invoice_accpay source",
        units: [{ unitId: "real-xero-invoice-unit", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
      }],
      facts: [{
        factId: "real-xero-invoice-fact",
        lineageKey: "real-xero-invoice-lineage",
        eventKey: "real-xero-invoice-event",
        sourceUnitIds: ["real-xero-invoice-unit"],
        origin: "MODEL_EXTRACTED",
        revision: 1,
        kind: "NATIVE_DOCUMENT",
        documentKind: "INVOICE",
        counterpartyRole: "SUPPLIER",
        reference: realInvoice.invoiceNumber,
        referenceKind: "FORMAL_DOCUMENT_NUMBER",
        documentDate: realInvoice.date.toISOString().slice(0, 10),
        dueDate: realInvoice.dueDate.toISOString().slice(0, 10),
        currency: realInvoice.currencyCode,
        contactName: "CloudHost Inc.",
        taxPolicyBasis: "DOCUMENT_DATE_NON_TRANSITION",
        lineAmountType: "NO_TAX",
        lines: [{
          lineId: "real-xero-invoice-line",
          description: realLine.description,
          quantity: String(realLine.quantity),
          unitAmount: String(realLine.unitAmount),
          sourceTax: "0",
          accountCode: "200",
          taxType: realLine.taxType,
        }],
        declaredNet: String(realInvoice.subTotal),
        declaredTax: String(realInvoice.totalTax),
        declaredGross: String(realInvoice.total),
        documentValidity: "TEST_OR_NOT_VALID",
      }],
    } satisfies PrepareAccountingCaseInput;

    const compiled = compileAccountingCase(input, fakeAccountingPolicy, fakeProviderContract);

    expect(compiled.status).toBe("PLANNED_NEEDS_PREFLIGHT");
    expect(compiled.operations[0]?.canonicalPayload).toMatchObject({
      net: "2400.0000",
      tax: "0.0000",
      gross: "2400.0000",
      monetaryRule: {
        currency: "USD",
        minorUnitScale: 2,
        roundingMode: "HALF_UP",
        taxAggregation: "PER_LINE",
      },
    });
  });

  it("keeps the control kernel independent from runtime provider adapters", () => {
    const sharedRoot = resolve(process.cwd(), "src/control-kernel");
    const repositoryRoot = process.cwd();
    const sharedFiles = transitiveSharedTypescriptFiles(typescriptFiles(sharedRoot));
    const relativeSharedFiles = sharedFiles.map((path) => relative(repositoryRoot, path));
    expect(relativeSharedFiles).toEqual(expect.arrayContaining([
      "src/control-kernel/accountingCaseCompiler.ts",
      "src/control-kernel/accountingCaseProviderContract.ts",
      "src/domain/accountingCase.ts",
      "src/domain/accountingCaseSchemas.ts",
    ]));
    // R1 is intentionally a single Xero Ledger Gateway, so the typed Case
    // domain may contain Xero action schemas and Xero-specific literals. The
    // boundary that still matters is runtime ownership: the deterministic
    // control kernel must not reach into the concrete provider adapter,
    // service, MCP, HTTP, or process-composition layers. The former
    // provider-neutral literal scan is a stale multi-provider architecture
    // gate and would reject the current frozen product shape.
    const forbiddenRuntimeImports = sharedFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(
        /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
      )].flatMap((match) => {
        const specifier = match[1];
        if (!specifier) return [];
        const isRuntimeLayer = /(?:^|\/)(?:providers|services|mcp|http|server)(?:\/|$)/u.test(specifier);
        return isRuntimeLayer ? [`${relative(repositoryRoot, path)} -> ${specifier}`] : [];
      });
    });
    expect(forbiddenRuntimeImports).toEqual([]);

    expect(readFileSync(resolve(process.cwd(), "src/services/xeroAccountingCaseService.ts"), "utf8"))
      .toContain("createXeroAccountingCaseProviderContract");
    expect(readFileSync(resolve(process.cwd(), "src/security/xeroProviderWritePermit.ts"), "utf8"))
      .toContain("issueLedgerProviderWritePermit");
    expect(readFileSync(resolve(process.cwd(), "src/db/inMemoryRepository.ts"), "utf8"))
      .toContain("validateXeroAccountingCaseReadbackEconomics");
    expect(readFileSync(resolve(process.cwd(), "src/db/postgresRepository.ts"), "utf8"))
      .toContain("validateXeroAccountingCaseReadbackEconomics");
  });
});
