import packageJson from "../package.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { XERO_RELEASE_VERSION } from "./xeroRelease.js";

describe("Xero release version contract", () => {
  it("keeps the package and all Xero public surfaces on one build version", () => {
    expect(XERO_RELEASE_VERSION).toBe(packageJson.version);
  });
});
