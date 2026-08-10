import { createHash, createHmac, randomBytes } from "node:crypto";

export type OAuthSecretPurpose =
  | "access_token"
  | "authorization_code"
  | "browser_flow"
  | "browser_session"
  | "csrf_token"
  | "host_state"
  | "refresh_token"
  | "xero_state";

/** Generates a URL-safe, 256-bit opaque value. Raw values must never be persisted or logged. */
export function generateOAuthSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Produces a domain-separated keyed hash suitable for persisted OAuth secret lookups.
 * A keyed hash prevents an offline database reader from validating guessed state or token values.
 */
export function keyedOAuthSecretHash(
  key: Buffer,
  purpose: OAuthSecretPurpose,
  rawSecret: string,
): string {
  if (key.length !== 32) throw new Error("OAuth secret hash key must be exactly 32 bytes.");
  return createHmac("sha256", key)
    .update("zcloak-xero-mcp-oauth-v1\0", "utf8")
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(rawSecret, "utf8")
    .digest("hex");
}

/** RFC 7636 S256 transformation. */
export function pkceS256Challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** RFC 7636 verifier syntax and length (43-128 unreserved characters). */
export function isValidPkceVerifier(codeVerifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier);
}
