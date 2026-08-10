import { AppError } from "../errors.js";
import type { XeroClient } from "xero-node";

const MAX_ACCESS_TOKEN_CHARACTERS = 24_576;
const MAX_JWT_PAYLOAD_CHARACTERS = 10_924;
const MAX_AUTHENTICATION_EVENT_ID_CHARACTERS = 128;
const MAX_TOKEN_VISIBLE_CONNECTIONS = 100;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface XeroAuthenticationEventTenant {
  /** Official Xero connection identifier returned by GET /connections. */
  id?: unknown;
  /** Compatibility alias used by some Xero SDK/test representations. */
  connectionId?: unknown;
  authEventId?: unknown;
  tenantId: string;
  tenantName?: string;
  orgData?: {
    organisationID?: string;
    name?: string;
    shortCode?: string;
  };
}

function unusableAuthenticationEvent(cause?: unknown): AppError {
  return new AppError(
    "PROVIDER_ERROR",
    "Xero returned an access token without a usable authentication event.",
    { httpStatus: 502, ...(cause === undefined ? {} : { cause }) },
  );
}

/**
 * apiCallback has already performed the trusted token exchange and JWT checks.
 * This helper only reads the bounded payload needed to bind its connections.
 */
export function xeroAuthenticationEventId(accessToken: unknown): string {
  if (
    typeof accessToken !== "string"
    || accessToken.length === 0
    || accessToken.length > MAX_ACCESS_TOKEN_CHARACTERS
  ) {
    throw unusableAuthenticationEvent();
  }

  const segments = accessToken.split(".");
  const payloadSegment = segments[1];
  if (
    segments.length !== 3
    || !payloadSegment
    || payloadSegment.length > MAX_JWT_PAYLOAD_CHARACTERS
    || !BASE64URL.test(payloadSegment)
  ) {
    throw unusableAuthenticationEvent();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch (error) {
    throw unusableAuthenticationEvent(error);
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw unusableAuthenticationEvent();
  }

  if (!Object.hasOwn(payload, "authentication_event_id")) {
    throw unusableAuthenticationEvent();
  }
  const authenticationEventId = Reflect.get(payload, "authentication_event_id");
  if (
    typeof authenticationEventId !== "string"
    || authenticationEventId.length === 0
    || authenticationEventId.length > MAX_AUTHENTICATION_EVENT_ID_CHARACTERS
    || authenticationEventId !== authenticationEventId.trim()
  ) {
    throw unusableAuthenticationEvent();
  }
  return authenticationEventId;
}

export function belongsToXeroAuthenticationEvent(
  connection: unknown,
  authenticationEventId: string,
): boolean {
  if (typeof connection !== "object" || connection === null) return false;
  if (!Object.hasOwn(connection, "authEventId")) return false;
  const connectionEventId = Reflect.get(connection, "authEventId");
  return typeof connectionEventId === "string"
    && connectionEventId === authenticationEventId;
}

/**
 * Prefer connections created by this callback event. Xero can retain older
 * authEventId values when an existing set of organisations is re-authorised;
 * if none match, every connection returned for the freshly exchanged access
 * token is still token-authorised and is presented for explicit user choice.
 */
export async function xeroTenantsForAuthenticationEvent(
  client: Pick<XeroClient, "updateTenants" | "accountingApi">,
  accessToken: unknown,
): Promise<XeroAuthenticationEventTenant[]> {
  const authenticationEventId = xeroAuthenticationEventId(accessToken);
  const discovered = await client.updateTenants(false);
  if (discovered.length > MAX_TOKEN_VISIBLE_CONNECTIONS) {
    throw new AppError(
      "PROVIDER_ERROR",
      "Xero returned too many organisations for one authorisation.",
      { httpStatus: 502 },
    );
  }
  const eventConnections = discovered.filter((connection) =>
    belongsToXeroAuthenticationEvent(connection, authenticationEventId));

  /*
   * Xero does not always rotate authEventId when existing organisations are
   * re-authorised. updateTenants(false) runs only after the trusted callback
   * exchanged a fresh token, so its returned connections are token-bounded.
   * Multiple fallback connections are never auto-selected: the broker persists
   * them as candidates and requires a same-browser explicit selection next.
   */
  const currentConnections = eventConnections.length > 0
    ? eventConnections
    : discovered;

  return Promise.all(currentConnections.map(async (connection) => {
    const tenantId = typeof connection === "object" && connection !== null
      ? Reflect.get(connection, "tenantId")
      : undefined;
    if (typeof tenantId !== "string" || tenantId.length === 0 || tenantId !== tenantId.trim()) {
      throw new AppError(
        "PROVIDER_ERROR",
        "Xero returned a current-event connection without a usable tenant ID.",
        { httpStatus: 502 },
      );
    }

    const response = await client.accountingApi.getOrganisations(tenantId);
    const organisation = response.body.organisations?.find((candidate) =>
      candidate.organisationID === tenantId);
    const { orgData: _untrustedOrgData, ...connectionFields } = connection as Record<string, unknown>;
    return {
      ...connectionFields,
      tenantId,
      ...(organisation ? { orgData: organisation } : {}),
    } as XeroAuthenticationEventTenant;
  }));
}
