import { z } from "zod/v4";
import type {
  AccountingCaseOperation,
  ContactDurableIdentity,
  AccountingFact,
  AccountingTaxSemantics,
  ContactCandidateFact,
  NativeDocumentFact,
} from "../domain/accountingCase.js";
import { ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION } from "../domain/accountingCase.js";
import {
  accountingFactSchema,
  prepareAccountingCaseSchema,
  type PrepareAccountingCaseInput,
} from "../domain/accountingCaseSchemas.js";
import {
  compileAccountingCase,
  validateCompiledOperationAgainstSource,
} from "../control-kernel/accountingCaseCompiler.js";
import type { AccountingCaseProviderEnforcementContract } from "../control-kernel/accountingCaseProviderContract.js";
import type { AccountingCaseProviderCapabilityBounds } from "../control-kernel/accountingCaseProviderContract.js";
import {
  createXeroDeclaredLedgerPolicy,
  createXeroDeclaredLedgerPolicyFromProjection,
  XERO_DECLARED_LEDGER_POLICY_VERSION,
} from "./xeroDeclaredLedgerPolicy.js";
import {
  evaluateXeroNativeRouteContract,
  XERO_NATIVE_ROUTE_CONTRACT_VERSION,
} from "./xeroNativeRouteContract.js";
import {
  XERO_CONTACT_IDENTITY_CONTRACT_VERSION,
  type XeroContactIdentityDecision,
} from "./xeroContactIdentity.js";
import { hashObject } from "../security/hash.js";
import {
  parseXeroDeclaredLedgerBinding,
  requireXeroDeclaredLedgerAccount,
  type XeroDeclaredLedgerBinding,
} from "./xeroDeclaredLedgerBinding.js";
import {
  findTrustedXeroRecurringSeriesAuthority,
  normalizeXeroBusinessReference,
  parseXeroAccountingCaseBusinessAuthorityProjection,
  projectXeroAccountingCaseBusinessAuthority,
  xeroDocumentCoordinateAuthority,
  xeroAccountingCaseBusinessAuthorityProjectionSchema,
  XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION,
  type XeroAccountingCaseBusinessAuthorityProfile,
  type XeroAccountingCaseBusinessAuthorityProjection,
} from "./xeroBusinessCoordinateAuthority.js";

export const XERO_ACCOUNTING_CASE_POLICY_VERSION = XERO_DECLARED_LEDGER_POLICY_VERSION;
export const XERO_ACCOUNTING_CASE_PROVIDER_CONTRACT_VERSION = "xero-accounting-case-provider-v14";
export const XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION =
  "xero-accounting-case-provider-projection:v9";

const durableContactIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("LEGAL_REGISTRY"),
    jurisdiction: z.string().min(1),
    registryScheme: z.string().min(1),
    number: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("PROVIDER_TENANT_ACCOUNT"),
    providerId: z.string().min(1),
    namespace: z.string().min(1),
    number: z.string().min(1),
  }).strict(),
]);

const contactIdentityEvidenceSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  durableIdentity: durableContactIdentitySchema.optional(),
  companyNumber: z.string().optional(),
  accountNumber: z.string().optional(),
}).strict();

const xeroContactIdentitySchema = z.object({
  contractVersion: z.literal(XERO_CONTACT_IDENTITY_CONTRACT_VERSION),
  policy: z.enum(["TYPED_DURABLE_IDENTITY", "CANDIDATE_COLLISION_ONLY"]),
  contactId: z.string().uuid(),
  requested: contactIdentityEvidenceSchema,
  verified: contactIdentityEvidenceSchema,
}).strict();

const xeroContactBindingSchema = z.object({
  contactId: z.string().uuid(),
  identity: xeroContactIdentitySchema.optional(),
}).strict().superRefine((binding, context) => {
  if (binding.identity && binding.identity.contactId !== binding.contactId) {
    context.addIssue({
      code: "custom",
      path: ["identity", "contactId"],
      message: "contact identity decision must name the same Xero contact",
    });
  }
});

export const XERO_ORIGINAL_TRANSACTION_BINDING_VERSION =
  "xero-original-transaction-binding:v2" as const;

