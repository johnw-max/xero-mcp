# Xero Accounting MCP

本仓库包含 Work 平台接入 Xero 的远程 MCP 服务。项目以 Xero 作为正式会计账本，使会计用户能够在 Work 中授权自己的 Xero Organisation，由 Agent 读取历史账务、结合用户材料进行分析，并在人工确认后执行受控会计操作。

当前版本是已完成核心可行性验证的代码基线，运行在个人测试基础设施，不应直接作为公司生产部署。开发团队接手后需要迁移到公司控制的域名、云资源、数据库和密钥体系，并完成多用户、多 Organisation 隔离及生产环境验收。

## Architecture

```text
Accountant
   ↓
Work Agent
   ↓
Remote Xero MCP
   ↓
Xero OAuth 2.0 and Accounting API
   ↓
User-authorized Xero Organisation
```

| Component | Responsibility |
|---|---|
| Work and Agent | User conversation, source materials, business analysis and tool orchestration |
| Xero MCP | OAuth broker, Organisation binding, accounting tools, confirmation, idempotency, read-back and audit |
| Xero | Official ledger, accounting data, OAuth 2.0, Accounting API and SDK |
| PostgreSQL | Authorization, connection, idempotency and audit control state; it is not a second ledger |

Xero provides the official OAuth and Accounting API. This project adds the remote MCP interface, per-user connections, explicit Organisation selection, bounded accounting tools, and the controlled write flow: prepare → user confirmation → execute → provider receipt → exact record read-back.

## Repository structure

| Path | Purpose |
|---|---|
| `src/mcp/` | MCP server and tool registration |
| `src/oauth/` | Work OAuth, Xero OAuth, refresh and revoke |
| `src/providers/` | Xero API/SDK adapter and data mapping |
| `src/services/` | Read, prepare, execute, read-back and audit orchestration |
| `src/policy/` | Capability and risk boundaries |
| `src/db/`, `migrations/` | PostgreSQL control state and migrations |
| `deploy/` | Deployment configuration and runbooks |
| `tests/`, `harness/` | Automated tests and business acceptance tools |

## Developer takeover

1. Deploy the repository in a company-controlled environment with Node.js 22+, PostgreSQL, HTTPS, Secret Manager, logging, monitoring, backups and rollback.
2. Bring the Xero Developer App under company management, configure the company callback and adopt Xero's current granular OAuth scopes.
3. Configure the MCP in the company Work environment and ensure every user connects and selects their own Xero Organisation.
4. Keep accounting writes disabled while validating OAuth, Organisation selection, reads, token refresh, revoke and multi-user isolation.
5. Validate controlled writes in an isolated test Organisation, requiring user confirmation, Xero record ID, provider receipt and exact record read-back.
6. Remove personal infrastructure dependencies only after the company deployment is stable.

Configuration templates are available in [`config/.env.example`](./config/.env.example) and [`deploy/env.vps.example`](./deploy/env.vps.example). Secrets, OAuth tokens, database backups and `.env` files must never be committed to Git.

```sh
npm install
npm run typecheck
npm test
npm run build
```

Tests that require isolated PostgreSQL or HTTP environments must be run separately as release gates; a conditional skip is not a passing release result.

The current handover scope is Xero only. A small number of shared QuickBooks modules remain to preserve existing runtime continuity and may be separated by the development team later.
