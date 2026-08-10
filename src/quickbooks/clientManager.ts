import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { Logger } from "../logging.js";
import { QuickBooksApiClient } from "../providers/quickbooksClient.js";
import { refreshQuickBooksToken } from "../providers/quickbooksOAuth.js";
import { QuickBooksAccountingProvider } from "../providers/quickbooksProvider.js";
import {
  QUICKBOOKS_ACCOUNTING_SCOPE,
  type QuickBooksEnvironment,
  type QuickBooksOAuthConfig,
  type QuickBooksTokenSet,
  type QuickBooksTokenSource,
} from "../providers/quickbooksTypes.js";
import type { TokenCipher } from "../security/tokenCipher.js";
import type { QuickBooksConnection, QuickBooksConnectionRepository } from "./connections.js";

interface StoredQuickBooksTokenSet {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  tokenType: string;
}

export interface QuickBooksClientManagerConfig extends QuickBooksOAuthConfig {
  minorVersion?: number;
  request?: typeof fetch;
}

class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

function storedToken(token: QuickBooksTokenSet): StoredQuickBooksTokenSet {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    accessTokenExpiresAt: token.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: token.refreshTokenExpiresAt.toISOString(),
    tokenType: token.tokenType,
  };
}

function parseStoredToken(value: string): QuickBooksTokenSet {
  let parsed: Partial<StoredQuickBooksTokenSet>;
  try {
    parsed = JSON.parse(value) as Partial<StoredQuickBooksTokenSet>;
  } catch (error) {
    throw new AppError("CONFIGURATION_ERROR", "Stored QuickBooks credentials are unreadable.", {
      httpStatus: 500,
      cause: error,
    });
  }
  const accessTokenExpiresAt = new Date(parsed.accessTokenExpiresAt ?? "");
  const refreshTokenExpiresAt = new Date(parsed.refreshTokenExpiresAt ?? "");
  if (
    typeof parsed.accessToken !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    !parsed.accessToken ||
    !parsed.refreshToken ||
    Number.isNaN(accessTokenExpiresAt.getTime()) ||
    Number.isNaN(refreshTokenExpiresAt.getTime())
  ) {
    throw new AppError("CONFIGURATION_ERROR", "Stored QuickBooks credentials are incomplete.", {
      httpStatus: 500,
    });
  }
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    tokenType: parsed.tokenType ?? "bearer",
  };
}

export class QuickBooksClientManager {
  readonly #repository: QuickBooksConnectionRepository;
  readonly #cipher: TokenCipher;
  readonly #config: QuickBooksClientManagerConfig;
  readonly #logger: Logger;
  readonly #mutex = new KeyedMutex();

  constructor(options: {
    repository: QuickBooksConnectionRepository;
    cipher: TokenCipher;
    config: QuickBooksClientManagerConfig;
    logger: Logger;
  }) {
    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#config = options.config;
    this.#logger = options.logger;
  }

  async resolveSingleConnection(actorId: string): Promise<QuickBooksConnection> {
    const connections = await this.#repository.listActive(actorId);
    if (connections.length === 0) {
      throw new AppError("NOT_CONNECTED", "No active QuickBooks company is connected.", { httpStatus: 409 });
    }
    if (connections.length !== 1) {
      throw new AppError("AMBIGUOUS_CONNECTION", "Select exactly one QuickBooks company for this Agent.", {
        httpStatus: 409,
      });
    }
    return connections[0] as QuickBooksConnection;
  }

