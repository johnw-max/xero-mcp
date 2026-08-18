import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_MIGRATION_HEAD,
  REQUIRED_MIGRATIONS,
} from "../src/db/requiredMigrations.js";
import { runMigrations } from "../src/db/migrate.js";
import { XERO_RELEASE_ATTESTATION } from "../src/xeroRelease.js";
import {
  assertRequiredReleaseFiles,
  requiredMigrationReleaseFiles,
  requiredReleaseFiles,
} from "../scripts/release/release-bundle-lib.mjs";

describe("required migration release manifest", () => {
  it("defines the ordered 025-041 release contract and derives its attested head", () => {
    expect(REQUIRED_MIGRATIONS).toEqual([
      "025_xero_ledger_target_sessions.sql",
      "026_xero_autonomous_authorization_receipts.sql",
      "027_accounting_case_foundation.sql",
      "028_xero_autonomous_validation_receipt_lifecycle.sql",
      "029_accounting_case_evidence_linkage.sql",
      "030_accounting_case_preflight_reseal.sql",
      "031_accounting_case_economic_readback_convergence.sql",
      "032_ledger_authority_snapshots.sql",
      "033_accounting_case_business_write_reservations.sql",
      "034_accounting_case_continuation.sql",
      "035_accounting_case_business_reservation_scopes.sql",
      "036_accounting_case_contact_bare_number_reservations.sql",
      "037_accounting_case_contact_prepared_reservation_recovery.sql",
      "038_accounting_case_mutation_projection_convergence.sql",
      "039_accounting_case_expired_target_residual_continuation.sql",
      "040_xero_native_idempotency_recovery_claim.sql",
      "041_accounting_case_source_case_binding.sql",
    ]);
    expect(REQUIRED_MIGRATION_HEAD).toBe(REQUIRED_MIGRATIONS.at(-1));
    expect(XERO_RELEASE_ATTESTATION.requiredMigration).toBe(REQUIRED_MIGRATION_HEAD);
    expect(requiredMigrationReleaseFiles()).toEqual(
      REQUIRED_MIGRATIONS.map((migration) => `migrations/${migration}`),
    );
  });

  it.each(REQUIRED_MIGRATIONS)(
    "fails the migration runner gate when %s is missing",
    async (missingMigration) => {
      const migrationsDirectory = await mkdtemp(join(tmpdir(), "xero-required-migrations-"));
      try {
        await Promise.all(REQUIRED_MIGRATIONS
          .filter((migration) => migration !== missingMigration)
          .map((migration) => writeFile(join(migrationsDirectory, migration), "-- test fixture\n")));
        await expect(runMigrations(
          "postgres://must-not-connect.invalid/required-migration-gate",
          migrationsDirectory,
        )).rejects.toThrow(`Required migrations are missing: ${missingMigration}`);
      } finally {
        await rm(migrationsDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each(REQUIRED_MIGRATIONS)(
    "fails the release bundle gate when %s is missing",
    (missingMigration) => {
      const missingPath = `migrations/${missingMigration}`;
      const selected = new Set(requiredReleaseFiles());
      selected.delete(missingPath);
      expect(() => assertRequiredReleaseFiles(selected))
        .toThrow(`Release selection omitted required file: ${missingPath}`);
    },
  );
});
