import { randomBytes } from "node:crypto";
import type { AccountingRepository } from "../db/repository.js";
import { AppError } from "../errors.js";
import { sha256 } from "../security/hash.js";

export class ConnectionTicketService {
  readonly #repository: AccountingRepository;
  readonly #publicBaseUrl: string;

  constructor(repository: AccountingRepository, publicBaseUrl: string) {
    this.#repository = repository;
    this.#publicBaseUrl = publicBaseUrl;
  }

  async issue(actorId: string): Promise<{ url: string; expiresAt: Date }> {
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await this.#repository.saveConnectTicket(sha256(ticket), actorId, expiresAt);
    return {
      url: `${this.#publicBaseUrl}/connect/xero?ticket=${encodeURIComponent(ticket)}`,
      expiresAt,
    };
  }

  async consume(ticket: string): Promise<{ actorId: string }> {
    const consumed = await this.#repository.consumeConnectTicket(sha256(ticket), new Date());
    if (!consumed) {
      throw new AppError("FORBIDDEN", "Xero connect ticket is invalid, expired, or already used.", { httpStatus: 403 });
    }
    return consumed;
  }
}
