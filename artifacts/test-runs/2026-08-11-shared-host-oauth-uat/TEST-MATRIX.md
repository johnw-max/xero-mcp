# Shared Host OAuth UAT Test Matrix

Date: 2026-08-11

## Acceptance contract

- Business outcome: deploy the shared-installation OAuth mode, configure Work and Agent2, and prove that two independent Host installations can remain active without overwriting one another.
- In scope: Xero MCP OAuth broker, Work MCP configuration, Agent2 MCP configuration, Xero OAuth, Organisation/currency read-back, and temporary deployment access cleanup.
- Non-goals: accounting writes, production-grade signed Host user identity, cross-tenant disclosure tests, and Xero ledger mutation.
- Hard failures: one Host connection revokes or replaces the other; callback mismatch; shared Xero tokens; incorrect Organisation binding; missing cleanup evidence; or any accounting write.
- Pass criteria: both Hosts complete OAuth, receive distinct installations/token families/bindings, and independently read back the expected Organisation and currency after both connections exist.
- Token budget: UNAVAILABLE unless displayed by the Host UI. Run the smallest two-Host read-only case.

## Cases

| Case | Host | Objective | Required evidence | Result |
|---|---|---|---|---|
| OAUTH-WORK-01 | Work | Complete new OAuth connection and read Organisation/currency | Host connection state, MCP tool result, server installation/binding | PASS |
| OAUTH-AGENT2-01 | Agent2 | Complete new OAuth connection and read Organisation/currency | Host connection state, MCP tool result, server installation/binding | PASS |
| ISOLATION-01 | Work + Agent2 | Prove both connections remain active simultaneously | Distinct installation IDs/token families plus post-second-login read-back from both | PASS |
| CLEANUP-01 | Hetzner | Remove temporary access path | Final Load Balancer list empty | PASS |

## Final public configuration

- MCP URL: `https://mcp.jiayuanwang.xyz/mcp`
- Authorization URL: `https://mcp.jiayuanwang.xyz/authorize`
- Token URL: `https://mcp.jiayuanwang.xyz/token`
- Scope: `xero.read xero.draft.write`
- Xero Developer App Client ID: `F5A3D33C975B47CB9FE3961A04FCA40C`
- Xero callback: `https://mcp.jiayuanwang.xyz/oauth/xero/callback`

| Host | Client ID | Redirect URI | Bound Xero organisation | Read-back |
|---|---|---|---|---|
| Work | `work-xero-58751518d3dea403` | `https://work.zcloak.ai/api/mcp/zcloak-ledger-mcp-xero-demo/oauth/callback` | `zcloak` | `HKD` |
| Agent2 | `agent2-xero-58751518d3dea403` | `https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback` | `Demo Company (Global)` | `USD` |

Exact Client Secrets are intentionally excluded from the repository. The operator copy is stored outside Git at `../PRIVATE-XERO-OAUTH-HOST-CREDENTIALS-2026-08-11.json` with mode `0600`; the server copy remains in the root-only release env/handoff files.
