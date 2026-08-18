import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_ALLOWLIST } from "../src/mcp/toolNames.js";
import { hashObject } from "../src/security/hash.js";
import { XERO_RELEASE_ATTESTATION, XERO_RELEASE_VERSION } from "../src/xeroRelease.js";

describe("Xero 0.4 runtime attestation", () => {
  it("binds the runtime to the Accounting Case kernel, policy and durable migration", () => {
    expect(XERO_RELEASE_VERSION).toBe("0.4.0-rc.1");
    expect(XERO_RELEASE_ATTESTATION).toEqual({
      controlKernel: "ledger-control-kernel-v2",
      ledgerAuthoritySnapshot: "ledger-authority-snapshot:v2",
      accountingCaseCompiler: "0.11.0",
      accountingPolicy: "v1",
      accountingPolicyProjection: "xero-declared-ledger-policy-projection:v1",
      accountingCaseProviderContract: "xero-accounting-case-provider-v14",
      accountingCaseProviderProjection: "xero-accounting-case-provider-projection:v9",
      accountingCaseBusinessAuthorityProjection: "xero-accounting-case-business-authority:v4",
      accountingCaseReadbackValidator: "accounting-case-observed-line-readback-v4",
      xeroNativeRouteContract: "xero-native-route-contract-v1",
      xeroContactIdentityContract: "xero-contact-identity-v3",
      requiredMigration: "040_xero_native_idempotency_recovery_claim.sql",
      publicToolProfile: "xero-accounting-case-business-intake-v4",
      executionAuthority: "STANDING_DELEGATION",
      writeCompletion: "PROVIDER_ID_RECEIPT_EXACT_READBACK",
    });
    const migration = readFileSync(
      resolve(process.cwd(), "migrations", XERO_RELEASE_ATTESTATION.requiredMigration),
      "utf8",
    );
    expect(migration).toContain("native_recovery_claim jsonb");
    expect(migration).toContain("XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM");
    expect(migration).toContain("native_recovery_claim_independent_check");
    expect(hashObject(XERO_RELEASE_ATTESTATION)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("attests the reviewed 28-tool public surface with only one mutation route", () => {
    expect(TOOL_ALLOWLIST).toHaveLength(28);
    expect(TOOL_ALLOWLIST).toContain("xero_execute_accounting_case");
    expect(TOOL_ALLOWLIST.some((tool) => /xero_(?:create|prepare)_manual_journal/u.test(tool))).toBe(false);
    expect(TOOL_ALLOWLIST.some((tool) => /^xero_(?:create|prepare)_(?!accounting_case)/u.test(tool))).toBe(false);
  });
});
