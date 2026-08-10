import pg from "pg";
import type { QuickBooksClientManager } from "../quickbooks/clientManager.js";
import { QuickBooksPostgresMcpOAuthRepository } from "../quickbooks/mcpOAuthRepository.js";
import { QuickBooksMcpOAuthService } from "../quickbooks/mcpOAuthService.js";
import { Aes256GcmTokenCipher } from "../security/tokenCipher.js";

const { Pool } = pg;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  let now = new Date("2026-08-06T00:00:00.000Z");
  let revokedActorId: string | undefined;
  const service = new QuickBooksMcpOAuthService({
    repository: new QuickBooksPostgresMcpOAuthRepository(pool),
    manager: {
      connect: async (input: { actorId: string; realmId: string }) => ({
        connectionId: "qbc-postgres-concurrency",
        actorId: input.actorId,
        realmId: input.realmId,
        companyName: "OAuth Concurrency Test Company",
        grantedScopes: ["com.intuit.quickbooks.accounting"],
      }),
    } as unknown as QuickBooksClientManager,
    qbo: {
      clientId: "intuit-concurrency-client",
      clientSecret: "intuit-concurrency-secret",
      redirectUri: "https://quickbooks-mcp.example.test/oauth/quickbooks/callback",
      environment: "sandbox",
      request: async () => new Response(JSON.stringify({
        access_token: "intuit-concurrency-access",
        refresh_token: "intuit-concurrency-refresh",
        expires_in: 3_600,
        x_refresh_token_expires_in: 8_640_000,
        token_type: "bearer",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    },
    client: {
      clientId: "agent2-quickbooks-concurrency",
      clientSecret: "s".repeat(48),
      redirectUris: ["https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback"],
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 86_400,
    },
    cipher: new Aes256GcmTokenCipher(Buffer.alloc(32, 19)),
    clock: () => now,
    onActorSecurityRevoked: async (actorId) => { revokedActorId = actorId; },
  });

  try {
    const started = await service.startAuthorization({
      clientId: "agent2-quickbooks-concurrency",
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
      responseType: "code",
      state: "postgres-concurrency-state",
    });
    const consent = new URL(started.consentUrl);
    const callback = await service.handleQuickBooksCallback({
      browserCookie: started.browserCookie,
      state: consent.searchParams.get("state") as string,
      code: "intuit-concurrency-code",
      realmId: "9341457658718743",
    });
    assert(callback.actorId, "OAuth callback did not bind an actor");
    const authorizationCode = new URL(callback.redirectUrl).searchParams.get("code");
    assert(authorizationCode, "OAuth callback did not issue an authorization code");
    const issued = await service.exchangeAuthorizationCode({
      clientId: "agent2-quickbooks-concurrency",
      clientSecret: "s".repeat(48),
      code: authorizationCode,
      redirectUri: "https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback",
    });

    const parallel = await Promise.all(Array.from({ length: 50 }, () => service.refresh({
      clientId: "agent2-quickbooks-concurrency",
      clientSecret: "s".repeat(48),
      refreshToken: issued.refresh_token,
    })));
    const descendant = parallel[0];
    assert(descendant, "No refresh response was returned");
    assert(parallel.every((response) =>
      response.access_token === descendant.access_token && response.refresh_token === descendant.refresh_token
    ), "Parallel refresh responses diverged");
    assert(await service.verifyAccessToken(issued.access_token), "Original in-flight access token was invalidated early");
    assert(await service.verifyAccessToken(descendant.access_token), "Descendant access token is not valid");

    const currentRetry = await service.refresh({
      clientId: "agent2-quickbooks-concurrency",
      clientSecret: "s".repeat(48),
      refreshToken: descendant.refresh_token,
    });
    assert(currentRetry.access_token === descendant.access_token, "Current-token retry was not coalesced");
    assert(currentRetry.refresh_token === descendant.refresh_token, "Current refresh token rotated inside the grace window");

    now = new Date(now.getTime() + 10_001);
    const newest = await service.refresh({
      clientId: "agent2-quickbooks-concurrency",
      clientSecret: "s".repeat(48),
      refreshToken: descendant.refresh_token,
    });
    assert(newest.refresh_token !== descendant.refresh_token, "Current refresh token did not rotate after grace");
    assert(await service.verifyAccessToken(descendant.access_token), "Prior access token did not survive its original TTL");

    let replayRejected = false;
    try {
      await service.refresh({
        clientId: "agent2-quickbooks-concurrency",
        clientSecret: "s".repeat(48),
        refreshToken: issued.refresh_token,
      });
    } catch {
      replayRejected = true;
    }
    assert(replayRejected, "Out-of-window refresh replay was accepted");
    assert(revokedActorId === callback.actorId, "Refresh replay did not revoke the bound actor family");
    assert(!(await service.verifyAccessToken(newest.access_token)), "Revoked descendant access token remained valid");

    const count = await pool.query<{ refresh_version: number }>(
      "SELECT refresh_version FROM quickbooks_mcp_oauth_tokens WHERE actor_id=$1",
      [callback.actorId],
    );
    assert(count.rows[0]?.refresh_version === 2, "Parallel refresh performed more than one rotation");
    console.log(JSON.stringify({
      status: "ok",
      parallelRefreshes: parallel.length,
      identicalResponses: true,
      accessOverlapVerified: true,
      refreshVersion: count.rows[0].refresh_version,
      replayFamilyRevoked: true,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "failed", errorClass: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
});
