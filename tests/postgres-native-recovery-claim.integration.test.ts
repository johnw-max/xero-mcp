import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAccountingRepository } from "../src/db/postgresRepository.js";
import { hashObject } from "../src/security/hash.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Postgres migration 040 native recovery claim", () => {
  const firstRepository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;
  const secondRepository = databaseUrl ? new PostgresAccountingRepository(databaseUrl) : undefined;
  const suffix = randomUUID();
  const workspaceId = `workspace-native-recovery-${suffix}`;
  const subjectId = `user-native-recovery-${suffix}`;
  const actorId = `${workspaceId}:user:${subjectId}`;
  const tenantId = `tenant-native-recovery-${suffix}`;
  const installationId = `installation-native-recovery-${suffix}`;
  const bindingId = `binding-native-recovery-${suffix}`;
  const connectionId = `connection-native-recovery-${suffix}`;
  const authorizationId = `authorization-native-recovery-${suffix}`;
  const agentId = `agent-native-recovery-${suffix}`;
  const targetSessionId = `target-session-native-recovery-${suffix}`;
  const targetSessionHash = hashObject({ kind: "postgres-native-recovery-target", suffix });
  const preparationId = `xmp_${hashObject({ kind: "postgres-native-recovery-preparation", suffix }).slice(0, 32)}`;
  const mutationRequestId = `xmr_${hashObject({ kind: "postgres-native-recovery-request", suffix }).slice(0, 32)}`;
  const requestId = `native-recovery-${suffix}`;
  const objectType = "QUOTE" as const;
  const operation = "CREATE_DRAFT" as const;
  const canonicalPayload = Object.freeze({
    objectType,
    status: "DRAFT",
    reference: `NATIVE-RECOVERY-${suffix}`,
  });
  const canonicalPayloadHash = hashObject(canonicalPayload);
  const sourceRef = `host-upload:native-recovery-${suffix}`;
  const sourceUnitKey = `document:native-recovery-${suffix}`;
  const sourceSha256 = "a".repeat(64);
  const sourceEvidenceType = "SERVER_FINGERPRINTED_EXTRACTION" as const;
  const confirmationSummaryHash = hashObject({ reference: canonicalPayload.reference, status: "DRAFT" });
  const confirmationPhraseHash = hashObject(`CONFIRM-NATIVE-RECOVERY-${suffix}`);
  const authoritySnapshotHash = "f".repeat(64);
  const initialWriteReceipt = Object.freeze({
    providerRequestId: `provider-unknown-${suffix}`,
    outcome: "RESPONSE_LOST",
  });
  let repositoryNow = new Date();
  let preparationExpiresAt = new Date();
  let targetSessionExpiresAt = new Date();

  beforeAll(async () => {
    if (!databaseUrl || !firstRepository) throw new Error("TEST_DATABASE_URL is required");
    await runMigrations(databaseUrl, resolve(process.cwd(), "migrations"));
    const clock = await firstRepository.pool.query<{ repository_now: Date }>(
      "SELECT statement_timestamp() AS repository_now",
    );
    const observed = clock.rows[0]?.repository_now;
    if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
      throw new Error("PostgreSQL did not return a valid test fixture timestamp");
    }
    repositoryNow = observed;
    preparationExpiresAt = new Date(observed.getTime() + 60 * 60_000);
    targetSessionExpiresAt = new Date(observed.getTime() + 2 * 60 * 60_000);

    await firstRepository.saveProviderAuthorization({
      authorizationId,
      workspaceId,
      authorizedBySubject: subjectId,
      provider: "xero",
      grantedScopes: ["accounting.transactions"],
      tokenCiphertext: `encrypted-${suffix}`,
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      refreshVersion: 0,
      status: "ACTIVE",
      createdAt: repositoryNow,
      updatedAt: repositoryNow,
    });
    await firstRepository.upsertAuthorizedProviderConnection(workspaceId, {
      connectionId,
      authorizationId,
      provider: "xero",
      providerConnectionId: `xero-connection-${suffix}`,
      tenantId,
      tenantName: "Native recovery claim integration test",
      status: "ACTIVE",
      lastVerifiedAt: repositoryNow,
      createdAt: repositoryNow,
      updatedAt: repositoryNow,
    });
    await firstRepository.saveOAuthInstallation({
      installationId,
      workspaceId,
      subjectType: "USER",
      subjectId,
      agentId,
      clientId: `client-native-recovery-${suffix}`,
      status: "ACTIVE",
      createdAt: repositoryNow,
      updatedAt: repositoryNow,
    });
    await firstRepository.saveAgentConnectionBinding({
      bindingId,
      installationId,
      workspaceId,
      subjectType: "USER",
      subjectId,
      agentId,
      connectionId,
      policyId: `policy-native-recovery-${suffix}`,
      status: "ACTIVE",
      createdAt: repositoryNow,
      updatedAt: repositoryNow,
    });
    await firstRepository.saveLedgerTargetSession({
      sessionId: targetSessionId,
      sessionHash: targetSessionHash,
      installationId,
      bindingId,
      connectionId,
      bindingRevision: 1,
      createdAt: repositoryNow,
      expiresAt: targetSessionExpiresAt,
    });

    await firstRepository.createXeroMutationPreparation({
      preparationId,
      actorId,
      workspaceId,
      tenantId,
      installationId,
      bindingId,
      connectionId,
      bindingRevision: 1,
      targetSessionId,
      objectType,
      operation,
      canonicalPayload,
      canonicalPayloadHash,
      sourceRef,
      sourceUnitKey,
      sourceSha256,
      sourceEvidenceType,
      confirmationSummaryHash,
      confirmationPhraseHash,
      expiresAt: preparationExpiresAt,
      now: repositoryNow,
    });

    const confirmation = await firstRepository.confirmXeroMutationPreparation({
      mutationRequestId,
      preparationId,
      requestId,
      actorId,
      workspaceId,
      tenantId,
      installationId,
      bindingId,
      connectionId,
      bindingRevision: 1,
      targetSessionId,
      objectType,
      operation,
      canonicalPayload,
      canonicalPayloadHash,
      sourceRef,
      sourceUnitKey,
      sourceSha256,
      sourceEvidenceType,
      confirmationSummaryHash,
      confirmationPhraseHash,
      authorizationReceipt: {
        receiptType: "XERO_PROVIDER_WRITE_AUTHORIZATION",
        agentId,
        actionId: "quote.create_draft",
        authoritySnapshotRevision: 1,
        authoritySnapshotHash,
      },
      claimForWrite: true,
      now: repositoryNow,
    });
    expect(confirmation?.created).toBe(true);
    expect(confirmation?.request.state).toBe("WRITE_IN_FLIGHT");
  });

  afterAll(async () => {
    if (!firstRepository) return;
    await firstRepository.pool.query("DELETE FROM xero_mutation_requests WHERE mutation_request_id = $1", [mutationRequestId]);
    await firstRepository.pool.query("DELETE FROM xero_mutation_preparations WHERE preparation_id = $1", [preparationId]);
    await firstRepository.pool.query("DELETE FROM ledger_target_sessions WHERE session_hash = $1", [targetSessionHash]);
    await firstRepository.pool.query(
      "DELETE FROM oauth_installation_active_bindings WHERE oauth_installation_id = $1",
      [installationId],
    );
    await firstRepository.pool.query("DELETE FROM agent_connection_bindings WHERE binding_id = $1", [bindingId]);
    await firstRepository.pool.query("DELETE FROM oauth_installations WHERE installation_id = $1", [installationId]);
    await firstRepository.pool.query("DELETE FROM provider_connections WHERE connection_id = $1", [connectionId]);
    await firstRepository.pool.query("DELETE FROM provider_authorizations WHERE authorization_id = $1", [authorizationId]);
    await firstRepository.close();
    await secondRepository?.close();
  });

  it("persists one native_recovery_claim independently of write_receipt under concurrent Postgres claims", async () => {
    if (!firstRepository || !secondRepository) throw new Error("TEST_DATABASE_URL is required");
    const inFlight = await firstRepository.getXeroMutationRequest(mutationRequestId);
    if (!inFlight?.writeStartedAt) throw new Error("expected a durable WRITE_IN_FLIGHT timestamp");

    const unknownAt = new Date(inFlight.writeStartedAt.getTime() + 1_000);
    const uncertain = await firstRepository.markXeroMutationWriteUnknown({
      mutationRequestId,
      actorId,
      workspaceId,
      tenantId,
      installationId,
      bindingId,
      connectionId,
      bindingRevision: 1,
      targetSessionId,
      objectType,
      operation,
      canonicalPayloadHash,
      sourceRef,
      sourceUnitKey,
      sourceSha256,
      sourceEvidenceType,
      now: unknownAt,
      writeReceipt: initialWriteReceipt,
    });
    expect(uncertain.state).toBe("WRITE_UNCERTAIN");
    expect(uncertain.writeReceipt).toEqual(initialWriteReceipt);
    expect(uncertain.nativeRecoveryClaim).toBeUndefined();

    const claimNow = uncertain.writeUnknownAt;
    if (!claimNow || !uncertain.writeStartedAt) throw new Error("expected durable uncertainty timestamps");
    const claimTemplate = {
      receiptType: "XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM" as const,
      mutationRequestId,
      canonicalPayloadHash,
      actionId: "quote.create_draft",
      adapterOperation: "XeroControlledMutationProvider.createQuoteDraft",
      tenantId,
      actorId,
      workspaceId,
      agentId,
      installationId,
      bindingId,
      bindingRevision: 1,
      connectionId,
      targetSessionId,
      authoritySnapshotRevision: 1,
      authoritySnapshotHash,
      claimedAt: claimNow.toISOString(),
      expiresAt: new Date(uncertain.writeStartedAt.getTime() + 5 * 60_000).toISOString(),
    };
    const claims = [
      { ...claimTemplate, claimId: `claim-a-${suffix}` },
      { ...claimTemplate, claimId: `claim-b-${suffix}` },
    ];
    const boundInput = {
      mutationRequestId,
      actorId,
      workspaceId,
      tenantId,
      installationId,
      bindingId,
      connectionId,
      bindingRevision: 1,
      targetSessionId,
      objectType,
      operation,
      canonicalPayloadHash,
      sourceRef,
      sourceUnitKey,
      sourceSha256,
      sourceEvidenceType,
      now: claimNow,
    };

    const outcomes = await Promise.allSettled([
      firstRepository.markXeroMutationWriteUnknown({ ...boundInput, nativeRecoveryClaim: claims[0] }),
      secondRepository.markXeroMutationWriteUnknown({ ...boundInput, nativeRecoveryClaim: claims[1] }),
    ]);
    const successes = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<typeof uncertain> => outcome.status === "fulfilled",
    );
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ code: "CONFLICT" });

    const winningClaimId = successes[0]?.value.nativeRecoveryClaim?.claimId;
    expect(claims.map((claim) => claim.claimId)).toContain(winningClaimId);
    const persisted = await firstRepository.pool.query<{
      write_receipt: Record<string, unknown>;
      native_recovery_claim: Record<string, unknown>;
    }>(
      "SELECT write_receipt, native_recovery_claim FROM xero_mutation_requests WHERE mutation_request_id = $1",
      [mutationRequestId],
    );
    expect(persisted.rows[0]?.write_receipt).toEqual(initialWriteReceipt);
    expect(persisted.rows[0]?.native_recovery_claim).toMatchObject({
      receiptType: "XERO_NATIVE_IDEMPOTENCY_RECOVERY_CLAIM",
      mutationRequestId,
      claimId: winningClaimId,
    });

    await expect(firstRepository.pool.query(
      `UPDATE xero_mutation_requests
       SET write_receipt = $2::jsonb
       WHERE mutation_request_id = $1`,
      [mutationRequestId, { ...initialWriteReceipt, nativeRecoveryClaim: claims[0] }],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(firstRepository.getXeroMutationRequest(mutationRequestId)).resolves.toMatchObject({
      state: "WRITE_UNCERTAIN",
      writeReceipt: initialWriteReceipt,
      nativeRecoveryClaim: expect.objectContaining({ claimId: winningClaimId }),
    });
  });
});
