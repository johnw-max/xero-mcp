import { describe, expect, it } from "vitest";
import { compileAccountingCase } from "../src/control-kernel/accountingCaseCompiler.js";
import {
  compileXeroAccountingCase,
  createXeroAccountingCaseProviderContract,
  projectXeroAccountingCaseCompilerInput,
} from "../src/policy/xeroAccountingCaseProviderContract.js";
import {
  createXeroDeclaredLedgerPolicy,
  createXeroDeclaredLedgerPolicyFromProjection,
} from "../src/policy/xeroDeclaredLedgerPolicy.js";
import {
  TEST_XERO_TENANT_ID,
  testXeroTenantCoaBinding,
} from "./helpers/xeroTenantCoaProfile.js";

type DocumentAmounts = Readonly<{
  currency: string;
  quantity: string;
  unitAmount: string;
  sourceTax: string;
  declaredNet: string;
  declaredTax: string;
  declaredGross: string;
  /** Declared Xero TaxType. `OUTPUTY24` is the tenant's live 9% revenue rate; `NONE` is its live 0% rate. */
  taxType?: "OUTPUTY24" | "NONE";
}>;

function caseInput(amounts: DocumentAmounts, lines?: ReadonlyArray<Readonly<{
  quantity: string;
  unitAmount: string;
  sourceTax: string;
}>>) {
  const taxType = amounts.taxType ?? "NONE";
  return {
    caseId: `rounding-${amounts.currency.toLocaleLowerCase("en")}`,
    expectedVersion: 0,
    target: {
      tenantId: TEST_XERO_TENANT_ID,
      environment: "TEST",
      baseCurrency: amounts.currency,
      taxJurisdiction: "SG",
      paysTax: true,
      organisationStatus: "ACTIVE",
    },
    sources: [{
      artifactId: "source-rounding",
      label: "Typed monetary rounding source",
      units: [{ unitId: "unit-rounding", expectedFactKinds: ["NATIVE_DOCUMENT"] }],
    }],
    facts: [{
      factId: "fact-rounding",
      lineageKey: "lineage-rounding",
      eventKey: "event-rounding",
      sourceUnitIds: ["unit-rounding"],
      origin: "MODEL_EXTRACTED",
      revision: 1,
      kind: "NATIVE_DOCUMENT",
      documentKind: "INVOICE",
      counterpartyRole: "CUSTOMER",
      reference: `INV-${amounts.currency}-ROUNDING`,
      referenceKind: "FORMAL_DOCUMENT_NUMBER",
      documentDate: "2026-07-20",
      dueDate: "2026-08-20",
      currency: amounts.currency,
      contactName: "Exact Rounding Customer",
      xeroContactId: "22222222-2222-4222-8222-222222222222",
      taxPolicyBasis: "DOCUMENT_DATE_NON_TRANSITION",
      lineAmountType: taxType === "NONE" ? "NO_TAX" : "EXCLUSIVE",
      lines: (lines ?? [amounts]).map((line, index) => ({
        lineId: `line-${index + 1}`,
        description: `Deterministic line ${index + 1}`,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
        sourceTax: line.sourceTax,
        accountCode: "200",
        taxType,
      })),
      declaredNet: amounts.declaredNet,
      declaredTax: amounts.declaredTax,
      declaredGross: amounts.declaredGross,
      documentValidity: "TEST_OR_NOT_VALID",
    }],
  } as const;
}

function onlyOperation(compiled: ReturnType<typeof compileXeroAccountingCase>) {
  expect(compiled.status).toBe("PLANNED_NEEDS_PREFLIGHT");
  expect(compiled.operations).toHaveLength(1);
  return compiled.operations[0]!;
}

function compileXero(raw: unknown) {
  return compileXeroAccountingCase(raw, testXeroTenantCoaBinding());
}

