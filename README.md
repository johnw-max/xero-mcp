# Xero Accounting MCP

这是一个已完成核心可行性验证的远程 Xero MCP。它让 Work 中的 Agent 通过用户 OAuth 授权连接其 Xero Organisation，读取存量会计数据、结合用户材料进行分析，并在人工确认后执行受控会计操作。

当前版本部署在个人测试基础设施，用于验证产品形态与主要流程；它不是公司正式生产环境。本次交接的目标是由开发团队接手源码和 Xero Developer App，并迁移到公司控制的域名、云资源、数据库和密钥体系。

## 系统形态

```text
会计用户 / Work Agent
        ↓
远程 MCP（OAuth、工具边界、确认、审计）
        ↓
Xero OAuth + Accounting API
        ↓
用户授权的 Xero Organisation
```

- Xero 官方提供 OAuth、Accounting API、会计数据和 `xero-node` SDK。
- 本项目实现远程 MCP、多用户连接、Organisation 绑定、受控工具、写入确认、幂等、回执回读和审计。
- Xero 始终是正式账本。PostgreSQL 只保存授权、连接、幂等和审计等控制状态，不复制一套总账。
- 当前交接范围只包含 Xero。仓库中少量 QuickBooks 共享模块用于保持既有运行连续性，后续可由开发团队拆分。

## 源码结构

| 位置 | 用途 |
|---|---|
| `src/mcp/` | MCP Server 与工具注册 |
| `src/oauth/` | Work OAuth、Xero OAuth、刷新与撤销 |
| `src/providers/` | Xero API/SDK 适配与数据映射 |
| `src/services/` | 读取、准备、执行、回读和审计编排 |
| `src/policy/` | 能力及风险边界 |
| `src/db/`、`migrations/` | PostgreSQL 控制状态与迁移 |
| `deploy/` | 部署配置与运行说明 |
| `tests/`、`harness/` | 自动化测试与业务验收工具 |

## 开发接手

1. 使用公司环境部署本仓库，配置 Node.js 22+、PostgreSQL、HTTPS 域名和 Secret Manager。
2. 在 Xero Developer Portal 接手 `zCloak Accounting Connector`，配置公司回调地址和最小 OAuth scopes。
3. 先保持写入关闭，验证登录、Organisation 选择、读取、自动续期和主动断开。
4. 再用测试 Organisation 验证受控写入：准备提案 → 用户确认 → 写入 → Xero 回执 → 同 ID 回读。
5. 在 Work 公司空间重新配置 MCP，并复制或重建正式 Agent。
6. 稳定运行后，再移除个人测试域名、服务器、数据库和密钥依赖。

> 迁移时应先新增公司回调并完成验证，最后再删除当前测试回调，避免中途影响现有演示。

Xero 正在推进更细粒度的 OAuth scopes。开发接手后应按 Developer Portal 的最新要求完成迁移，不应长期依赖旧的 broad scopes。

## 本地验证

```sh
npm install
npm run typecheck
npm test
npm run build
```

需要 PostgreSQL/HTTP 环境的发布门槛必须在隔离测试环境单独执行；条件跳过不等于通过。配置模板见 [`config/.env.example`](./config/.env.example) 和 [`deploy/env.vps.example`](./deploy/env.vps.example)。

任何 Client Secret、OAuth Token、加密密钥、数据库备份或 `.env` 都不得提交到 Git。

## 正式接手完成标准

- 公司账号拥有 Xero App、域名、云资源、数据库、密钥和账单管理权；
- 能从干净环境构建、迁移并部署；
- 多用户与多 Organisation 连接相互隔离；
- OAuth 登录、Organisation 选择、读取、续期和撤销均通过；
- 写入默认受控，且每次成功都有 Xero object ID、Provider receipt 和同 ID 回读；
- 监控、备份、恢复、回滚和安全责任人明确；
- 正式环境不再依赖个人基础设施。

详细设计、测试和部署资料保留在 [`docs/`](./docs)、[`deploy/`](./deploy) 与 [`artifacts/`](./artifacts) 中，供开发按需查阅。
