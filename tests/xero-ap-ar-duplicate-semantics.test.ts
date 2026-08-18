import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { CreatePostingInput } from "../src/domain/models.js";
import {
  canonicalDraftExtractionFingerprint,
  canonicalDraftRequest,
  canonicalSalesInvoiceDraftExtractionFingerprint,
  canonicalSalesInvoiceDraftRequest,
} from "../src/domain/canonical.js";
import { hashObject } from "../src/security/hash.js";

const commonDraft = {
  request_id: "same-source-request",
  source_ref: "agent2://material/same-source",
  source_sha256: "1".repeat(64),
  source_evidence_type: "SERVER_FINGERPRINTED_EXTRACTION" as const,
  user_confirmation: "CONFIRMED_FOR_DRAFT" as const,
  contact_id: "22222222-2222-4222-8222-222222222222",
  invoice_date: "2026-08-07",
  due_date: "2026-08-21",
  currency: "HKD",
  reference: "SAME-SOURCE-001",
  line_amount_type: "Exclusive" as const,
  lines: [{
    description: "Same extracted source line",
    quantity: 1,
    unit_amount: 100,
    account_code: "200",
    tax_type: "NONE",
  }],
};

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const contactId = "22222222-2222-4222-8222-222222222222";

function posting(
  documentType: "ACCPAY" | "ACCREC",
  suffix: string,
  overrides: Partial<CreatePostingInput> = {},
): CreatePostingInput {
  const providerPayload = overrides.providerPayload ?? {
    invoiceType: documentType,
    contactId,
    reference: "SHARED-REFERENCE",
  };
  const requestPayloadHash = overrides.requestPayloadHash ?? hashObject({ suffix, providerPayload });
  return {
    postingRequestId: `pr_${suffix}_abcdefghijklmnop`,
    actorId: "actor-a",
    tenantId,
    sourceRef: `agent2://material/${suffix}`,
    sourceSha256: hashObject({ source: suffix }),
    sourceEvidenceType: "AGENT_ASSERTED_UNVERIFIED",
    documentType,
    providerPayload,
    requestPayloadHash,
    providerPayloadHash: requestPayloadHash,
    requestId: `request-${suffix}`,
    createIdempotencyKey: `zc:create:${documentType}:${suffix}`,
    ...overrides,
  };
}

describe("Xero AP/AR business duplicate semantics", () => {
  it("uses one server-generated source identity across ACCPAY and ACCREC interpretations", () => {
    const apSourceHash = hashObject(canonicalDraftExtractionFingerprint(commonDraft));
    const arSourceHash = hashObject(canonicalSalesInvoiceDraftExtractionFingerprint(commonDraft));

    expect(arSourceHash).toBe(apSourceHash);
  });

  it("keeps ACCREC in the full request identity after sharing the source identity", () => {
    const apRequest = canonicalDraftRequest(tenantId, commonDraft);
    const arRequest = canonicalSalesInvoiceDraftRequest(tenantId, commonDraft);

    expect(arRequest).toMatchObject({ tenantId, invoiceType: "ACCREC" });
    expect(apRequest).not.toHaveProperty("invoiceType");
    expect(hashObject(arRequest)).not.toBe(hashObject(apRequest));
  });

  it("allows distinct ACCREC invoices to share an additional customer reference", async () => {
    const repository = new InMemoryAccountingRepository();
    const base = posting("ACCREC", "ar-reference-first");
    const first = await repository.createOrGetPosting(base);
    const second = await repository.createOrGetPosting(posting("ACCREC", "ar-reference-second"));

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.posting.postingRequestId).not.toBe(first.posting.postingRequestId);
  });

  it("does not treat a reusable supplier reference as a hard ACCPAY identity", async () => {
    const repository = new InMemoryAccountingRepository();
    const first = await repository.createOrGetPosting(posting("ACCPAY", "ap-reference-first"));
    const second = await repository.createOrGetPosting(posting("ACCPAY", "ap-reference-second"));

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.posting.postingRequestId).not.toBe(first.posting.postingRequestId);
  });

  it("keeps one tenant-global source guard across ACCPAY and ACCREC", async () => {
    const repository = new InMemoryAccountingRepository();
    const sharedSourceSha256 = hashObject({ source: "same-ap-ar-source" });
    const ap = await repository.createOrGetPosting(posting("ACCPAY", "ap-shared-source", {
      sourceSha256: sharedSourceSha256,
    }));
    const ar = await repository.createOrGetPosting(posting("ACCREC", "ar-shared-source", {
      sourceSha256: sharedSourceSha256,
    }));

    expect(ap.created).toBe(true);
    expect(ar).toMatchObject({
      created: false,
      posting: { postingRequestId: ap.posting.postingRequestId },
    });
  });

  it("keeps request-id idempotency within each actor, tenant, and document type", async () => {
    const repository = new InMemoryAccountingRepository();
    const firstInput = posting("ACCREC", "ar-request-first", { requestId: "shared-ar-request" });
    const first = await repository.createOrGetPosting(firstInput);
    const replay = await repository.createOrGetPosting(posting("ACCREC", "ar-request-second", {
      requestId: firstInput.requestId,
    }));

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({
      created: false,
      posting: { postingRequestId: first.posting.postingRequestId },
    });
  });
});
