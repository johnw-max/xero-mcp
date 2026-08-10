import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AppConfig } from "../../src/config.js";
import { InMemoryAccountingRepository } from "../../src/db/inMemoryRepository.js";
import type { AccountingRepository } from "../../src/db/repository.js";
import type { ResolvedMcpAccessToken } from "../../src/domain/models.js";
import type { Logger } from "../../src/logging.js";
import { createAccountingMcpServer } from "../../src/mcp/createServer.js";
import { createOAuthRequestContext } from "../../src/security/requestContext.js";
import { AccountingService } from "../../src/services/accountingService.js";
import { ConnectionTicketService } from "../../src/services/connectionTicketService.js";
import { XeroMutationService } from "../../src/services/xeroMutationService.js";
import {
  SYNTHETIC_CONNECTION_ID,
} from "../lib/syntheticXeroAccountingProvider.js";
import { SyntheticXeroWriteProvider } from "../lib/syntheticXeroWriteProvider.js";

// The compiled runtime is launched from the repository root. Resolving the
// fixture from cwd keeps the source and precompiled entrypoints equivalent.
const projectRoot = resolve(process.cwd());
const ledgerFixturePath = resolve(projectRoot, "harness/fixtures/xero/synthetic-ledger.json");
const writeEnabled = process.env.XERO_SYNTHETIC_WRITE_ENABLED === "true";
const confirmationSecret = "local-agent-synthetic-confirmation-secret-v1";

function logger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function resolvedToken(tenantId: string): ResolvedMcpAccessToken {
  const audience = "stdio://xero-synthetic-business-uat/mcp";
  return {
    tokenId: "token_local_agent_001",
    clientId: "codex-local-business-uat",
    resource: audience,
    audience,
    grantedScopes: ["xero.read", "xero.draft.write"],
    issuedAt: new Date("2026-08-08T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    installationId: "installation_local_agent_001",
    bindingId: "binding_local_agent_001",
    connectionId: SYNTHETIC_CONNECTION_ID,
    authorizationId: "authorization_local_agent_001",
    workspaceId: "workspace_local_agent",
    subjectType: "USER",
    subjectId: "accountant_local_agent",
    agentId: "agent_local_business_uat",
    policyId: "policy_local_agent_draft_only",
    tenantId,
  };
}

function repositoryWithExactBinding(
  backing: InMemoryAccountingRepository,
  token: ResolvedMcpAccessToken,
  tenantName: string,
): AccountingRepository {
  return new Proxy(backing, {
    get(target, property) {
      if (property === "resolveAgentConnectionBinding") {
        return async (input: {
          installationId: string;
          bindingId: string;
          workspaceId: string;
          subjectType: "USER" | "SERVICE_ACCOUNT";
          subjectId: string;
          agentId: string;
          connectionId: string;
        }) => {
          if (
            input.installationId !== token.installationId ||
            input.bindingId !== token.bindingId ||
            input.workspaceId !== token.workspaceId ||
            input.subjectType !== token.subjectType ||
            input.subjectId !== token.subjectId ||
            input.agentId !== token.agentId ||
            input.connectionId !== token.connectionId
          ) return undefined;
          return {
            installationId: token.installationId,
            bindingId: token.bindingId,
            workspaceId: token.workspaceId,
            subjectType: token.subjectType,
            subjectId: token.subjectId,
            agentId: token.agentId,
            connectionId: token.connectionId,
            authorizationId: token.authorizationId,
            tenantId: token.tenantId,
            tenantName,
            policyId: token.policyId,
          };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AccountingRepository;
}

async function main(): Promise<void> {
  const fixture = JSON.parse(await readFile(ledgerFixturePath, "utf8")) as unknown;
  const provider = new SyntheticXeroWriteProvider(fixture, () => writeEnabled);
  const token = resolvedToken(provider.tenantId);
  const backing = new InMemoryAccountingRepository();
  const repository = repositoryWithExactBinding(backing, token, provider.tenantName);
  const config: Pick<AppConfig, "publicBaseUrl" | "xeroWriteEnabled" | "xeroAllowedTenantId"> = {
    publicBaseUrl: "https://xero-synthetic-business-uat.invalid",
    xeroWriteEnabled: writeEnabled,
    xeroAllowedTenantId: provider.tenantId,
  };
  const service = new AccountingService({
    repository,
    provider,
    config,
    logger: logger(),
    connectionTickets: new ConnectionTicketService(
      repository,
      "https://xero-synthetic-business-uat.invalid",
    ),
    mutationFoundation: new XeroMutationService(repository, { confirmationSecret }),
  });
  const context = createOAuthRequestContext({
    issuer: "https://issuer.xero-synthetic-business-uat.invalid",
    resolvedToken: token,
  });
  const server = createAccountingMcpServer(service, context);
  await server.connect(new StdioServerTransport());
}

await main();
