import { randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { ProviderConnection } from "../domain/models.js";
import type { AccountingRepository } from "../db/repository.js";
import { AppError } from "../errors.js";
import { sha256 } from "../security/hash.js";
import type { TokenCipher } from "../security/tokenCipher.js";
import { XeroClientManager } from "../providers/xeroClientManager.js";
import {
  describeLegacyXeroScopePolicyProblems,
  leastPrivilegeXeroScopesForLegacy,
} from "../providers/xeroScopes.js";
import { safeXeroTenantShortCode } from "../providers/xeroDeepLinks.js";
import {
  xeroTenantsForAuthenticationEvent,
} from "./xeroAuthenticationEvent.js";

interface XeroTenant {
  authEventId?: unknown;
  tenantId?: string;
  tenantName?: string;
  orgData?: {
    name?: string;
    shortCode?: string;
  };
}

export class XeroOAuthService {
  readonly #repository: AccountingRepository;
  readonly #manager: XeroClientManager;
  readonly #cipher: TokenCipher;
  readonly #config: AppConfig;

  constructor(options: {
    repository: AccountingRepository;
    manager: XeroClientManager;
    cipher: TokenCipher;
    config: AppConfig;
  }) {
    this.#repository = options.repository;
    this.#manager = options.manager;
    this.#cipher = options.cipher;
    this.#config = options.config;
  }

  async start(actorId: string, browserSession: string): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    await this.#repository.saveOAuthState(
      sha256(state),
      sha256(browserSession),
      actorId,
      new Date(Date.now() + 10 * 60_000),
    );
    const scopes = leastPrivilegeXeroScopesForLegacy(
      this.#config.xero.scopes,
      this.#config.xeroWriteEnabled,
    );
    return this.#manager.createOAuthClient(state, scopes).buildConsentUrl();
  }

  async callback(options: {
    state: string;
    browserSession: string;
    queryString: string;
  }): Promise<{ actorId: string; tenantId: string; tenantName: string; scopes: string[] }> {
    const consumed = await this.#repository.consumeOAuthState(
      sha256(options.state),
      sha256(options.browserSession),
      new Date(),
    );
    if (!consumed) {
      throw new AppError("FORBIDDEN", "OAuth state is invalid, expired, already used, or from another browser session.", {
        httpStatus: 403,
      });
    }

    const consentScopes = leastPrivilegeXeroScopesForLegacy(
      this.#config.xero.scopes,
      this.#config.xeroWriteEnabled,
    );
    const client = this.#manager.createOAuthClient(options.state, consentScopes);
    const callbackUrl = `${this.#config.xero.redirectUri}?${options.queryString}`;
    const tokenSet = await client.apiCallback(callbackUrl);
    const tenants = await xeroTenantsForAuthenticationEvent(client, tokenSet.access_token) as XeroTenant[];
    if (tenants.length !== 1 || !tenants[0]?.tenantId) {
      throw new AppError("AMBIGUOUS_CONNECTION", "The current OAuth event must contain exactly one Xero organisation.", {
        httpStatus: 409,
      });
    }

    const tenant = tenants[0];
    const tenantId = tenant.tenantId as string;
    const tenantName = tenant.tenantName ?? tenant.orgData?.name ?? "Xero organisation";
    const tenantShortCode = safeXeroTenantShortCode(tenant.orgData?.shortCode);
    const existing = await this.#repository.getConnectionByActorTenant(consumed.actorId, tenantId);
    const connectionId = existing?.connectionId ?? `conn_${randomUUID()}`;
    const serialized = this.#manager.serializeTokenSet(tokenSet);
    const scopeProblems = describeLegacyXeroScopePolicyProblems(
      serialized.scopes,
      this.#config.xeroWriteEnabled,
    );
    if (scopeProblems.length > 0) {
      throw new AppError(
        "NOT_CONNECTED",
        `Xero did not grant the required least-privilege capabilities: ${scopeProblems.join(", ")}. Re-authorisation is required.`,
        { httpStatus: 409 },
      );
    }
    const now = new Date();
    const connection: ProviderConnection = {
      connectionId,
      actorId: consumed.actorId,
      provider: "xero",
      tenantId,
      tenantName,
      ...(tenantShortCode ? { tenantShortCode } : {}),
      grantedScopes: serialized.scopes,
      tokenCiphertext: this.#cipher.encrypt(serialized.json, connectionId),
      tokenExpiresAt: serialized.expiresAt,
      refreshVersion: existing?.refreshVersion ?? 0,
      status: "ACTIVE",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const saved = await this.#repository.upsertConnection(connection);
    return {
      actorId: consumed.actorId,
      tenantId: saved.tenantId,
      tenantName: saved.tenantName,
      scopes: saved.grantedScopes,
    };
  }
}
