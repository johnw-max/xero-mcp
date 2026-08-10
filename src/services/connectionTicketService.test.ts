import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../db/inMemoryRepository.js";
import { ConnectionTicketService } from "./connectionTicketService.js";

describe("Xero connect ticket", () => {
  it("is short-lived and can be consumed only once", async () => {
    const repository = new InMemoryAccountingRepository();
    const service = new ConnectionTicketService(repository, "https://xero-mcp.example.test");
    const issued = await service.issue("demo-actor");
    const ticket = new URL(issued.url).searchParams.get("ticket") as string;

    await expect(service.consume(ticket)).resolves.toEqual({ actorId: "demo-actor" });
    await expect(service.consume(ticket)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
