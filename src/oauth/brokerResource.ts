import { InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { McpOAuthBrokerConfig } from "../config.js";

type EnabledBrokerConfig = Extract<McpOAuthBrokerConfig, { enabled: true }>;

const INVALID_TARGET_MESSAGE = "The requested OAuth resource is invalid.";

function invalidTarget(): InvalidTargetError {
  return new InvalidTargetError(INVALID_TARGET_MESSAGE);
}

function exactResourceValue(resource: URL | string | undefined): string | undefined {
  if (resource instanceof URL) return resource.href;
  return resource;
}

/**
 * Resolve the resource used for a Host-facing OAuth flow.
 *
 * Missing-resource compatibility is deliberately narrower than normal OAuth
 * validation: it is available only to an exact, pre-registered confidential
 * Host client on the deployment-controlled compatibility allowlist, and only
 * while this Broker has one canonical protected resource. A supplied value is
 * never rewritten.
 */
export function resolveBrokerOAuthResource(
  config: EnabledBrokerConfig,
  clientId: string,
  resource: URL | string | undefined,
): string {
  if (
    config.protectedResourceUris.length !== 1 ||
    config.protectedResourceUris[0] !== config.resourceUri
  ) {
    throw invalidTarget();
  }

  const requested = exactResourceValue(resource);
  if (requested !== undefined) {
    if (requested !== config.resourceUri) throw invalidTarget();
    return config.resourceUri;
  }

  const hostClient = config.hostClients.find((candidate) => candidate.clientId === clientId);
  if (
    !config.personalPocOnly ||
    !hostClient ||
    hostClient.clientSecret.length < 32 ||
    !config.missingResourceCompatClientIds.includes(clientId)
  ) {
    throw invalidTarget();
  }
  return config.resourceUri;
}