const xeroOriginalTransactionBindingSchema = z.object({
  schemaVersion: z.literal(XERO_ORIGINAL_TRANSACTION_BINDING_VERSION),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  providerObjectId: z.string().uuid(),
  originalRoute: z.enum(["SALES_INVOICE", "SUPPLIER_BILL"]),
  sourceSnapshotSealHash: z.string().regex(/^[a-f0-9]{64}$/u),
  lookupReceiptHash: z.string().regex(/^[a-f0-9]{64}$/u),
  checkedObjectCount: z.number().int().min(1),
}).strict();

export type XeroOriginalTransactionBinding = Readonly<z.infer<
  typeof xeroOriginalTransactionBindingSchema
>>;

export type XeroOriginalTransactionBindings = ReadonlyMap<
  string,
  XeroOriginalTransactionBinding
>;

export const XERO_ACCOUNTING_CASE_CAPABILITY_BOUNDS_VERSION =
  "xero-accounting-case-capability-bounds:v1";

const nativeDocumentBoundsSchema = z.object({
  maxLines: z.number().int().positive(),
  maxQuantity: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u),
  maxUnitAmount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u),
  maxEnteredLineAmount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/u),
}).strict();

const capabilityBoundsSchema = z.object({
  schemaVersion: z.literal(XERO_ACCOUNTING_CASE_CAPABILITY_BOUNDS_VERSION),
  nativeDocuments: z.object({
    SALES_INVOICE: nativeDocumentBoundsSchema,
    SUPPLIER_BILL: nativeDocumentBoundsSchema,
    CUSTOMER_CREDIT: nativeDocumentBoundsSchema,
    SUPPLIER_CREDIT: nativeDocumentBoundsSchema,
  }).strict(),
  contact: z.object({
    maxNameLength: z.number().int().positive(),
    maxEmailLength: z.number().int().positive(),
    maxCompanyNumberLength: z.number().int().positive(),
    maxAccountNumberLength: z.number().int().positive(),
    maxDurableIdentityNumberLength: z.number().int().positive(),
  }).strict(),
}).strict();

const xeroNativeDocumentBounds = Object.freeze({
  maxLines: 20,
  maxQuantity: "1000000",
  maxUnitAmount: "1000000000",
  maxEnteredLineAmount: "900000000000",
});

export const XERO_ACCOUNTING_CASE_CAPABILITY_BOUNDS = Object.freeze({
  schemaVersion: XERO_ACCOUNTING_CASE_CAPABILITY_BOUNDS_VERSION,
  nativeDocuments: Object.freeze({
    SALES_INVOICE: xeroNativeDocumentBounds,
    SUPPLIER_BILL: xeroNativeDocumentBounds,
    CUSTOMER_CREDIT: xeroNativeDocumentBounds,
    SUPPLIER_CREDIT: xeroNativeDocumentBounds,
  }),
  contact: Object.freeze({
    maxNameLength: 255,
    maxEmailLength: 255,
    maxCompanyNumberLength: 50,
    maxAccountNumberLength: 50,
    maxDurableIdentityNumberLength: 50,
  }),
}) satisfies AccountingCaseProviderCapabilityBounds;

const xeroProviderProjectionSchema = z.object({
  schemaVersion: z.literal(XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION),
  contactBindings: z.record(z.string().min(1), xeroContactBindingSchema),
  originalTransactionBindings: z.record(
    z.string().regex(/^[a-f0-9]{64}$/u),
    xeroOriginalTransactionBindingSchema,
  ),
  ledgerBinding: z.unknown(),
  capabilityBounds: capabilityBoundsSchema,
  businessAuthority: xeroAccountingCaseBusinessAuthorityProjectionSchema,
}).strict();

export interface XeroAccountingCaseContactBinding {
  readonly contactId: string;
  readonly identity?: XeroContactIdentityDecision;
}

export type XeroAccountingCaseContactBindings = ReadonlyMap<
  string,
  XeroAccountingCaseContactBinding
>;

function normalizedBinding(binding: XeroAccountingCaseContactBinding): XeroAccountingCaseContactBinding {
  const parsed = xeroContactBindingSchema.parse(binding);
  return Object.freeze({
    contactId: parsed.contactId,
    ...(parsed.identity
      ? { identity: Object.freeze(structuredClone(parsed.identity)) as XeroContactIdentityDecision }
      : {}),
  });
}

