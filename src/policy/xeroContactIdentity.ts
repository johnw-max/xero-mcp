import type { ContactSummary } from "../providers/types.js";
import type { ContactDurableIdentity } from "../domain/accountingCase.js";

export const XERO_CONTACT_IDENTITY_CONTRACT_VERSION = "xero-contact-identity-v3";

export type XeroContactIdentityPolicy =
  | "TYPED_DURABLE_IDENTITY"
  | "CANDIDATE_COLLISION_ONLY";

export type XeroContactIdentityEvidence = Readonly<{
  name: string;
  email?: string;
  durableIdentity?: ContactDurableIdentity;
  companyNumber?: string;
  accountNumber?: string;
}>;

export type XeroContactIdentityDecision = Readonly<{
  contractVersion: typeof XERO_CONTACT_IDENTITY_CONTRACT_VERSION;
  policy: XeroContactIdentityPolicy;
  contactId: string;
  requested: XeroContactIdentityEvidence;
  verified: XeroContactIdentityEvidence;
}>;

/**
 * Xero exposes only a bare company/account number. A matching provider value
 * proves continuity of that bare field, not the caller-supplied jurisdiction,
 * registry scheme, or account namespace. The durable registry can therefore
 * reuse only the exact tuple that this server previously bound; it never
 * upgrades MODEL_EXTRACTED identity data into external source truth.
 */
export type XeroContactNamespaceContinuityEvidence = Readonly<{
  providerEvidence: "BARE_NUMBER_MATCH";
  serverTupleContinuity: "EXACT_REGISTERED_TUPLE" | "NO_EXACT_REGISTERED_TUPLE";
  externalNamespaceAuthority: "UNVERIFIED";
  sourceTruth: "UNVERIFIED";
}>;

export function xeroContactNamespaceContinuityEvidence(input: Readonly<{
  requestedBusinessIdentityHash: string;
  registeredBusinessIdentityHashes: readonly string[];
}>): XeroContactNamespaceContinuityEvidence {
  return Object.freeze({
    providerEvidence: "BARE_NUMBER_MATCH",
    serverTupleContinuity: input.registeredBusinessIdentityHashes.includes(
      input.requestedBusinessIdentityHash,
    )
      ? "EXACT_REGISTERED_TUPLE"
      : "NO_EXACT_REGISTERED_TUPLE",
    externalNamespaceAuthority: "UNVERIFIED",
    sourceTruth: "UNVERIFIED",
  });
}

export type XeroContactIdentityMismatchReason =
  | "XERO_CONTACT_IDENTITY_NAME_MISMATCH"
  | "XERO_CONTACT_IDENTITY_STATUS_NOT_ACTIVE"
  | "XERO_CONTACT_IDENTITY_EMAIL_MISSING"
  | "XERO_CONTACT_IDENTITY_EMAIL_CONFLICT"
  | "XERO_CONTACT_IDENTITY_COMPANY_NUMBER_MISSING"
  | "XERO_CONTACT_IDENTITY_COMPANY_NUMBER_CONFLICT"
  | "XERO_CONTACT_IDENTITY_ACCOUNT_NUMBER_MISSING"
  | "XERO_CONTACT_IDENTITY_ACCOUNT_NUMBER_CONFLICT";

function canonicalText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function canonicalIdentifier(value: string): string {
  return canonicalText(value).toLocaleLowerCase("en");
}

function optionalCanonicalIdentifier(value: string | undefined): string | undefined {
  return value === undefined ? undefined : canonicalIdentifier(value);
}

function normalizeDurableIdentity(identity: ContactDurableIdentity): ContactDurableIdentity {
  return identity.kind === "LEGAL_REGISTRY"
    ? Object.freeze({
        kind: "LEGAL_REGISTRY",
        jurisdiction: canonicalIdentifier(identity.jurisdiction),
        registryScheme: canonicalIdentifier(identity.registryScheme),
        number: canonicalIdentifier(identity.number),
      })
    : Object.freeze({
        kind: "PROVIDER_TENANT_ACCOUNT",
        providerId: canonicalIdentifier(identity.providerId),
        namespace: canonicalIdentifier(identity.namespace),
        number: canonicalIdentifier(identity.number),
      });
}

export function normalizeXeroContactIdentity(
  evidence: XeroContactIdentityEvidence,
): XeroContactIdentityEvidence {
  return Object.freeze({
    name: canonicalIdentifier(evidence.name),
    ...(evidence.email !== undefined ? { email: canonicalIdentifier(evidence.email) } : {}),
    ...(evidence.durableIdentity !== undefined
      ? { durableIdentity: normalizeDurableIdentity(evidence.durableIdentity) }
      : {}),
    ...(evidence.companyNumber !== undefined
      ? { companyNumber: canonicalIdentifier(evidence.companyNumber) }
      : {}),
    ...(evidence.accountNumber !== undefined
      ? { accountNumber: canonicalIdentifier(evidence.accountNumber) }
      : {}),
  });
}

