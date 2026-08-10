import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../scripts/require-test-database-url.mjs", import.meta.url));

function runGuard(databaseUrl: string) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
  });
}

describe("required PostgreSQL test database guard", () => {
  it("includes the Xero write-provenance rollback contract in the required release suite", () => {
    const packageJson = JSON.parse(readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    )) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["test:postgres:required"])
      .toContain("tests/postgres-xero-provenance.integration.test.ts");
  });

  it.each(["xero_mcp", "postgres", "template0", "template1", "production_test"])(
    "rejects the non-test database name %s",
    (databaseName) => {
      const result = runGuard(
        `postgresql://test-user:test-password@127.0.0.1:5432/${databaseName}`,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("TEST_DATABASE_URL_UNSAFE");
    },
  );

  it.each(["xero_mcp_test", "xero_mcp_test_release_20260807"])(
    "accepts the explicit disposable test database name %s",
    (databaseName) => {
      const result = runGuard(
        `postgresql://test-user:test-password@127.0.0.1:5432/${databaseName}?sslmode=disable`,
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    },
  );

  it("includes every PostgreSQL integration test in the required release command", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const requiredCommand = packageJson.scripts?.["test:postgres:required"] ?? "";
    const postgresIntegrationTests = readdirSync(resolve(process.cwd(), "tests"))
      .filter((file) => /^postgres-.*\.integration\.test\.ts$/u.test(file))
      .sort();

    expect(postgresIntegrationTests.length).toBeGreaterThan(0);
    for (const file of postgresIntegrationTests) {
      expect(requiredCommand).toContain(`tests/${file}`);
    }
    expect(requiredCommand).toContain("--maxWorkers=1");
  });
});
