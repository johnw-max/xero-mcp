import { describe, expect, it } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";

describe("portable governance audit envelope", () => {
  it("creates a versioned tamper-evident chain without storing prompts, OAuth tokens, or chain-of-thought", async () => {
    const repository = new InMemoryAccountingRepository();
    const first = await repository.appendGovernanceAuditEvent({
      eventId: "event-switch-requested",
      streamId: "installation:installation-1",
      schemaVersion: "zcloak.governance-event.v1",
      eventType: "xero.organisation_switch.requested",
      source: "MCP",
      action: "xero.organisation.switch",
      actorId: "workspace-1:user:user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      installationId: "installation-1",
      bindingId: "binding-a",
      connectionId: "connection-a",
      tenantId: "tenant-a",
      correlationId: "call-1",
      disposition: "ESCALATE",
      outcome: "PROPOSED",
      inputHash: "a".repeat(64),
      evidence: { confirmationMode: "MCP_HOSTED_ONE_TIME_LINK" },
      occurredAt: new Date("2026-08-10T04:00:00.000Z"),
    });
    const second = await repository.appendGovernanceAuditEvent({
      eventId: "event-switch-completed",
      streamId: "installation:installation-1",
      schemaVersion: "zcloak.governance-event.v1",
      eventType: "xero.organisation_switch.completed",
      source: "USER_UI",
      action: "xero.organisation.switch",
      actorId: "workspace-1:user:user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      installationId: "installation-1",
      bindingId: "binding-b",
      connectionId: "connection-b",
      tenantId: "tenant-b",
      correlationId: "call-1",
      causationId: first.eventId,
      disposition: "AUTO_EXECUTE",
      outcome: "SUCCEEDED",
      inputHash: "b".repeat(64),
      evidence: { confirmationMode: "MCP_HOSTED_ONE_TIME_LINK" },
      occurredAt: new Date("2026-08-10T04:01:00.000Z"),
    });

    expect(first.previousEventHash).toBeUndefined();
    expect(first.eventHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.previousEventHash).toBe(first.eventHash);
    expect(second.eventHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(repository.governanceAuditEvents)).not.toMatch(/access_token|refresh_token|chain.?of.?thought|prompt/iu);
  });
});
