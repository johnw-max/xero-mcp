import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("required HTTP OAuth edge release gate", () => {
  it("forces loopback execution for the exact conditional edge test", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["test:http:required"]).toBe(
      "TEST_HTTP_LOOPBACK=true vitest run tests/http-oauth-edge.test.ts",
    );
  });

  it.each([
    "README.md",
    "deploy/HETZNER-HOST-NGINX-RUNBOOK.md",
  ])("keeps the required HTTP command in %s", (relativePath) => {
    const document = readFileSync(resolve(process.cwd(), relativePath), "utf8");

    expect(document).toContain("npm run test:http:required");
  });
});
