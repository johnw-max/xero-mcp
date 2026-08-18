# Candidate deployment — state at pause

Date: 2026-08-18. Host `offbeatlabs` / `178.156.234.230`, SSH on port 2222
(firewall `xero-mcp-edge-20260814` allow-lists exactly this workstation's egress
IP `51.79.130.17/32`).

## Candidate artifact — built and verified locally

| Field | Value |
|---|---|
| Release version | `0.4.0-rc.1` |
| Build identity hash | `ae300ba6a9cec8c67f533ce98435084daa0d2173e2bc33c0b01ce10465ae0ae0` |
| Acceptance source SHA-256 | `13b2900ccb828816aa157f56fd2d34f5bf8c3e785ecc5545f20649ef1460a8d4` |
| Source archive SHA-256 | `0c3cb5687174ceaad6ada4d56120ce1b4ada12366dfba769a78ad37eecfba2a7` |
| Approved control catalog SHA-256 | `e488e6ed4cdbe665f214a65ce9d55d42ce1ac3adf54e77317078bb0ec7209fbe` |
| OCI manifest digest | `sha256:aba0dfb2f14bd36c65152dd224821eea7fc05971840289eb1dcb285a85df4860` |
| OCI config digest | `sha256:adc523e5acc5cb8fae63e9ca2b9885c18c390f5cd29af4821f489f226edb684a` |
| Required migration | `040_xero_native_idempotency_recovery_claim.sql` |
| Toolset hash / count | `a43155caabe2f4f4ba0c23f1ad37d6abdfdb4761bad3527884d1e9969b730e87` / 28 |

Release bundle build: PASS, 193 files, **`secretFindings: 0`**.
OCI runtime smoke: PASS — migration 040, 28 tools, anonymous MCP 401, malformed
MCP 400, all temporary containers removed by the script's own cleanup.

## Done on the host — nothing live was changed

- Created `/srv/xero-accounting-mcp/releases/043-uat-ae300ba6/` (mode 700).
- Uploaded the OCI artifact, receipt, metadata, source archive, manifest,
  build identity and checksum.
- `docker load` succeeded. The artifact loads under the **mutable tag
  `zcloak/xero-accounting-mcp:accepted`**, which the currently-live 042 container
  also claims, so it was immediately pinned to
  `zcloak/xero-accounting-mcp:043-ae300ba6`.
- Confirmed 042 is a different image: it runs
  `sha256:ec78d6030447bc5deda2b650d61fdc3061cd722a4f75b41ab3ddefa604c66797`.

Live traffic is untouched: nginx still points
`upstream xero_accounting_mcp_demo → 127.0.0.1:18013 →
xero-accounting-mcp-uat-042-work-manual`.

## Deployment model actually in use on this host

The formal admission path is **not** in force here: `/srv/xero-accounting-mcp/release/`
(the directory `admit-and-compose.sh` and `env.vps.example` reference) does not
exist. The real pattern is one directory per release under
`/srv/xero-accounting-mcp/releases/<tag>-<buildIdentityPrefix>/`, a container on a
dedicated loopback port, and an nginx upstream flip. `042-uat-254491cd` matches the
deployed `buildIdentityHash`, confirming the convention.

## Open items before the container can start

### 1. Which Agent2 OAuth client is live — XF-002, unresolved

`oauth_installations` has **two ACTIVE Agent2 clients**:

| Client ID | Installation |
|---|---|
| `agent2-xero-58751518d3dea403` | `installation_71019c89-c371-44ce-a30e-6478d6d453e7` |
| `agent2-xero-bd0796db041ee01e` | `installation_35d1cee9-14a7-40f8-b858-1f71954591da` |

All under workspace `personal-poc`. The historical 0.3.1 write-gate script pins
`agent2-xero-bd0796db041ee01e`. Which one the Agent2 UI actually presents is a
platform-side configuration fact that this database cannot settle. The standing
delegation must name exactly one `installation_id`, so this must be resolved
first — picking wrong yields a delegation that silently never applies.

### 2. Shared database — migration 040 would run under the live 042 container

The candidate requires migration 040. The only application database is `xero_mcp`
in `xero-accounting-mcp-demo-postgres-1`, and the **currently-live 042 container
uses it**. Applying 040 there mutates the schema underneath a running older build.

Two options:

- **Separate database for the candidate** (recommended). Create `xero_mcp_043`,
  migrate it to 040, point the 043 container at it. Live 042 is untouched and
  rollback is a pure nginx flip. Cost: the candidate starts with no existing OAuth
  installations, so Agent2 would need to re-authorise against the new instance —
  which is arguably correct anyway, since XF-003 narrowed the scope set and
  existing authorisations may still carry withdrawn scopes.
- **Shared database, migrate in place.** Keeps existing authorisations, but risks
  the live service and makes rollback no longer purely an nginx flip.

### 3. Standing delegation content

Once (1) and (2) are settled:

```text
XERO_STANDING_DELEGATIONS_JSON=[{"delegation_id":"agent2-uat-043","revision":1,
  "status":"ACTIVE","workspace_id":"personal-poc","agent_id":"<host-client:...>",
  "installation_id":"<chosen installation>",
  "tenant_id":"7c3cc738-eef0-4d4e-83f8-d528390e1e61",
  "action_ids":["customer_invoice.create_draft"]}]
XERO_STANDING_DELEGATIONS_CONFIG_SHA256=<sha256 of that exact JSON string>
```

`customer_invoice.create_draft` per the XF-021 decision. The test tenant
`7c3cc738-eef0-4d4e-83f8-d528390e1e61` is taken from
`scripts/agent2_uat_write_gate_vps.sh`.

### 4. Write gate

Stays closed until the 043 container's `/healthz` reports the candidate identity
above. Then opened only for the single chosen installation and that one tenant.
The historical script's 15-minute systemd autoclose and boot failsafe are the
right pattern to reuse.

## Rollback

Nothing to roll back yet. Once 043 is running on its own port, rollback is
restoring the nginx upstream to `127.0.0.1:18013` and reloading — 042 keeps
running untouched throughout. Previous nginx configs are already retained on the
host as `mcp.jiayuanwang.xyz.pre-*`.
