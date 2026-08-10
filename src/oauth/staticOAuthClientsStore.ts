import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpOAuthHostClient, McpOAuthScope } from "../config.js";

function freezeClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
  Object.freeze(client.redirect_uris);
  Object.freeze(client.grant_types);
  Object.freeze(client.response_types);
  return Object.freeze(client);
}

/** Immutable, deployment-controlled OAuth client registry. Dynamic registration is intentionally absent. */
export class StaticOAuthClientsStore implements OAuthRegisteredClientsStore {
  readonly #clients = new Map<string, OAuthClientInformationFull>();

  constructor(hostClients: readonly McpOAuthHostClient[], scopes: readonly McpOAuthScope[]) {
    for (const hostClient of hostClients) {
      const client = freezeClient({
        client_id: hostClient.clientId,
        client_secret: hostClient.clientSecret,
        client_name: hostClient.name,
        redirect_uris: [...hostClient.redirectUris],
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: scopes.join(" "),
      });
      if (this.#clients.has(client.client_id)) {
        throw new Error("OAuth client identifiers must be unique.");
      }
      this.#clients.set(client.client_id, client);
    }
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.#clients.get(clientId);
  }
}
