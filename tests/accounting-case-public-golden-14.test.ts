import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareAccountingCasePublicSchema } from "../src/domain/accountingCaseSchemas.js";

function json(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  )) as Record<string, unknown>;
}

function publicProjection(internal: Record<string, unknown>) {
  const facts = (internal.facts as Array<Record<string, unknown>>).map((fact) => {
    const { xeroContactId: _providerResolvedIdentity, ...publicFact } = fact;
    return publicFact;
  });
  return {
    case_id: internal.caseId,
    expected_version: internal.expectedVersion,
    sources: internal.sources,
    facts,
  };
}

describe("public Golden14 Accounting Case fixture", () => {
  it("is an exact mechanical public projection with no target or provider-resolved contact IDs", () => {
    const internal = json("../harness/fixtures/xero/golden-14-case.v1.json");
    const publicFixture = json("../harness/fixtures/xero/golden-14-public-case.v1.json");

    expect(publicFixture).toEqual(publicProjection(internal));
    expect(() => prepareAccountingCasePublicSchema.parse(publicFixture)).not.toThrow();
    expect(publicFixture).not.toHaveProperty("target");
    expect(JSON.stringify(publicFixture)).not.toContain("xeroContactId");
  });
});
