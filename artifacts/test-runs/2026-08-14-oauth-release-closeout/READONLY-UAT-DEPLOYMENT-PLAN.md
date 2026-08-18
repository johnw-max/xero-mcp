# Read-only online UAT deployment plan

Status: `READY_TO_EXECUTE_WHEN_SSH_RECOVERS`

This plan is deliberately narrower than a production autonomous-write release. It exists to prove the OAuth return fix on `mcp.jiayuanwang.xyz` without allowing an accounting-provider mutation or misrepresenting locally generated review evidence as independent acceptance.

## Fixed candidate identity

- release: `0.4.0-rc.1`
- acceptance source SHA-256: `440dfdef916969cacfbe313d5e445b98f70d5c2a6bdd3693ed9f9a7fdd6b6f4b`
- source archive SHA-256: `e1e88ec2e88b97755e2c0798d36cd9f2c9dae37e47d6e5c0ca7e81067ba5da92`
- semantic build identity: `96dacfd3bd55037ee1bb337996a989754f82e0ae86a89e544bbb37cdbe6607ec`
- OCI artifact SHA-256: `bf4bf0cbd99728681e98d95d979e5e0b57781e9eb2c8b8d9618d9a269c378596`
- OCI manifest digest: `sha256:43c1dba6f0f43eaa08bf6fa62fa8201b17a56c0bcb2289af7600bf04f9f8f807`

## Hard invariants

1. `XERO_WRITE_ENABLED=false` before image start, migration, public routing and all OAuth checks.
2. The green process must report version `0.4.0-rc.1`, `processWriteGateEnabled=false`, `writeMode=READ_ONLY`, migration head 039 and the exact build identities above.
3. Blue remains available until every green check passes; an Nginx backup and one-command blue rollback are prepared before switching.
4. No GitHub push, production-write enablement, standing write delegation or firm-governance claim is part of this UAT.
5. The local OCI is labelled `LOCAL_VERIFIED_CANDIDATE`, not `GATE_ACCEPTED`, because the external signed reviewer host is unavailable.

## Execution order

1. Read-only server inventory: active containers, image digests, Nginx upstream, current release env key names, PostgreSQL migration head and authority revision. Do not print secret values.
2. Create a PostgreSQL backup and verify the backup file is non-empty before migration.
3. Copy the exact OCI artifact and receipt to a root-only UAT directory; recompute both hashes on the server and verify the OCI manifest/config/labels against the receipt.
4. Load that OCI archive, run migrations through 039 once, and start an isolated green process on `127.0.0.1:18004` with the hard read-only configuration.
5. Verify green `/healthz`, `/readyz`, OAuth metadata, anonymous MCP 401, malformed MCP 400 and Work/Agent2 CORS before changing public traffic.
6. Atomically route `mcp.jiayuanwang.xyz` to green, run the same public probes, and immediately roll back on any identity or readiness mismatch.
7. Run real Work OAuth: Xero consent -> organisation selection -> direct 302 to the exact Work callback -> Work connected state -> read-only organisation/currency read-back. Capture only non-secret status and receipt metadata.
8. Run Agent2 OAuth separately and confirm its manual-return policy remains independent. Confirm the two installations do not overwrite one another.
9. Keep writes disabled and record the final verdict. Autonomous-write admission remains a separate gate.

## Current blocker

The Hetzner server accepts TCP/22 but closes during SSH key exchange before authentication. IPv6 is not reachable from the workstation. No deployment step starts until a reliable management channel is restored.
