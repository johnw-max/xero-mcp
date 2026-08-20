# zCloak Xero Accounting MCP

一个面向 Accounting Agent 的 Xero Ledger Gateway。Google Drive 保存和同步用户材料，Accounting Skills/Agent 理解业务并编排，Xero MCP 负责组织绑定、有界读取、typed Accounting Case 写入、receipt、精确回读和恢复；Xero 始终是唯一正式账本。

## 当前状态

- 线上仍是历史 `0.3.1`，不能代表当前候选已经上线。
- 当前本地候选是 `0.4.0-rc.1`。
- 公共工具由 [`config/xero-capability-manifest.json`](./config/xero-capability-manifest.json) 与 allowlist 动态核对；当前工作树为 38 个，不再手填固定工具数量。
- 核心读取和 36 个 typed Case 写动作（草稿、主数据、账本状态及纠错路径）已在代码中可达，但所有 `SHIP` 项仍缺冻结 candidate 的完整真实 Xero UAT，因此 release gate 当前为 `NO_GO`。
- 写入默认仍受运行时 write gate 保护；本地测试通过不会自动打开线上写入。

当前能力与缺口见 [通俗能力页](./docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md)。

## 产品边界

本期架构固定为 [Xero MCP 目标产品架构](./docs/XERO-MCP-TARGET-ARCHITECTURE-2026-08-20.md)，开发约束固定在 [`AGENTS.md`](./AGENTS.md)。

```text
Google Drive 材料
  → Accounting Skills / Agent
  → Xero MCP typed reads + Accounting Case
  → Xero Accounting API
  → Xero formal ledger
```

不建设第二套 Ledger、通用 workflow/approval 平台、generic CRUD、任意 API 代理或多会计 Provider 抽象。

## Organisation 选择

Tenant 只能来自服务端 OAuth installation/binding，不能从聊天文字或工具参数自报。

- `xero_pin_current_organisation`：锁定当前对话使用的 Xero Organisation。
- `xero_start_organisation_switch`：返回短效 URL；用户在网页里选择一个已经授权的 Organisation，然后 Agent 重新 pin 并读取 Organisation。

这是 R1 唯一的用户确认流程。其他会计动作不新增签名、确认短语、审批 token 或确认状态机。

## 读取与写入

读取面包括 Organisation、Accounts、Tax Rates、Tracking、Contacts、Items、Contact Groups、主要业务单据、Payments、Bank Transactions、Journals、Trial Balance、P&L、Balance Sheet 和 Aged AR/AP。

所有公开写入只从三个 typed Case 工具进入：

- `xero_prepare_accounting_case`；
- `xero_execute_accounting_case`；
- `xero_get_accounting_case_status`。

当前代码可达：Contact/Item basic maintenance；六类单据的 DRAFT create/update；Invoice/Bill/Credit Note authorise、Manual Journal post；Payment create/reverse；Bank Transaction create/update/reverse；Credit Note allocate/refund/unallocate/void；Invoice/Bill/Manual Journal void；以及 Tracking Category/Option safe create/update。每项使用独立 typed action、合法状态校验、幂等、provider receipt、exact read-back 和 unknown-write recovery；不使用 generic update。

这些动作的冻结候选仍需真实 PostgreSQL 与 live Xero UAT 证据；在证据完成前不把代码可达性表述为已上线能力。

## 成功判据

Provider/schema/policy 单独存在不算支持。写入只有同时得到以下证据才算成功：

1. Agent-facing public Case 能表达并执行该 action；
2. Xero 返回 object ID 和 provider receipt；
3. 对同一个 object ID 精确回读且关键字段/状态一致；
4. 超时或未知结果没有盲目创建第二个对象。

Google Drive 文件、Agent 回答或本地 mock 都不是 Xero 已记账的证据。

## 本地验证

```bash
npm install
npm run typecheck
npm run build
npm run validate:capabilities
npm test
npm run test:http:required
```

开发阶段先跑受影响测试；冻结候选后只跑一次完整 release lane。`npm run validate:capabilities` 可以结构通过但仍输出 `release_gate|NO_GO`，表示代码/清单结构一致，但真实 Xero 证据尚未完成。

## 上线验收顺序

1. 冻结 source/image，核对 capability hash 与 migration head；
2. typecheck、build、受影响测试及一次完整 release suite；
3. immutable candidate 部署到生产等价隔离端口；
4. 真实浏览器完成 OAuth 和 organisation-selection URL 验证；
5. 通过线上 Google Drive MCP + Accounting Skills/Agent + candidate Xero MCP 跑自然语言用户链路；
6. 对每项写入保存 provider ID、receipt、exact read-back，适用时用 Journals 验证；
7. production admission → blue/green switch → 公网 readiness/read-only smoke → rollback 演练。

详细执行计划见 [高质量快速上线计划](./docs/XERO-MCP-HIGH-QUALITY-LAUNCH-PLAN-2026-08-20.md)。历史架构、traceability/review 和旧 UAT 文件只保留为历史证据，不能替代当前 manifest 与真实线上验收。