describe("Accounting Case policy-owned currency rounding", () => {
  it("rounds SGD tax HALF_UP per line without treating legitimate currency rounding as precision loss", () => {
    const operation = onlyOperation(compileXero(caseInput({
      currency: "SGD",
      quantity: "1",
      unitAmount: "0.99",
      sourceTax: "0.09",
      declaredNet: "0.99",
      declaredTax: "0.09",
      declaredGross: "1.08",
      taxType: "OUTPUTY24",
    })));

    expect(operation.reasonCodes).toEqual([]);
    expect(operation.canonicalPayload).toMatchObject({
      net: "0.9900",
      tax: "0.0900",
      gross: "1.0800",
      monetaryRule: {
        currency: "SGD",
        minorUnitScale: 2,
        roundingMode: "HALF_UP",
        taxAggregation: "PER_LINE",
      },
    });
  });

  it("rounds a scale-four unit-price product to the currency minor unit using integer HALF_UP", () => {
    const operation = onlyOperation(compileXero(caseInput({
      currency: "SGD",
      quantity: "2",
      unitAmount: "125.5025",
      sourceTax: "0",
      declaredNet: "251.01",
      declaredTax: "0",
      declaredGross: "251.01",
    })));
    expect((operation.canonicalPayload.lines as Array<Record<string, unknown>>)[0]).toMatchObject({
      net: "251.0100",
      tax: "0.0000",
    });
  });

  it("uses JPY scale zero, accepts the rounded integer, and rejects a fractional source total", () => {
    const rounded = onlyOperation(compileXero(caseInput({
      currency: "JPY",
      quantity: "3",
      unitAmount: "33.5",
      sourceTax: "0",
      declaredNet: "101",
      declaredTax: "0",
      declaredGross: "101",
    })));
    expect(rounded.canonicalPayload).toMatchObject({
      net: "101.0000",
      gross: "101.0000",
      monetaryRule: { currency: "JPY", minorUnitScale: 0 },
    });

    const fractional = compileXero(caseInput({
      currency: "JPY",
      quantity: "3",
      unitAmount: "33.5",
      sourceTax: "0",
      declaredNet: "100.5",
      declaredTax: "0",
      declaredGross: "100.5",
    }));
    expect(fractional.status).toBe("BLOCKED_VALIDATION");
    expect(fractional.operations).toEqual([]);
    expect(fractional.events[0]?.reasonCodes).toEqual(expect.arrayContaining([
      "SOURCE_NET_MISMATCH",
      "SOURCE_GROSS_MISMATCH",
    ]));
  });

  it("applies tax rounding per line and does not substitute document-total aggregation", () => {
    const operation = onlyOperation(compileXero(caseInput({
      currency: "SGD",
      quantity: "1",
      unitAmount: "0.05",
      sourceTax: "0",
      declaredNet: "0.10",
      declaredTax: "0",
      declaredGross: "0.10",
      taxType: "OUTPUTY24",
    }, [
      { quantity: "1", unitAmount: "0.05", sourceTax: "0" },
      { quantity: "1", unitAmount: "0.05", sourceTax: "0" },
    ])));
    expect(operation.canonicalPayload).toMatchObject({ tax: "0.0000", gross: "0.1000" });
    expect((operation.canonicalPayload.lines as Array<Record<string, unknown>>)
      .map((line) => line.tax)).toEqual(["0.0000", "0.0000"]);
  });

  it("accepts a bounded three-decimal source string but fails closed for a currency outside the gateway's table", () => {
    // XTS is ISO 4217's own "reserved for testing" code, so it is guaranteed
    // to stay absent from LEDGER_CURRENCY_MINOR_UNITS regardless of which real
    // currencies that table is extended to cover in the future.
    const compiled = compileXero(caseInput({
      currency: "XTS",
      quantity: "1",
      unitAmount: "1.001",
      sourceTax: "0",
      declaredNet: "1.001",
      declaredTax: "0",
      declaredGross: "1.001",
    }));
    expect(compiled.status).toBe("BLOCKED_VALIDATION");
    expect(compiled.operations).toEqual([]);
    expect(compiled.events[0]?.reasonCodes).toContain("ACCOUNTING_MONETARY_CURRENCY_UNSUPPORTED");
  });

  it("seals monetary rules into the policy projection/source hash and blocks unsupported aggregation", () => {
    const raw = caseInput({
      currency: "SGD",
      quantity: "1",
      unitAmount: "0.99",
      sourceTax: "0.09",
      declaredNet: "0.99",
      declaredTax: "0.09",
      declaredGross: "1.08",
      taxType: "OUTPUTY24",
    });
    const projected = projectXeroAccountingCaseCompilerInput(raw);
    const provider = createXeroAccountingCaseProviderContract(
      projected.contactBindings,
      testXeroTenantCoaBinding(),
    );
    const policy = createXeroDeclaredLedgerPolicy({
      jurisdiction: "SG",
      paysTax: true,
      ledgerBinding: testXeroTenantCoaBinding(),
    });
    const baseline = compileAccountingCase(projected.input, policy, provider);
    expect(baseline.policyProjection).toMatchObject({
      monetaryRules: {
        roundingMode: "HALF_UP",
        taxAggregation: "PER_LINE",
        currencyMinorUnitScales: { JPY: 0, SGD: 2 },
      },
    });

    const changedProjection = structuredClone(policy.planProjection) as Record<string, unknown>;
    const rules = changedProjection.monetaryRules as Record<string, unknown>;
    rules.taxAggregation = "DOCUMENT_TOTAL";
    const changed = compileAccountingCase(
      projected.input,
      createXeroDeclaredLedgerPolicyFromProjection(changedProjection),
      provider,
    );
    expect(changed.sourceRevisionHash).not.toBe(baseline.sourceRevisionHash);
    expect(changed.status).toBe("BLOCKED_VALIDATION");
    expect(changed.events[0]?.reasonCodes).toContain("ACCOUNTING_TAX_AGGREGATION_UNSUPPORTED");
  });
});