export function xeroContactIdentityEvidenceFromSummary(
  contact: ContactSummary,
): XeroContactIdentityEvidence | undefined {
  if (!contact.name) return undefined;
  return normalizeXeroContactIdentity({
    name: contact.name,
    ...(contact.email !== undefined ? { email: contact.email } : {}),
    ...(contact.companyNumber !== undefined ? { companyNumber: contact.companyNumber } : {}),
    ...(contact.accountNumber !== undefined ? { accountNumber: contact.accountNumber } : {}),
  });
}

export function xeroContactIdentityPolicy(
  requested: XeroContactIdentityEvidence,
): XeroContactIdentityPolicy {
  return requested.durableIdentity !== undefined
    ? "TYPED_DURABLE_IDENTITY"
    : "CANDIDATE_COLLISION_ONLY";
}

export function xeroContactIdentityMismatchReasons(
  requestedInput: XeroContactIdentityEvidence,
  contact: ContactSummary,
): XeroContactIdentityMismatchReason[] {
  const requested = normalizeXeroContactIdentity(requestedInput);
  const actualName = contact.name ? canonicalIdentifier(contact.name) : undefined;
  const reasons: XeroContactIdentityMismatchReason[] = [];
  if (actualName !== requested.name) reasons.push("XERO_CONTACT_IDENTITY_NAME_MISMATCH");
  if (contact.status !== "ACTIVE") reasons.push("XERO_CONTACT_IDENTITY_STATUS_NOT_ACTIVE");

  if (requested.durableIdentity?.kind === "LEGAL_REGISTRY") {
    const actual = optionalCanonicalIdentifier(contact.companyNumber);
    if (actual === undefined) reasons.push("XERO_CONTACT_IDENTITY_COMPANY_NUMBER_MISSING");
    else if (actual !== requested.durableIdentity.number) {
      reasons.push("XERO_CONTACT_IDENTITY_COMPANY_NUMBER_CONFLICT");
    }
  }
  if (requested.durableIdentity?.kind === "PROVIDER_TENANT_ACCOUNT") {
    const actual = optionalCanonicalIdentifier(contact.accountNumber);
    if (requested.durableIdentity.providerId !== "xero" || actual === undefined) {
      reasons.push("XERO_CONTACT_IDENTITY_ACCOUNT_NUMBER_MISSING");
    } else if (actual !== requested.durableIdentity.number) {
      reasons.push("XERO_CONTACT_IDENTITY_ACCOUNT_NUMBER_CONFLICT");
    }
  }

  for (const [field, missing, conflict] of [
    ["email", "XERO_CONTACT_IDENTITY_EMAIL_MISSING", "XERO_CONTACT_IDENTITY_EMAIL_CONFLICT"],
    ["companyNumber", "XERO_CONTACT_IDENTITY_COMPANY_NUMBER_MISSING", "XERO_CONTACT_IDENTITY_COMPANY_NUMBER_CONFLICT"],
    ["accountNumber", "XERO_CONTACT_IDENTITY_ACCOUNT_NUMBER_MISSING", "XERO_CONTACT_IDENTITY_ACCOUNT_NUMBER_CONFLICT"],
  ] as const) {
    const expected = requested[field];
    if (expected === undefined) continue;
    const actual = optionalCanonicalIdentifier(contact[field]);
    if (actual === undefined) reasons.push(missing);
    else if (actual !== expected) reasons.push(conflict);
  }
  return reasons;
}

export function createXeroContactIdentityDecision(
  requestedInput: XeroContactIdentityEvidence,
  contact: ContactSummary,
): XeroContactIdentityDecision | undefined {
  if (xeroContactIdentityMismatchReasons(requestedInput, contact).length > 0) return undefined;
  const verified = xeroContactIdentityEvidenceFromSummary(contact);
  if (!verified) return undefined;
  return Object.freeze({
    contractVersion: XERO_CONTACT_IDENTITY_CONTRACT_VERSION,
    policy: xeroContactIdentityPolicy(requestedInput),
    contactId: contact.contactId,
    requested: normalizeXeroContactIdentity(requestedInput),
    verified,
  });
}

export function sameXeroContactIdentityEvidence(
  left: XeroContactIdentityEvidence,
  right: XeroContactIdentityEvidence,
): boolean {
  const a = normalizeXeroContactIdentity(left);
  const b = normalizeXeroContactIdentity(right);
  return a.name === b.name && a.email === b.email &&
    JSON.stringify(a.durableIdentity) === JSON.stringify(b.durableIdentity) &&
    a.companyNumber === b.companyNumber && a.accountNumber === b.accountNumber;
}
