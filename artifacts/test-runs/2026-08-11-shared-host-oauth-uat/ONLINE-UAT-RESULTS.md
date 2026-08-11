# Shared Host OAuth Online UAT Results

## Verdict

PASS — the requested early-UAT profile is live. Work and Agent2 each completed an independent OAuth installation, remained active after the second login, and read a different bound Xero organisation through the expected MCP server. Xero writes remained disabled throughout.

## Evidence summary

| Case | Result | Evidence |
|---|---|---|
| OAUTH-WORK-01 | PASS | Work showed `Connected`; `xero_get_organisation` through `zcloak-ledger-mcp-xero-demo` returned `zcloak / HKD`. Screenshot: `work-readback-zcloak-hkd.png`. |
| OAUTH-AGENT2-01 | PASS | Agent2 showed `认证成功/已连接`; `xero_get_organisation` through `accounting-mcp` returned `Demo Company (Global) / USD`. Screenshot: `agent2-readback-demo-company-usd.png`. |
| ISOLATION-01 | PASS | PostgreSQL returned two different ACTIVE installation, subject, binding, connection, tenant and refresh-family tuples; each had one live access token. Work read-back succeeded after Agent2 completed OAuth. |
| CLEANUP-01 | PASS | Temporary load balancer `codex-xero-uat-20260811` was deleted; final `hcloud load-balancer list` returned no rows. |

## Deployment evidence

- Source commit: `fe49ee8`
- Release: `/opt/xero-accounting-mcp-demo-0.3.1-20260811.1`
- Image: `xero-accounting-mcp-demo:0.3.1-shared-host-20260811.1`
- Container: `xero-accounting-mcp-green-030-accounting-mcp-green-1`
- Public health: `status=ok`, version `0.3.1`, 44 tools, toolset hash `d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224`
- Public readiness: `status=ready`
- Runtime gates: `PERSONAL_POC_ONLY=true`, `SHARED_TEST_USERS=true`, `XERO_WRITE_ENABLED=false`

## Isolation evidence

| Host | Installation | Subject | Binding | Connection / tenant | Refresh family | State |
|---|---|---|---|---|---|---|
| Agent2 | `installation_71019c89-c371-44ce-a30e-6478d6d453e7` | `shared-test-installation:installation_71019c89-c371-44ce-a30e-6478d6d453e7` | `binding_39c8de2d-01ff-41c0-b810-59705b8ad968` rev 1 | `conn_d19d6801-6401-4ba1-a3b2-a20d4927dffc` / `Demo Company (Global)` | `refresh_family_d1a2cc45-f36a-409d-a29c-fc1ff248f14f` | ACTIVE; 1 live access token |
| Work | `installation_70be4ac4-fdf6-4a1f-bd5a-1c329273d631` | `shared-test-installation:installation_70be4ac4-fdf6-4a1f-bd5a-1c329273d631` | `binding_bc98cee9-8fff-4ddd-ac33-2c2f6ecf8879` rev 1 | `conn_86f7830f-d912-4281-921f-d97e37886d25` / `zcloak` | `refresh_family_9b07a1cb-a1d6-482a-a809-69fca32c9c3f` | ACTIVE; 1 live access token |

## Conversation evidence

The two live conversations were retained as browser deliverables for the operator. Their private URLs are intentionally not published in Git or Feishu. Repository-safe evidence is limited to the two screenshots and the non-secret database tuples above.

The Agent2 screenshot also shows a separate pre-existing QuickBooks connector card in the Host UI. It was not deployed or changed in this run and is not part of the Xero-only repository or release.

## Observation

One synthetic pair of authorize probes sent at the same instant produced a transient `server_error` for Agent2 while Work redirected normally. A standalone retry immediately redirected to Xero, and both real browser OAuth flows then passed end to end. This run proves independent two-Host installation isolation; it does not claim burst-concurrency stress coverage.

## Claim boundary

This run can prove two independent Host installations in the early-UAT profile. It cannot prove production-grade Work/Agent2 user identity because the Host does not yet provide a signed user/workspace/installation assertion.