  async connect(options: {
    actorId: string;
    realmId: string;
    token: QuickBooksTokenSet;
    grantedScopes?: string[];
  }): Promise<QuickBooksConnection> {
    const existing = await this.#repository.get(options.actorId, options.realmId);
    const connectionId = existing?.connectionId ?? `qbc_${randomUUID()}`;
    const provider = this.#provider(options.realmId, {
      accessToken: async () => options.token.accessToken,
      refreshAccessToken: async () => options.token.accessToken,
    });
    const company = await provider.getCompany();
    if (!company.CompanyName) {
      throw new AppError("READBACK_MISMATCH", "QuickBooks CompanyInfo did not include its company name.", {
        httpStatus: 502,
      });
    }
    const now = new Date();
    const tokenCiphertext = this.#cipher.encrypt(JSON.stringify(storedToken(options.token)), connectionId);
    return this.#repository.replaceActive({
      connectionId,
      actorId: options.actorId,
      realmId: options.realmId,
      companyName: company.CompanyName,
      grantedScopes: options.grantedScopes ?? [QUICKBOOKS_ACCOUNTING_SCOPE],
      tokenCiphertext,
      accessTokenExpiresAt: options.token.accessTokenExpiresAt,
      refreshTokenExpiresAt: options.token.refreshTokenExpiresAt,
      refreshVersion: existing?.refreshVersion ?? 0,
      status: "ACTIVE",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async withProvider<T>(
    actorId: string,
    action: (provider: QuickBooksAccountingProvider, connection: QuickBooksConnection) => Promise<T>,
  ): Promise<T> {
    const initial = await this.resolveSingleConnection(actorId);
    return this.#mutex.run(initial.connectionId, async () => {
      let connection = await this.resolveSingleConnection(actorId);
      let token = this.#decrypt(connection);
      if (token.accessTokenExpiresAt.getTime() <= Date.now() + 60_000) {
        ({ connection, token } = await this.#refresh(actorId, connection, token));
      }
      const tokenSource: QuickBooksTokenSource = {
        accessToken: async () => token.accessToken,
        refreshAccessToken: async () => {
          ({ connection, token } = await this.#refresh(actorId, connection, token));
          return token.accessToken;
        },
      };
      return action(this.#provider(connection.realmId, tokenSource), connection);
    });
  }

  #provider(realmId: string, tokenSource: QuickBooksTokenSource): QuickBooksAccountingProvider {
    const client = new QuickBooksApiClient({
      realmId,
      environment: this.#config.environment,
      tokenSource,
      ...(this.#config.request ? { request: this.#config.request } : {}),
      ...(this.#config.minorVersion === undefined ? {} : { minorVersion: this.#config.minorVersion }),
    });
    return new QuickBooksAccountingProvider(client);
  }

  #decrypt(connection: QuickBooksConnection): QuickBooksTokenSet {
    try {
      return parseStoredToken(this.#cipher.decrypt(connection.tokenCiphertext, connection.connectionId));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("CONFIGURATION_ERROR", "Stored QuickBooks credentials are unreadable.", {
        httpStatus: 500,
        cause: error,
      });
    }
  }

  async #refresh(
    actorId: string,
    connection: QuickBooksConnection,
    token: QuickBooksTokenSet,
  ): Promise<{ connection: QuickBooksConnection; token: QuickBooksTokenSet }> {
    if (token.refreshTokenExpiresAt.getTime() <= Date.now()) {
      await this.#repository.markStatusIfVersion({
        connectionId: connection.connectionId,
        expectedRefreshVersion: connection.refreshVersion,
        status: "TOKEN_REFRESH_FAILED",
        now: new Date(),
      });
      throw new AppError("NOT_CONNECTED", "QuickBooks refresh authorization expired; reconnection is required.", {
        httpStatus: 409,
      });
    }
    try {
      const refreshed = await refreshQuickBooksToken({
        config: this.#config,
        refreshToken: token.refreshToken,
        ...(this.#config.request ? { request: this.#config.request } : {}),
      });
      const tokenCiphertext = this.#cipher.encrypt(
        JSON.stringify(storedToken(refreshed)),
        connection.connectionId,
      );
      const saved = await this.#repository.updateRotatedToken({
        connectionId: connection.connectionId,
        expectedRefreshVersion: connection.refreshVersion,
        tokenCiphertext,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
        now: new Date(),
      });
      if (saved) return { connection: saved, token: refreshed };
      const latest = await this.#repository.get(actorId, connection.realmId);
      if (latest?.status === "ACTIVE" && latest.refreshVersion !== connection.refreshVersion) {
        this.#logger.info("QuickBooks token refresh race resolved with a newer active token.", {
          actorId,
          realmId: connection.realmId,
        });
        return { connection: latest, token: this.#decrypt(latest) };
      }
      throw new AppError("NOT_CONNECTED", "QuickBooks connection changed during token refresh.", { httpStatus: 409 });
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_CONNECTED") throw error;
      const marked = await this.#repository.markStatusIfVersion({
        connectionId: connection.connectionId,
        expectedRefreshVersion: connection.refreshVersion,
        status: "TOKEN_REFRESH_FAILED",
        now: new Date(),
      });
      if (!marked) {
        const latest = await this.#repository.get(actorId, connection.realmId);
        if (latest?.status === "ACTIVE" && latest.refreshVersion !== connection.refreshVersion) {
          return { connection: latest, token: this.#decrypt(latest) };
        }
      }
      this.#logger.warn("QuickBooks token refresh failed.", {
        actorId,
        realmId: connection.realmId,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      throw new AppError("NOT_CONNECTED", "QuickBooks connection must be re-authorized.", {
        httpStatus: 409,
        cause: error,
      });
    }
  }
}

export function quickBooksEnvironment(value: string): QuickBooksEnvironment {
  if (value === "sandbox" || value === "production") return value;
  throw new AppError("CONFIGURATION_ERROR", "QuickBooks environment must be sandbox or production.", {
    httpStatus: 500,
  });
}
