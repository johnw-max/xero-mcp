import { describe, expect, it } from "vitest";
import {
  generateOAuthSecret,
  isValidPkceVerifier,
  keyedOAuthSecretHash,
  pkceS256Challenge,
} from "../src/security/oauthSecrets.js";

describe("OAuth secret primitives", () => {
  it("generates distinct 256-bit base64url secrets", () => {
    const left = generateOAuthSecret();
    const right = generateOAuthSecret();

    expect(left).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(left, "base64url")).toHaveLength(32);
    expect(right).not.toBe(left);
  });

  it("domain-separates keyed hashes", () => {
    const key = Buffer.alloc(32, 7);
    const raw = "A".repeat(43);

    expect(keyedOAuthSecretHash(key, "access_token", raw)).not.toBe(
      keyedOAuthSecretHash(key, "refresh_token", raw),
    );
    expect(keyedOAuthSecretHash(key, "access_token", raw)).toBe(
      keyedOAuthSecretHash(key, "access_token", raw),
    );
  });

  it("rejects non-32-byte hash keys", () => {
    expect(() => keyedOAuthSecretHash(Buffer.alloc(31), "access_token", "secret")).toThrow(
      /exactly 32 bytes/i,
    );
  });

  it("implements the RFC 7636 S256 example", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(isValidPkceVerifier(verifier)).toBe(true);
    expect(pkceS256Challenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("enforces the RFC 7636 verifier alphabet and length", () => {
    expect(isValidPkceVerifier("a".repeat(42))).toBe(false);
    expect(isValidPkceVerifier("a".repeat(43))).toBe(true);
    expect(isValidPkceVerifier("a".repeat(128))).toBe(true);
    expect(isValidPkceVerifier("a".repeat(129))).toBe(false);
    expect(isValidPkceVerifier(`${"a".repeat(42)}!`)).toBe(false);
  });
});
