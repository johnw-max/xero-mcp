import type {
  AccountingCaseTarget,
  AccountingTaxSemantics,
  ContactCandidateFact,
  NativeDocumentFact,
  NativeDocumentRoute,
} from "../domain/accountingCase.js";

/**
 * Provider-owned facts that the shared compiler may seal into a proposal.
 * The compiler treats these values as opaque, canonical fields: it never
 * interprets a provider ID, SDK type, or provider-specific route limitation.
 */
export interface AccountingCaseProviderContactBinding {
  readonly resolvedId?: string;
  readonly canonicalFields: Readonly<Record<string, unknown>>;
}

export interface AccountingCaseProviderRouteDecision {
  readonly route: NativeDocumentRoute;
  readonly adapterCanPrepare: boolean;
  readonly reasonCodes: readonly string[];
}

export interface AccountingCaseProviderTaxBinding {
  readonly documentFields: Readonly<Record<string, unknown>>;
  readonly lineFields: Readonly<Record<string, unknown>>;
}

/**
 * Provider-owned binding from a policy semantic category to one tenant-local
 * ledger account. The shared compiler seals but never interprets the provider
 * account ID/code or profile metadata.
 */
export interface AccountingCaseProviderCategoryBinding {
  readonly canonicalFields: Readonly<Record<string, unknown>>;
  readonly bindingProjection: Readonly<Record<string, unknown>>;
  readonly reasonCodes: readonly string[];
}

export interface AccountingCaseProviderNativeDocumentBounds {
  readonly maxLines: number;
  readonly maxQuantity: string;
  readonly maxUnitAmount: string;
  readonly maxEnteredLineAmount: string;
}

export interface AccountingCaseProviderCapabilityBounds {
  readonly schemaVersion: string;
  readonly nativeDocuments: Readonly<Record<NativeDocumentRoute, AccountingCaseProviderNativeDocumentBounds>>;
  readonly contact: Readonly<{
    maxNameLength: number;
    maxEmailLength: number;
    maxCompanyNumberLength: number;
    maxAccountNumberLength: number;
    maxDurableIdentityNumberLength: number;
  }>;
}

/**
 * Provider-owned collision identity for one prospective ledger object.
 *
 * This is deliberately separate from the canonical payload hash.  The
 * payload protects exact replay, while this projection reserves the stable
 * provider business coordinate (for example a resolved contact plus a dated
 * document reference) across Case IDs and versions.  The shared kernel never
 * interprets these fields.
 */
export interface AccountingCaseProviderBusinessIdentity {
  readonly kind: string;
  readonly canonicalFields: Readonly<Record<string, unknown>>;
  /**
   * Stable provider coordinate used for cross-Case collision claims.
   * Provider resolution evidence must not change these fields after the same
   * provider object has been resolved.
   */
  readonly reservation: Readonly<{
    kind: string;
    canonicalFields: Readonly<Record<string, unknown>>;
  } & (
    | { scope: "ALL_OCCURRENCES" }
    | { scope: "DATED_OCCURRENCE"; occurrenceDate: string }
  )>;
}

/**
 * Provider-neutral outcome of an exhaustive business-coordinate history read.
 * Only NONE can proceed to a create decision. EXACT_ONE is an existing object
 * decision whose exact GET still has to match the sealed Case economics.
 */
export type AccountingCaseProviderBusinessHistoryLookup =
  | Readonly<{ state: "NONE"; checkedObjectCount: number; complete: true }>
  | Readonly<{
      state: "EXACT_ONE";
      checkedObjectCount: number;
      complete: true;
      providerObjectId: string;
      canonicalEconomicMatch: boolean;
      mismatchReasons: readonly string[];
      exactReadback: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      state: "AMBIGUOUS";
      checkedObjectCount: number;
      complete: true;
      providerObjectIds: readonly string[];
    }>
  | Readonly<{
      state: "INCOMPLETE";
      checkedObjectCount: number;
      complete: false;
      reasonCodes: readonly string[];
    }>;

/**
 * Composition contract between the provider-neutral Accounting Case compiler
 * and one independently deployed ledger MCP. Every provider supplies its own
 * route/capability policy and reference projection at the composition root.
 */
export interface AccountingCaseProviderEnforcementContract {
  readonly providerId: string;
  readonly contractVersion: string;
  readonly routeContractVersion: string;
  readonly unresolvedContactReasonCode: string;
  /** Versioned provider limits sealed into the provider projection and source hash. */
  readonly capabilityBounds: AccountingCaseProviderCapabilityBounds;
  /** Deterministic provider-owned context sealed into source and plan hashes. */
  readonly planProjection: Readonly<Record<string, unknown>>;
  evaluateNativeRoute(
    fact: NativeDocumentFact,
    target: AccountingCaseTarget,
  ): AccountingCaseProviderRouteDecision;
  contactBinding(
    fact: ContactCandidateFact | NativeDocumentFact,
  ): AccountingCaseProviderContactBinding;
  taxBinding(
    fact: NativeDocumentFact,
    semantics: AccountingTaxSemantics,
  ): AccountingCaseProviderTaxBinding;
  accountingCategoryBinding(
    fact: NativeDocumentFact,
    accountingCategory: string,
    taxSemantics: AccountingTaxSemantics,
  ): AccountingCaseProviderCategoryBinding;
  businessIdentity(
    fact: ContactCandidateFact | NativeDocumentFact,
    target: AccountingCaseTarget,
  ): AccountingCaseProviderBusinessIdentity;
}
