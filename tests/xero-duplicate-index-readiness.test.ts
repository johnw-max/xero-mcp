import { describe, expect, it } from "vitest";
import {
  EXPECTED_XERO_DUPLICATE_INDEXES,
  hasExactXeroDuplicateIndexes,
  type XeroDuplicateIndexCatalogRow,
} from "../src/db/xeroDuplicateIndexReadiness.js";

function exactRows(): XeroDuplicateIndexCatalogRow[] {
  return Object.entries(EXPECTED_XERO_DUPLICATE_INDEXES).map(([indexName, expected]) => ({
    indexName,
    accessMethod: "btree",
    isUnique: true,
    isValid: true,
    isReady: true,
    keyDefinitions: [...expected.keyDefinitions],
    predicate: expected.predicate,
  }));
}

function mutate(
  indexName: string,
  update: Partial<XeroDuplicateIndexCatalogRow>,
): XeroDuplicateIndexCatalogRow[] {
  return exactRows().map((row) => row.indexName === indexName ? { ...row, ...update } : row);
}

describe("Xero duplicate-index readiness", () => {
  it("requires exact legacy and v030 definitions at the same time", () => {
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_actor_tenant_request_create_unique_idx.keyDefinitions)
      .toEqual(["actor_id", "tenant_id", "request_id", "create_operation"]);
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_actor_tenant_request_create_v030_unique_idx.keyDefinitions)
      .toEqual(["actor_id", "tenant_id", "document_type", "request_id", "create_operation"]);
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_active_source_unique_idx.predicate)
      .not.toContain("DRAFT_READBACK_VERIFIED");
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_active_source_v030_unique_idx.predicate)
      .toContain("DRAFT_READBACK_VERIFIED");
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_active_supplier_reference_unique_idx.keyDefinitions)
      .toHaveLength(4);
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_active_supplier_ref_v030_unique_idx.keyDefinitions)
      .toEqual(expect.arrayContaining(["actor_id", "tenant_id", "document_type"]));
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_source_unique_idx.keyDefinitions)
      .toEqual(["tenant_id", "source_sha256"]);
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_source_unique_idx.predicate)
      .not.toContain("DRAFT_READBACK_VERIFIED");
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_source_v030_unique_idx.predicate)
      .toContain("DRAFT_READBACK_VERIFIED");
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_supplier_reference_unique_idx.keyDefinitions)
      .toHaveLength(3);
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_supplier_ref_v030_unique_idx.keyDefinitions)
      .toHaveLength(4);
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_supplier_ref_v030_unique_idx.keyDefinitions[0])
      .toBe("tenant_id");
    expect(EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_supplier_ref_v030_unique_idx.keyDefinitions[1])
      .toBe("document_type");
  });

  it("accepts only the exact intended keys, expressions, and active-state predicates", () => {
    expect(hasExactXeroDuplicateIndexes(exactRows())).toBe(true);
  });

  it.each([
    ["non-unique", { isUnique: false }],
    ["invalid", { isValid: false }],
    ["not ready", { isReady: false }],
    ["wrong access method", { accessMethod: "hash" }],
    ["wrong key order", { keyDefinitions: ["source_sha256", "tenant_id"] }],
    ["extra included column", { keyDefinitions: ["tenant_id", "source_sha256", "updated_at"] }],
    ["missing REJECTED state", {
      predicate: EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_source_unique_idx.predicate
        ?.replace(", 'REJECTED'::text", "") ?? null,
    }],
    ["unexpected BLOCKED_VALIDATION state", {
      predicate: EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_source_unique_idx.predicate
        ?.replace("'REJECTED'::text", "'BLOCKED_VALIDATION'::text, 'REJECTED'::text") ?? null,
    }],
  ] as const)("rejects %s", (_label, update) => {
    expect(hasExactXeroDuplicateIndexes(mutate(
      "posting_requests_tenant_active_source_unique_idx",
      update,
    ))).toBe(false);
  });

  it("rejects a supplier-reference index with weaker null/predicate semantics", () => {
    const expected = EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_supplier_reference_unique_idx;
    expect(hasExactXeroDuplicateIndexes(mutate(
      "posting_requests_tenant_active_supplier_reference_unique_idx",
      { predicate: expected.predicate?.replace(" IS NOT NULL", " IS NULL") ?? null },
    ))).toBe(false);
  });

  it("rejects a contact-reference index that also reserves ACCREC references", () => {
    const expected = EXPECTED_XERO_DUPLICATE_INDEXES.posting_requests_tenant_active_supplier_ref_v030_unique_idx;
    expect(hasExactXeroDuplicateIndexes(mutate(
      "posting_requests_tenant_active_supplier_ref_v030_unique_idx",
      {
        predicate: expected.predicate
          ?.replace(" AND document_type = 'ACCPAY'::text", "") ?? null,
      },
    ))).toBe(false);
  });

  it("rejects missing, duplicate, or unexpected named rows", () => {
    const rows = exactRows();
    expect(hasExactXeroDuplicateIndexes(rows.slice(1))).toBe(false);
    expect(hasExactXeroDuplicateIndexes([...rows, rows[0]!])).toBe(false);
    expect(hasExactXeroDuplicateIndexes([
      ...rows.slice(1),
      { ...rows[0]!, indexName: "lookalike_index" },
    ])).toBe(false);
  });
});
