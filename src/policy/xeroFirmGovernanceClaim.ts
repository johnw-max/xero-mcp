import type {
  LedgerFirmGovernanceClaim,
  LedgerStandingDelegation,
} from "../control-kernel/ledgerControlKernel.js";
import type { LedgerAuthoritySnapshot } from "../domain/ledgerAuthority.js";
import type {
  AccountingDocumentReferenceKind,
  NativeDocumentRoute,
} from "../domain/accountingCase.js";
import type { XeroMutationPreparation } from "../domain/xeroMutation.js";
import { AppError } from "../errors.js";
import { normalizeXeroBusinessReference, xeroDocumentCoordinateAuthority } from
  "./xeroBusinessCoordinateAuthority.js";

export interface XeroFirmGovernanceExpectation {
  readonly route: NativeDocumentRoute;
  readonly referenceKind: AccountingDocumentReferenceKind;
  readonly authoritativeProviderField: "INVOICE_NUMBER" | "CREDIT_NOTE_NUMBER" | "REFERENCE";
  readonly contactId?: string;
  readonly reference?: string;
  readonly recurringAuthorityId?: string;
  readonly recurringAuthorityRevision?: number;
}

function invalid(message: string): never {
  throw new AppError("APPROVAL_INVALID", message, {
    httpStatus: 409,
    retryable: false,
    details: {
      failureLayer: "XERO_FIRM_GOVERNANCE_AUTHORITY",
      providerMutationPossible: false,
    },
  });
}

function preparationProviderField(preparation: XeroMutationPreparation): string | undefined {
  const value = preparation.canonicalPayload.authoritative_provider_field ??
    preparation.canonicalPayload.authoritativeProviderField;
  return typeof value === "string" ? value : undefined;
}

function preparationRoute(preparation: XeroMutationPreparation): NativeDocumentRoute | undefined {
  if (preparation.objectType === "SUPPLIER_BILL") return "SUPPLIER_BILL";
  if (preparation.objectType === "SALES_INVOICE") return "SALES_INVOICE";
  if (preparation.objectType !== "CREDIT_NOTE") return undefined;
  const type = preparation.canonicalPayload.creditNoteType;
  if (type === "ACCRECCREDIT") return "CUSTOMER_CREDIT";
  if (type === "ACCPAYCREDIT") return "SUPPLIER_CREDIT";
  return undefined;
}

/**
 * Resolves whether this exact provider preparation needs externally signed
 * firm governance. Ambiguous AP reference kinds are never guessed.
 */
export function resolveXeroFirmGovernanceExpectation(
  preparation: XeroMutationPreparation,
  sealed?: XeroFirmGovernanceExpectation,
): XeroFirmGovernanceExpectation | undefined {
  const route = preparationRoute(preparation);
  if (!route) return undefined;
  const providerField = preparationProviderField(preparation);
  if (sealed) {
    const expected = xeroDocumentCoordinateAuthority(sealed.route, sealed.referenceKind);
    if (sealed.route !== route || sealed.authoritativeProviderField !== providerField ||
        expected.authoritativeProviderField !== sealed.authoritativeProviderField) {
      invalid("The sealed firm-governance coordinate does not match the provider preparation.");
    }
    return expected.uniquenessAuthority === "NON_UNIQUE_EXCLUSIVE_WRITER" ? sealed : undefined;
  }
  if (route === "SALES_INVOICE" && providerField === "INVOICE_NUMBER") return undefined;
  if (route === "CUSTOMER_CREDIT" && providerField === "CREDIT_NOTE_NUMBER") return undefined;
  invalid("This non-unique Xero coordinate lacks a sealed exact reference-kind authority.");
}

