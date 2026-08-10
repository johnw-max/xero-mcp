export interface XeroDuplicateIndexCatalogRow {
  indexName: string;
  accessMethod: string;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  keyDefinitions: string[];
  predicate: string | null;
}

interface ExpectedXeroDuplicateIndex {
  keyDefinitions: string[];
  predicate: string | null;
}

const legacyActiveStateArray = [
  "'VALIDATED'::text",
  "'APPROVAL_PENDING'::text",
  "'APPROVED'::text",
  "'AUTHORISING'::text",
  "'AUTHORISED_READBACK_VERIFIED'::text",
  "'WRITE_RESULT_UNKNOWN'::text",
  "'READBACK_MISMATCH'::text",
  "'REJECTED'::text",
].join(", ");

const v030ActiveStateArray = [
  "'VALIDATED'::text",
  "'DRAFT_READBACK_VERIFIED'::text",
  "'APPROVAL_PENDING'::text",
  "'APPROVED'::text",
  "'AUTHORISING'::text",
  "'AUTHORISED_READBACK_VERIFIED'::text",
  "'WRITE_RESULT_UNKNOWN'::text",
  "'READBACK_MISMATCH'::text",
  "'REJECTED'::text",
].join(", ");

// These are PostgreSQL 17's canonical deparses for the migration expressions.
// Whitespace/case are normalized below, while operators, casts, grouping,
// state order, and null guards remain exact and therefore fail closed.
const legacyActiveStatePredicate = `state = ANY (ARRAY[${legacyActiveStateArray}])`;
const v030ActiveStatePredicate = `state = ANY (ARRAY[${v030ActiveStateArray}])`;
const accpayDocumentPredicate = "document_type = 'ACCPAY'::text";
const contactExpression = "lower(COALESCE(NULLIF(btrim(provider_payload ->> 'contactId'::text), ''::text), NULLIF(btrim(provider_payload #>> '{contact,contactId}'::text[]), ''::text)))";
const referenceExpression = "lower(btrim(provider_payload ->> 'reference'::text))";
const contactPresentPredicate = "COALESCE(NULLIF(btrim(provider_payload ->> 'contactId'::text), ''::text), NULLIF(btrim(provider_payload #>> '{contact,contactId}'::text[]), ''::text)) IS NOT NULL";
const referencePresentPredicate = "NULLIF(btrim(provider_payload ->> 'reference'::text), ''::text) IS NOT NULL";

export const EXPECTED_XERO_DUPLICATE_INDEXES: Readonly<Record<string, ExpectedXeroDuplicateIndex>> = {
  posting_requests_actor_tenant_request_create_unique_idx: {
    keyDefinitions: ["actor_id", "tenant_id", "request_id", "create_operation"],
    predicate: null,
  },
  posting_requests_active_source_unique_idx: {
    keyDefinitions: ["actor_id", "tenant_id", "source_sha256"],
    predicate: legacyActiveStatePredicate,
  },
  posting_requests_active_supplier_reference_unique_idx: {
    keyDefinitions: ["actor_id", "tenant_id", contactExpression, referenceExpression],
    predicate: `(${legacyActiveStatePredicate}) AND ${contactPresentPredicate} AND ${referencePresentPredicate}`,
  },
  posting_requests_tenant_active_source_unique_idx: {
    keyDefinitions: ["tenant_id", "source_sha256"],
    predicate: legacyActiveStatePredicate,
  },
  posting_requests_tenant_active_supplier_reference_unique_idx: {
    keyDefinitions: ["tenant_id", contactExpression, referenceExpression],
    predicate: `(${legacyActiveStatePredicate}) AND ${contactPresentPredicate} AND ${referencePresentPredicate}`,
  },
  posting_requests_actor_tenant_request_create_v030_unique_idx: {
    keyDefinitions: ["actor_id", "tenant_id", "document_type", "request_id", "create_operation"],
    predicate: null,
  },
  posting_requests_active_source_v030_unique_idx: {
    keyDefinitions: ["actor_id", "tenant_id", "source_sha256"],
    predicate: v030ActiveStatePredicate,
  },
  posting_requests_active_supplier_ref_v030_unique_idx: {
    keyDefinitions: ["actor_id", "tenant_id", "document_type", contactExpression, referenceExpression],
    predicate: `(${v030ActiveStatePredicate}) AND ${accpayDocumentPredicate} AND ${contactPresentPredicate} AND ${referencePresentPredicate}`,
  },
  posting_requests_tenant_active_source_v030_unique_idx: {
    keyDefinitions: ["tenant_id", "source_sha256"],
    predicate: v030ActiveStatePredicate,
  },
  posting_requests_tenant_active_supplier_ref_v030_unique_idx: {
    keyDefinitions: ["tenant_id", "document_type", contactExpression, referenceExpression],
    predicate: `(${v030ActiveStatePredicate}) AND ${accpayDocumentPredicate} AND ${contactPresentPredicate} AND ${referencePresentPredicate}`,
  },
};

function normalizedDefinition(value: string): string {
  return value.replace(/\s+/gu, "").toLowerCase();
}

/**
 * Fail closed unless all five distinct legacy indexes checked by Xero 0.2.13
 * and the QuickBooks 0.2.12 shared repository, plus their five document-type/
 * DRAFT-aware v030 successors, have exact keys and predicates. Index names
 * alone are not sufficient because PostgreSQL can retain a stale definition.
 */
export function hasExactXeroDuplicateIndexes(rows: XeroDuplicateIndexCatalogRow[]): boolean {
  const byName = new Map(rows.map((row) => [row.indexName, row]));
  const expectedCount = Object.keys(EXPECTED_XERO_DUPLICATE_INDEXES).length;
  if (rows.length !== expectedCount || byName.size !== expectedCount) return false;

  return Object.entries(EXPECTED_XERO_DUPLICATE_INDEXES).every(([indexName, expected]) => {
    const actual = byName.get(indexName);
    if (
      !actual ||
      actual.accessMethod !== "btree" ||
      !actual.isUnique ||
      !actual.isValid ||
      !actual.isReady ||
      actual.keyDefinitions.length !== expected.keyDefinitions.length
    ) {
      return false;
    }
    if (!actual.keyDefinitions.every((definition, index) =>
      normalizedDefinition(definition) === normalizedDefinition(expected.keyDefinitions[index] ?? "")
    )) {
      return false;
    }
    if (actual.predicate === null || expected.predicate === null) {
      return actual.predicate === expected.predicate;
    }
    return normalizedDefinition(actual.predicate) === normalizedDefinition(expected.predicate);
  });
}
