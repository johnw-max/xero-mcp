import { loadConfig } from "./config.js";
import type { Server } from "node:http";
import { PostgresAccountingRepository } from "./db/postgresRepository.js";
import { createHttpApp } from "./http/app.js";
import { createLogger } from "./logging.js";
import { XeroOAuthService } from "./oauth/xeroOAuthService.js";
import { BrokerXeroAuthorizationService } from "./oauth/brokerXeroAuthorizationService.js";
import { McpOAuthBrokerProvider } from "./oauth/mcpOAuthBrokerProvider.js";
import { McpOAuthTokenService } from "./oauth/mcpOAuthTokenService.js";
import { XeroClientManager } from "./providers/xeroClientManager.js";
import { XeroAccountingProvider } from "./providers/xeroProvider.js";
import { XeroControlledMutationProvider } from "./providers/xeroControlledMutationProvider.js";
import { XeroCreditNoteManualJournalProvider } from "./providers/xeroCreditNoteManualJournalProvider.js";
import { XeroContactItemMutationProvider } from "./providers/xeroContactItemMutationProvider.js";
import { Aes256GcmTokenCipher } from "./security/tokenCipher.js";
import { AccountingService } from "./services/accountingService.js";
import { ConnectionTicketService } from "./services/connectionTicketService.js";
import { EphemeralCleanupService } from "./services/ephemeralCleanupService.js";
import { ReviewService } from "./services/reviewService.js";
import { XeroControlledMutationService } from "./services/xeroControlledMutationService.js";
import { XeroCreditNoteManualJournalService } from "./services/xeroCreditNoteManualJournalService.js";
import { XeroContactItemMutationService } from "./services/xeroContactItemMutationService.js";
import { XeroMutationService } from "./services/xeroMutationService.js";
import { OrganisationSwitchService } from "./services/organisationSwitchService.js";

const XERO_CONTACT_NAMESPACE = "zcacct";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const repository = new PostgresAccountingRepository(config.databaseUrl);
  const cipher = new Aes256GcmTokenCipher(config.tokenEncryptionKey);
  const manager = new XeroClientManager({
    repository,
    cipher,
    config: config.xero,
    logger,
    legacyWriteEnabled: config.xeroWriteEnabled,
  });
  const provider = new XeroAccountingProvider(repository, manager, undefined, config.xeroWriteEnabled);
  const mutationFoundation = new XeroMutationService(repository, {
    confirmationSecret: config.xeroMutationConfirmationKey,
  });
  const controlledMutations = new XeroControlledMutationService(
    provider,
    new XeroControlledMutationProvider(manager),
    mutationFoundation,
    config,
  );
  const creditNoteManualJournalMutations = new XeroCreditNoteManualJournalService(
    provider,
    new XeroCreditNoteManualJournalProvider(manager),
    mutationFoundation,
    config,
  );
  const contactItemMutations = new XeroContactItemMutationService(
    provider,
    new XeroContactItemMutationProvider(manager, XERO_CONTACT_NAMESPACE),
    mutationFoundation,
    { ...config, contactNamespace: XERO_CONTACT_NAMESPACE },
  );
  const connectionTickets = new ConnectionTicketService(repository, config.publicBaseUrl);
  const accountingService = new AccountingService({
    repository,
    provider,
    config,
    logger,
    connectionTickets,
    controlledMutations,
    creditNoteManualJournalMutations,
    contactItemMutations,
    mutationFoundation,
  });
  const reviewService = new ReviewService(repository);
  const oauthService = new XeroOAuthService({ repository, manager, cipher, config });
  const brokerConfig = config.mcpOAuthBroker;
  const organisationSwitchService = brokerConfig?.enabled
    ? new OrganisationSwitchService({
        repository,
        publicBaseUrl: config.publicBaseUrl,
        // Domain-separated HMAC use; no confirmation token or raw ticket is persisted.
        secret: config.xeroMutationConfirmationKey,
      })
    : undefined;
  const mcpOAuthProvider = brokerConfig?.enabled
    ? new McpOAuthBrokerProvider({
        config,
        repository,
        manager,
        xeroAuthorization: new BrokerXeroAuthorizationService({ manager, cipher, config, logger }),
        tokens: new McpOAuthTokenService({ config: brokerConfig, repository, cipher }),
      })
    : undefined;
  const ephemeralCleanup = new EphemeralCleanupService({ repository, logger });
  const app = createHttpApp({
    config,
    repository,
    accountingService,
    oauthService,
    reviewService,
    connectionTickets,
    logger,
    ...(mcpOAuthProvider ? { mcpOAuthProvider } : {}),
    ...(organisationSwitchService ? { organisationSwitchService } : {}),
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(config.port, config.host);
    const onError = (error: Error) => {
      candidate.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      candidate.off("error", onError);
      resolve(candidate);
    };
    candidate.once("error", onError);
    candidate.once("listening", onListening);
  });
  logger.info("Accounting MCP server started.", { host: config.host, port: config.port });
  ephemeralCleanup.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Accounting MCP server stopping.");
    try {
      await ephemeralCleanup.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    } finally {
      await repository.close();
    }
  };
  const requestShutdown = () => {
    void shutdown().catch((error: unknown) => {
      logger.error("Accounting MCP server shutdown failed.", {
        errorClass: error instanceof Error ? error.name : "ShutdownError",
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
}

main().catch((error: unknown) => {
  const errorClass = error instanceof Error ? error.name : "StartupError";
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", message: "Startup failed.", errorClass }));
  process.exitCode = 1;
});
