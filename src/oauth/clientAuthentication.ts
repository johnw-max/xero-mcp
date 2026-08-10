import type { NextFunction, Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { safeEqual } from "../security/hash.js";

const DUMMY_CLIENT_SECRET = "0".repeat(43);
const BASIC_SCHEME = /^(?:[Bb][Aa][Ss][Ii][Cc]) +([^\s]+)$/u;
const BASE64_TOKEN = /^[A-Za-z0-9+/]+={0,2}$/u;

type ParsedClientCredentials = {
  clientId: string;
  clientSecrets: readonly [string, string?];
  method: "client_secret_basic" | "client_secret_post";
};

type BodyParameter = {
  present: boolean;
  valid: boolean;
  value: string;
};

function readBodyParameter(request: Request, name: "client_id" | "client_secret"): BodyParameter {
  const body = request.body;
  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, name)) {
    return { present: false, valid: true, value: "" };
  }
  const value = (body as Record<string, unknown>)[name];
  return {
    present: true,
    valid: typeof value === "string",
    value: typeof value === "string" ? value : "",
  };
}

function authorizationHeaderValues(request: Request): string[] {
  const rawValues: string[] = [];
  if (Array.isArray(request.rawHeaders)) {
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === "authorization") {
        rawValues.push(request.rawHeaders[index + 1] ?? "");
      }
    }
  }
  if (rawValues.length > 0) return rawValues;

  const normalized = request.headers?.authorization;
  if (Array.isArray(normalized)) return [...normalized];
  return typeof normalized === "string" ? [normalized] : [];
}

function decodeBase64Utf8(token: string): string | undefined {
  if (!BASE64_TOKEN.test(token) || token.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(token, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== token) {
    return undefined;
  }
  const text = decoded.toString("utf8");
  return Buffer.from(text, "utf8").equals(decoded) ? text : undefined;
}

/** RFC 6749 section 2.3.1 encodes each Basic credential component as form data before base64. */
function decodeFormComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    return undefined;
  }
}

function parseBasicCredentials(header: string): ParsedClientCredentials | undefined {
  const match = BASIC_SCHEME.exec(header);
  const decoded = match?.[1] ? decodeBase64Utf8(match[1]) : undefined;
  if (decoded === undefined) return undefined;
  const separator = decoded.indexOf(":");
  if (separator < 0) return undefined;
  const rawClientId = decoded.slice(0, separator);
  const rawClientSecret = decoded.slice(separator + 1);
  const clientId = decodeFormComponent(rawClientId);
  const clientSecret = decodeFormComponent(rawClientSecret);
  if (clientId === undefined) return undefined;
  // A legacy client can send a configured secret containing a literal malformed
  // percent sequence (for example `%ZZ`). It is safe to consider that raw value
  // only when the client identifier was already canonical and unchanged.
  if (clientSecret === undefined) {
    return rawClientId === clientId
      ? { clientId, clientSecrets: [rawClientSecret], method: "client_secret_basic" }
      : undefined;
  }
  // Some deployed clients construct Basic from raw configured credentials instead
  // of the RFC-required form-encoded components. Preserve strict RFC decoding for
  // the identifier, but accept the raw secret as a second exact candidate when the
  // identifier itself was already canonical and therefore cannot select another client.
  const clientSecrets: readonly [string, string?] = rawClientId === clientId && rawClientSecret !== clientSecret
    ? [clientSecret, rawClientSecret]
    : [clientSecret];
  return { clientId, clientSecrets, method: "client_secret_basic" };
}

function parseClientCredentials(request: Request): ParsedClientCredentials | undefined {
  const clientId = readBodyParameter(request, "client_id");
  const clientSecret = readBodyParameter(request, "client_secret");
  const bodyCredentialsPresent = clientId.present || clientSecret.present;
  const authorizationHeaders = authorizationHeaderValues(request);

  // OAuth clients must use exactly one authentication method. Multiple headers,
  // duplicate body fields (parsed as non-strings), and Header + body mixtures fail closed.
  if (
    authorizationHeaders.length > 1 ||
    !clientId.valid ||
    !clientSecret.valid ||
    (authorizationHeaders.length === 1 && bodyCredentialsPresent)
  ) {
    return undefined;
  }

  if (authorizationHeaders.length === 1) {
    return parseBasicCredentials(authorizationHeaders[0] ?? "");
  }
  if (!clientId.present || !clientSecret.present) return undefined;
  return {
    clientId: clientId.value,
    clientSecrets: [clientSecret.value],
    method: "client_secret_post",
  };
}

function rejectInvalidClient(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("WWW-Authenticate", 'Basic realm="oauth-token", charset="UTF-8"');
  response.status(401).json({
    error: "invalid_client",
    error_description: "OAuth client authentication failed.",
  });
}

/**
 * Performs constant-work confidential-client authentication before the SDK router.
 * The SDK currently reads client credentials from the form body, so a successfully
 * authenticated Basic request is normalized in memory before the SDK repeats its check.
 * Invalid credentials never reach the SDK's non-constant-time comparison.
 */
export function requireConstantTimeOAuthClient(clientsStore: OAuthRegisteredClientsStore) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const credentials = parseClientCredentials(request);
    const client = credentials?.clientId ? await clientsStore.getClient(credentials.clientId) : undefined;
    const expectedSecret = client?.client_secret ?? DUMMY_CLIENT_SECRET;
    const primarySecret = credentials?.clientSecrets[0] ?? "";
    const fallbackSecret = credentials?.clientSecrets[1] ?? "";
    const primaryMatches = safeEqual(primarySecret || DUMMY_CLIENT_SECRET, expectedSecret);
    const fallbackMatches = safeEqual(fallbackSecret || DUMMY_CLIENT_SECRET, expectedSecret);
    const authenticated = Boolean(credentials && client?.client_secret) &&
      (primarySecret.length > 0 || fallbackSecret.length > 0) &&
      (primaryMatches || fallbackMatches);

    if (!authenticated) {
      rejectInvalidClient(response);
      return;
    }
    if (credentials?.method === "client_secret_basic") {
      delete request.headers.authorization;
      request.body = {
        ...(request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {}),
        client_id: credentials.clientId,
        client_secret: expectedSecret,
      };
    }
    next();
  };
}
