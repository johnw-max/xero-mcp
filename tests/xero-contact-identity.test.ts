import { describe, expect, it } from "vitest";
import {
  XERO_CONTACT_IDENTITY_CONTRACT_VERSION,
  createXeroContactIdentityDecision,
  normalizeXeroContactIdentity,
  xeroContactIdentityMismatchReasons,
  xeroContactNamespaceContinuityEvidence,
} from "../src/policy/xeroContactIdentity.js";

const contact = {
  contactId: "22222222-2222-4222-8222-222222222222",
  name: " Example  Pte. Ltd. ",
  email: "AP@EXAMPLE.TEST",
  companyNumber: "202612345K",
  accountNumber: "CUST-001",
  status: "ACTIVE",
};

describe("versioned Xero contact identity contract", () => {
  it("normalizes and requires every supplied strong field", () => {
    const requested = {
      name: "Example Pte. Ltd.",
      email: "ap@example.test",
      companyNumber: "202612345k",
      accountNumber: "cust-001",
    };
    expect(createXeroContactIdentityDecision(requested, contact)).toEqual({
      contractVersion: XERO_CONTACT_IDENTITY_CONTRACT_VERSION,
      policy: "CANDIDATE_COLLISION_ONLY",
      contactId: contact.contactId,
      requested: normalizeXeroContactIdentity(requested),
      verified: normalizeXeroContactIdentity({
        name: contact.name,
        email: contact.email,
        companyNumber: contact.companyNumber,
        accountNumber: contact.accountNumber,
      }),
    });
  });

  it.each([
    ["email", { email: "wrong@example.test" }, "XERO_CONTACT_IDENTITY_EMAIL_CONFLICT"],
    ["company number", { companyNumber: "wrong" }, "XERO_CONTACT_IDENTITY_COMPANY_NUMBER_CONFLICT"],
    ["account number", { accountNumber: "wrong" }, "XERO_CONTACT_IDENTITY_ACCOUNT_NUMBER_CONFLICT"],
  ])("fails closed for a conflicting %s", (_label, override, reason) => {
    const requested = { name: contact.name, ...override };
    expect(createXeroContactIdentityDecision(requested, contact)).toBeUndefined();
    expect(xeroContactIdentityMismatchReasons(requested, contact)).toContain(reason);
  });

  it("distinguishes missing provider evidence from conflicting evidence", () => {
    const requested = { name: contact.name, email: contact.email };
    expect(xeroContactIdentityMismatchReasons(requested, { ...contact, email: undefined })).toEqual([
      "XERO_CONTACT_IDENTITY_EMAIL_MISSING",
    ]);
  });

  it("makes the name-only fallback an explicit policy decision", () => {
    expect(createXeroContactIdentityDecision({ name: "Example Pte. Ltd." }, contact)).toMatchObject({
      contractVersion: XERO_CONTACT_IDENTITY_CONTRACT_VERSION,
      policy: "CANDIDATE_COLLISION_ONLY",
    });
  });

  it("keeps provider bare-number continuity separate from namespace authority and source truth", () => {
    const requestedBusinessIdentityHash = "a".repeat(64);
    expect(xeroContactNamespaceContinuityEvidence({
      requestedBusinessIdentityHash,
      registeredBusinessIdentityHashes: ["b".repeat(64)],
    })).toEqual({
      providerEvidence: "BARE_NUMBER_MATCH",
      serverTupleContinuity: "NO_EXACT_REGISTERED_TUPLE",
      externalNamespaceAuthority: "UNVERIFIED",
      sourceTruth: "UNVERIFIED",
    });
    expect(xeroContactNamespaceContinuityEvidence({
      requestedBusinessIdentityHash,
      registeredBusinessIdentityHashes: ["b".repeat(64), requestedBusinessIdentityHash],
    })).toEqual({
      providerEvidence: "BARE_NUMBER_MATCH",
      serverTupleContinuity: "EXACT_REGISTERED_TUPLE",
      externalNamespaceAuthority: "UNVERIFIED",
      sourceTruth: "UNVERIFIED",
    });
  });
});
