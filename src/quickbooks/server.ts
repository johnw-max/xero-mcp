import type { Server } from "node:http";
import { Pool } from "pg";
import { PostgresAccountingRepository } from "../db/postgresRepository.js";
import { createLogger } from "../logging.js";
import { Aes256GcmTokenCipher } from "../security/tokenCipher.js";
import { QuickBooksClientManager } from "./clientManager.js";
import { QuickBooksPostgresConnectionRepository } from "./connections.js";
import { QuickBooksConnectionTicketService } from "./connectionTicketService.js";
import { loadQuickBooksConfig } from "./config.js";
import { createQuickBooksHttpApp } from "./httpApp.js";
import { QuickBooksOAuthService } from "./oauthService.js";
import { QuickBooksMcpOAuthService } from "./mcpOAuthService.js";
import { QuickBooksPostgresMcpOAuthRepository } from "./mcpOAuthRepository.js";
import { QuickBooksPostgresPostingRepository } from "./postgresRepository.js";
import { ServerBoundQuickBooksProviderResolver } from "./providerResolver.js";
import { QuickBooksReviewService } from "./reviewService.js";
import { QuickBooksWorkflowService } from "./service.js";

async function main(): Promise<void> {
  const config = loadQuickBooksConfig();
  const logger = createLogger(config);
  const sharedRepository = new PostgresAccountingRepository(config.databaseUrl);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const connectionRepository = new QuickBooksPostgresConnectionRepository(pool);
  const postingRepository = new QuickBooksPostgresPostingRepository(pool);
  const cipher = new Aes256GcmTokenCipher(config.tokenEncryptionKey);
  const managerConfig = { ...config.oauth };
  const manager = new QuickBooksClientManager({
    repository: connectionRepository,
    cipher,
    config: managerConfig,
    logger,
  });
  const tickets = new QuickBooksConnectionTicketService(sharedRepository, config.publicBaseUrl);
  const resolver = new ServerBoundQuickBooksProviderResolver({
    manager,
    connectUrl: (actorId) => tickets.issue(actorId),
  });
  const workflow = new QuickBooksWorkflowService({
    repository: postingRepository,
    resolver,
    publicBaseUrl: config.publicBaseUrl,
    writeEnabled: config.writeEnabled,
    ...(config.allowedRealmId ? { allowedRealmId: config.allowedRealmId } : {}),
  });
  const oauth = new QuickBooksOAuthService({
    states: sharedRepository,
    manager,
    config: managerConfig,
  });
  const reviews = new QuickBooksReviewService({
    postings: postingRepository,
    security: sharedRepository,
  });
  const mcpOAuth = config.mcpOAuth ? new QuickBooksMcpOAuthService({
    repository: new QuickBooksPostgresMcpOAuthRepository(pool),
    manager,
    qbo: managerConfig,
    client: config.mcpOAuth,
    cipher,
    onActorSecurityRevoked: async (actorId) => {
      await reviews.revokeActorSessions(actorId);
    },
  }) : undefined;
  const app = createQuickBooksHttpApp({
    config,
    workflow,
    oauth,
    ...(mcpOAuth ? { mcpOAuth } : {}),
    reviews,
    tickets,
    readiness: async () => {
      const [sharedReady, qboReady] = await Promise.all([
        sharedRepository.readiness(),
        pool.query("SELECT 1").then(() => true).catch(() => false),
      ]);
      return sharedReady && qboReady;
    },
    logger,
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
  logger.info("QuickBooks Accounting MCP server started.", { host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("QuickBooks Accounting MCP server stopping.");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([sharedRepository.close(), pool.end()]);
  };
  const requestShutdown = () => {
    void shutdown().catch((error: unknown) => {
      logger.error("QuickBooks Accounting MCP shutdown failed.", {
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
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    message: "QuickBooks startup failed.",
    errorClass,
  }));
  process.exitCode = 1;
});