function providerProjection(
  bindings: XeroAccountingCaseContactBindings,
  ledgerBinding: XeroDeclaredLedgerBinding,
  capabilityBounds: AccountingCaseProviderCapabilityBounds,
  businessAuthority: XeroAccountingCaseBusinessAuthorityProjection,
  originalTransactionBindings: XeroOriginalTransactionBindings,
): Readonly<Record<string, unknown>> {
  const contactBindings = Object.fromEntries(
    [...bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([factId, binding]) => [factId, normalizedBinding(binding)]),
  );
  const sealedOriginalTransactionBindings = Object.fromEntries(
    [...originalTransactionBindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([evidenceHash, binding]) => {
        const parsed = xeroOriginalTransactionBindingSchema.parse(binding);
        if (evidenceHash !== parsed.evidenceHash) {
          throw new Error("Original-transaction binding key does not match its evidence hash.");
        }
        return [evidenceHash, Object.freeze(parsed)];
      }),
  );
  return Object.freeze({
    schemaVersion: XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
    contactBindings: Object.freeze(contactBindings),
    originalTransactionBindings: Object.freeze(sealedOriginalTransactionBindings),
    ledgerBinding: parseXeroDeclaredLedgerBinding(ledgerBinding),
    capabilityBounds: capabilityBoundsSchema.parse(capabilityBounds),
    businessAuthority: parseXeroAccountingCaseBusinessAuthorityProjection(businessAuthority),
  });
}

function normalizedBusinessText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function contactDurableBusinessProjection(identity: ContactDurableIdentity) {
  return identity.kind === "LEGAL_REGISTRY"
    ? Object.freeze({
        kind: "LEGAL_REGISTRY_CONTACT",
        canonicalFields: Object.freeze({
          jurisdiction: normalizedBusinessText(identity.jurisdiction).toLocaleUpperCase("en"),
          registryScheme: normalizedBusinessText(identity.registryScheme).toLocaleUpperCase("en"),
          number: normalizedBusinessText(identity.number).toLocaleUpperCase("en"),
        }),
      })
    : Object.freeze({
        kind: "PROVIDER_TENANT_CONTACT_ACCOUNT",
        canonicalFields: Object.freeze({
          providerId: normalizedBusinessText(identity.providerId).toLocaleLowerCase("en"),
          namespace: normalizedBusinessText(identity.namespace).toLocaleUpperCase("en"),
          number: normalizedBusinessText(identity.number).toLocaleUpperCase("en"),
        }),
      });
}

function contactBareNumberReservationProjection(identity: ContactDurableIdentity) {
  return Object.freeze({
    kind: "PROVIDER_CONTACT_BARE_NUMBER",
    canonicalFields: Object.freeze({
      fieldKind: identity.kind === "LEGAL_REGISTRY" ? "COMPANY_NUMBER" : "ACCOUNT_NUMBER",
      number: normalizedBusinessText(identity.number).toLocaleUpperCase("en"),
    }),
  });
}

export function xeroContactDurableBusinessIdentityHash(identity: ContactDurableIdentity): string {
  const projection = contactDurableBusinessProjection(identity);
  return hashObject({
    schemaVersion: ACCOUNTING_CASE_BUSINESS_IDENTITY_SCHEMA_VERSION,
    providerId: "xero",
    kind: projection.kind,
    canonicalFields: projection.canonicalFields,
  });
}