function exactDelegation(
  snapshot: LedgerAuthoritySnapshot,
  input: {
    actionId: string;
    tenantId: string;
    workspaceId: string;
    agentId: string;
    installationId: string;
  },
): LedgerStandingDelegation {
  const matches = snapshot.standingDelegations.filter((delegation) =>
    delegation.status === "ACTIVE" && delegation.firmGovernanceRequired === true &&
    delegation.providerId === "xero" && delegation.workspaceId === input.workspaceId &&
    delegation.agentId === input.agentId && delegation.installationId === input.installationId &&
    delegation.tenantIds.includes(input.tenantId) && delegation.actionIds.includes(input.actionId));
  if (matches.length !== 1) invalid("The exact Xero standing delegation is missing or ambiguous.");
  return matches[0]!;
}

export function selectXeroFirmGovernanceClaim(
  snapshot: LedgerAuthoritySnapshot,
  input: {
    actionId: string;
    tenantId: string;
    workspaceId: string;
    agentId: string;
    installationId: string;
    expectation: XeroFirmGovernanceExpectation;
  },
): LedgerFirmGovernanceClaim {
  const delegation = exactDelegation(snapshot, input);
  const matches = (delegation.firmGovernanceAuthorities ?? []).filter((authority) =>
    authority.providerId === "xero" && authority.tenantId.toLowerCase() === input.tenantId.toLowerCase() &&
    authority.route === input.expectation.route &&
    authority.referenceKind === input.expectation.referenceKind &&
    authority.authoritativeProviderField === input.expectation.authoritativeProviderField &&
    authority.workspaceId === input.workspaceId && authority.agentId === input.agentId &&
    authority.installationId === input.installationId && authority.writerId === delegation.writerId &&
    authority.coordinationDomainId === delegation.coordinationDomainId);
  if (matches.length !== 1) invalid("The durable snapshot lacks one exact firm-governance coordinate.");
  const selected = matches[0]!;
  if (!delegation.firmGovernanceRequirements?.some((requirement) =>
    requirement.actionId === input.actionId && requirement.route === input.expectation.route &&
    requirement.referenceKind === input.expectation.referenceKind &&
    requirement.authoritativeProviderField === input.expectation.authoritativeProviderField)) {
    invalid("The durable snapshot does not bind this action to the exact firm-governance coordinate.");
  }
  let recurringSeriesAuthority;
  if (input.expectation.referenceKind === "GENERIC_RECURRING_REFERENCE") {
    if (!input.expectation.contactId || !input.expectation.reference) {
      invalid("The generic reference lacks an exact recurring-series coordinate.");
    }
    const normalizedReference = normalizeXeroBusinessReference(input.expectation.reference);
    const recurring = selected.recurringSeriesAuthorities.filter((authority) =>
      authority.route === input.expectation.route &&
      authority.contactId.toLowerCase() === input.expectation.contactId!.toLowerCase() &&
      authority.normalizedReference === normalizedReference &&
      (input.expectation.recurringAuthorityId === undefined ||
        authority.authorityId === input.expectation.recurringAuthorityId) &&
      (input.expectation.recurringAuthorityRevision === undefined ||
        authority.revision === input.expectation.recurringAuthorityRevision));
    if (recurring.length !== 1) invalid("The durable snapshot lacks one exact recurring-series authority.");
    recurringSeriesAuthority = recurring[0]!;
  }
  const { recurringSeriesAuthorities: _series, ...claim } = selected;
  const authorityEffectiveExpiresAt = claim.effectiveExpiresAt.toISOString();
  const delegationExpiresAt = delegation.expiresAt?.toISOString() ?? null;
  const effectiveExpiresAt = delegation.expiresAt && delegation.expiresAt < claim.effectiveExpiresAt
    ? delegation.expiresAt.toISOString()
    : authorityEffectiveExpiresAt;
  return Object.freeze({
    ...claim,
    actionId: input.actionId,
    delegationId: delegation.delegationId,
    delegationRevision: delegation.revision,
    delegationExpiresAt,
    authorityEffectiveExpiresAt,
    effectiveExpiresAt,
    firmGovernanceStatement: Object.freeze({ ...claim.firmGovernanceStatement }),
    ...(recurringSeriesAuthority
      ? { recurringSeriesAuthority: Object.freeze({ ...recurringSeriesAuthority }) }
      : {}),
  });
}