function bindingsFromProjection(
  projection: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, XeroAccountingCaseContactBinding> {
  const parsed = xeroProviderProjectionSchema.parse(projection);
  return new Map(
    Object.entries(parsed.contactBindings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([factId, binding]) => [factId, normalizedBinding({
        contactId: binding.contactId,
        ...(binding.identity ? { identity: binding.identity as XeroContactIdentityDecision } : {}),
      })]),
  );
}

export function xeroDeclaredLedgerBindingFromProviderProjection(
  projection: Readonly<Record<string, unknown>>,
): XeroDeclaredLedgerBinding {
  return parseXeroDeclaredLedgerBinding(xeroProviderProjectionSchema.parse(projection).ledgerBinding);
}

/** Builds the Xero composition root around an immutable provider-owned binding projection. */
export function createXeroAccountingCaseProviderContract(
  bindings: XeroAccountingCaseContactBindings,
  ledgerBinding: XeroDeclaredLedgerBinding,
  capabilityBounds: AccountingCaseProviderCapabilityBounds = XERO_ACCOUNTING_CASE_CAPABILITY_BOUNDS,
  businessAuthority?: XeroAccountingCaseBusinessAuthorityProfile | XeroAccountingCaseBusinessAuthorityProjection,
  originalTransactionBindings: XeroOriginalTransactionBindings = new Map(),
): AccountingCaseProviderEnforcementContract {
  const authorityProjection = businessAuthority && "schemaVersion" in businessAuthority
    ? parseXeroAccountingCaseBusinessAuthorityProjection(businessAuthority)
    : projectXeroAccountingCaseBusinessAuthority(ledgerBinding.tenantId, businessAuthority);
  const projection = providerProjection(
    bindings,
    ledgerBinding,
    capabilityBounds,
    authorityProjection,
    originalTransactionBindings,
  );
  const sealedBindings = bindingsFromProjection(projection);
  const sealedLedgerBinding = parseXeroDeclaredLedgerBinding(ledgerBinding);
  const sealedCapabilityBounds = capabilityBoundsSchema.parse(capabilityBounds);
  const sealedBusinessAuthority = parseXeroAccountingCaseBusinessAuthorityProjection(
    xeroProviderProjectionSchema.parse(projection).businessAuthority,
  );
  return Object.freeze({
    providerId: "xero",
    contractVersion: XERO_ACCOUNTING_CASE_PROVIDER_CONTRACT_VERSION,
    routeContractVersion: XERO_NATIVE_ROUTE_CONTRACT_VERSION,
    unresolvedContactReasonCode: "EXACT_XERO_CONTACT_REQUIRED",
    capabilityBounds: Object.freeze(structuredClone(sealedCapabilityBounds)),
    planProjection: projection,
    evaluateNativeRoute: evaluateXeroNativeRouteContract,
    contactBinding(fact: ContactCandidateFact | NativeDocumentFact) {
      const binding = sealedBindings.get(fact.factId);
      return Object.freeze({
        ...(binding ? { resolvedId: binding.contactId } : {}),
        canonicalFields: Object.freeze({
          ...(binding ? { xeroContactId: binding.contactId } : {}),
          ...(binding?.identity ? { xeroContactIdentity: binding.identity } : {}),
        }),
      });
    },
    // The declared TaxType passes through unchanged. There is no semantics ->
    // provider tax-code mapping table left in this adapter.
    taxBinding(_fact: NativeDocumentFact, semantics: AccountingTaxSemantics) {
      return Object.freeze({
        documentFields: Object.freeze({ taxType: semantics }),
        lineFields: Object.freeze({ taxType: semantics }),
      });
    },
    // `declaredAccountCode` is the opaque carrier the policy filled with the
    // caller-declared Xero account code; it resolves against the live
    // chart-of-accounts binding sealed into this projection.
    accountingCategoryBinding(
      _fact: NativeDocumentFact,
      declaredAccountCode: string,
      _taxSemantics: AccountingTaxSemantics,
    ) {
      const account = requireXeroDeclaredLedgerAccount(sealedLedgerBinding, declaredAccountCode);
      const bindingProjection = Object.freeze({
        schemaVersion: "xero-declared-ledger-account-binding:v1",
        bindingHash: sealedLedgerBinding.bindingHash,
        tenantId: sealedLedgerBinding.tenantId,
        accountId: account.accountId,
        accountCode: account.accountCode,
        expectedType: account.accountType,
        expectedClass: account.accountClass,
        ...(account.accountName ? { expectedName: account.accountName } : {}),
      });
      return Object.freeze({
        canonicalFields: Object.freeze({
          accountId: account.accountId,
          accountCode: account.accountCode,
        }),
        bindingProjection,
        reasonCodes: [],
      });
    },
    businessIdentity(
      fact: ContactCandidateFact | NativeDocumentFact,
      target: import("../domain/accountingCase.js").AccountingCaseTarget,
    ) {
      if (fact.kind === "CONTACT_CANDIDATE") {
        const strong = fact.durableIdentity
          ? contactDurableBusinessProjection(fact.durableIdentity)
          : {
                // Xero requires a unique display name. Bare company/account
                // numbers, email and name remain collision signals; none can
                // be promoted into a legal identity without an issuer/scope.
                kind: "PROVIDER_CONTACT_DISPLAY_NAME_COLLISION",
                canonicalFields: {
                  name: normalizedBusinessText(fact.name).toLocaleLowerCase("en"),
                },
              };
        const reservation = fact.durableIdentity
          ? contactBareNumberReservationProjection(fact.durableIdentity)
          : strong;
        return Object.freeze({
          kind: strong.kind,
          canonicalFields: Object.freeze(strong.canonicalFields),
          reservation: Object.freeze({
            kind: reservation.kind,
            canonicalFields: Object.freeze(reservation.canonicalFields),
            scope: "ALL_OCCURRENCES",
          }),
        });
      }
      const binding = sealedBindings.get(fact.factId);
      // The resolved provider contact is the one canonical counterparty key.
      // A typed tuple is resolution evidence and may be present in the sealed
      // payload, but it must never create a second reservation namespace for
      // the same already-resolved provider object.
      const route = evaluateXeroNativeRouteContract(fact, target).route;
      const contactId = binding?.contactId ?? null;
      const coordinateAuthority = xeroDocumentCoordinateAuthority(route, fact.referenceKind);
      const recurringAuthority = binding && fact.referenceKind === "GENERIC_RECURRING_REFERENCE"
        ? findTrustedXeroRecurringSeriesAuthority(sealedBusinessAuthority, {
            route,
            contactId: binding.contactId,
            reference: fact.reference,
          })
        : undefined;
      const canonicalCoordinate = {
        route,
        referenceKind: fact.referenceKind,
        authoritativeProviderField: coordinateAuthority.authoritativeProviderField,
        uniquenessAuthority: coordinateAuthority.uniquenessAuthority,
        normalizationVersion: XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION,
        reference: normalizeXeroBusinessReference(fact.reference),
        ...(coordinateAuthority.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER"
          ? { contactId }
          : {}),
      };
      return Object.freeze({
        kind: "LEDGER_DOCUMENT_OCCURRENCE",
        canonicalFields: Object.freeze({
          ...canonicalCoordinate,
          contactId,
          ...(recurringAuthority
            ? {
                documentDate: fact.documentDate,
                recurringSeriesAuthority: Object.freeze({
                  authorityId: recurringAuthority.authorityId,
                  revision: recurringAuthority.revision,
                  occurrenceKey: recurringAuthority.occurrenceKey,
                  verificationReceiptSha256: recurringAuthority.verificationReceiptSha256,
                }),
              }
            : {}),
        }),
        reservation: Object.freeze({
          kind: "LEDGER_DOCUMENT_OCCURRENCE",
          canonicalFields: Object.freeze(canonicalCoordinate),
          ...(recurringAuthority
            ? { scope: "DATED_OCCURRENCE", occurrenceDate: fact.documentDate }
            : { scope: "ALL_OCCURRENCES" }),
        }),
      });
    },
  });
}

/** Rehydrates only the Xero adapter contract from the opaque durable projection. */
export function createXeroAccountingCaseProviderContractFromProjection(
  projection: Readonly<Record<string, unknown>>,
): AccountingCaseProviderEnforcementContract {
  const parsed = xeroProviderProjectionSchema.parse(projection);
  return createXeroAccountingCaseProviderContract(
    bindingsFromProjection(projection),
    parseXeroDeclaredLedgerBinding(parsed.ledgerBinding),
    parsed.capabilityBounds,
    parsed.businessAuthority,
    new Map(Object.entries(parsed.originalTransactionBindings)),
  );
}

export function xeroOriginalTransactionBindingFromProviderProjection(
  projection: Readonly<Record<string, unknown>>,
  evidenceHash: string,
): XeroOriginalTransactionBinding {
  const parsed = xeroProviderProjectionSchema.parse(projection);
  const binding = parsed.originalTransactionBindings[evidenceHash];
  if (!binding || binding.evidenceHash !== evidenceHash) {
    throw new Error("The Xero provider projection has no exact original-transaction binding.");
  }
  return Object.freeze(structuredClone(binding));
}

function legacyBindingFromRecord(record: Record<string, unknown>): XeroAccountingCaseContactBinding | undefined {
  const contactId = record.xeroContactId;
  const identity = record.xeroContactIdentity;
  if (contactId === undefined && identity === undefined) return undefined;
  return normalizedBinding({
    contactId: z.string().uuid().parse(contactId),
    ...(identity !== undefined
      ? { identity: xeroContactIdentitySchema.parse(identity) as XeroContactIdentityDecision }
      : {}),
  });
}

/**
 * Compatibility projection for internal Xero fixtures. Provider-native fields
 * are removed before the shared schema/compiler sees the facts.
 */
export function projectXeroAccountingCaseCompilerInput(raw: unknown): Readonly<{
  input: PrepareAccountingCaseInput;
  contactBindings: XeroAccountingCaseContactBindings;
  paysTax: boolean;
}> {
  const copy = structuredClone(raw) as unknown;
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
    return {
      input: prepareAccountingCaseSchema.parse(copy),
      contactBindings: new Map(),
      paysTax: false,
    };
  }
  const candidate = copy as Record<string, unknown>;
  const rawTarget = candidate.target;
  let paysTax = false;
  if (rawTarget && typeof rawTarget === "object" && !Array.isArray(rawTarget)) {
    const target = rawTarget as Record<string, unknown>;
    paysTax = z.boolean().parse(target.paysTax);
    const { paysTax: _paysTax, ...sharedTarget } = target;
    candidate.target = sharedTarget;
  }
  const bindings = new Map<string, XeroAccountingCaseContactBinding>();
  if (Array.isArray(candidate.facts)) {
    candidate.facts = candidate.facts.map((rawFact) => {
      if (!rawFact || typeof rawFact !== "object" || Array.isArray(rawFact)) return rawFact;
      const fact = rawFact as Record<string, unknown>;
      const binding = legacyBindingFromRecord(fact);
      if (binding) bindings.set(z.string().min(1).parse(fact.factId), binding);
      const { xeroContactId: _contactId, xeroContactIdentity: _identity, ...sharedFact } = fact;
      return sharedFact;
    });
  }
  return Object.freeze({
    input: prepareAccountingCaseSchema.parse(candidate),
    contactBindings: bindings,
    paysTax,
  });
}

/** Convenience entry point for Xero-only callers and internal fixtures. */
export function compileXeroAccountingCase(raw: unknown, ledgerBinding: XeroDeclaredLedgerBinding) {
  const projected = projectXeroAccountingCaseCompilerInput(raw);
  return compileAccountingCase(
    projected.input,
    createXeroDeclaredLedgerPolicy({
      jurisdiction: projected.input.target.taxJurisdiction,
      paysTax: projected.paysTax,
      ledgerBinding,
    }),
    createXeroAccountingCaseProviderContract(projected.contactBindings, ledgerBinding),
  );
}

/** Convenience source revalidation entry point for Xero-only fixture callers. */
export function validateXeroCompiledOperationAgainstSource(
  operation: AccountingCaseOperation,
  rawSourceFact: NativeDocumentFact,
  policyProjection: Readonly<Record<string, unknown>>,
  ledgerBinding: XeroDeclaredLedgerBinding,
) {
  const raw = structuredClone(rawSourceFact) as unknown as Record<string, unknown>;
  const binding = legacyBindingFromRecord(raw) ?? legacyBindingFromRecord(operation.canonicalPayload);
  const { xeroContactId: _contactId, xeroContactIdentity: _identity, ...sharedSource } = raw;
  const parsed = accountingFactSchema.parse(sharedSource) as AccountingFact;
  if (parsed.kind !== "NATIVE_DOCUMENT") throw new Error("Xero source projection is not a native document");
  const bindings = new Map<string, XeroAccountingCaseContactBinding>();
  if (binding) bindings.set(parsed.factId, binding);
  return validateCompiledOperationAgainstSource(
    operation,
    parsed,
    createXeroDeclaredLedgerPolicyFromProjection(policyProjection),
    createXeroAccountingCaseProviderContract(bindings, ledgerBinding),
  );
}
