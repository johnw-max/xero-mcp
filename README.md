# zCloak Xero Accounting MCP

让会计用户在 Agent2 中连接自己的 Xero，读取存量账务、结合用户材料做分析，并在明确确认后执行受控会计操作。Xero 始终是正式账本；Agent 对话、文件和本项目的 PostgreSQL 都不是第二套 Ledger。

## 当前状态

核对日期：2026-08-10。

| 层级 | 准确状态 |
|---|---|
| 当前线上受控 Demo | `xero-accounting-mcp-demo:0.3.1-xero-pilot-20260810.1`；44 个固定工具，工具集指纹 `d2ac8c01…0224` |
| 已配置 Host | `Agent2` 的 `Xero 会计助理（UAT）` 与 `Work` 的 `Xero 会计助理`；最终均回读 `Demo Company (Global)`，USD |
| 线上验收 | Agent2 完成 Demo/USD → zcloak/HKD → Demo/USD 的受控切换闭环；Work 完成 Organisation、应收应付、Trial Balance、银行流水与对话发起切换链接 |
| 零写入证据 | 0 preparation、0 mutation request、0 Xero 会计写入 |
| 本地验证 | typecheck/build 通过；当前完整默认回归 819 PASS、52 条条件跳过；HTTP/OAuth 强制测试 3/3、fresh PostgreSQL 17 强制测试 49/49 |
| 当前写闸 | `XERO_WRITE_ENABLED=false`；开机安全门已启用并验证；本轮线上验收没有调用任何写工具 |

因此当前结论是：`44 工具已部署 / Agent2 与 Work 的只读核心流程和受控公司切换入口已通过 / Demo 最终绑定 Demo Company / 多人生产写入未批准`。

面向非技术读者的说明见 [Xero MCP 当前能力与边界（通俗版）](./docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md)。

与 MCP 配套的 11 个会计工作流 Skill、部署 ZIP、能力映射和 Agent instructions 见 [accounting-double-entry-skills-2026-08-10](./agent-skills/accounting-double-entry-skills-2026-08-10/README.md)。Skill 负责会计判断与业务步骤，MCP 负责授权、Xero 数据/action 能力与可验证回执。

## 产品架构

```text
会计用户 + 业务材料
        |
        v
Agent2：对话、材料理解、分析和工具编排
        |
        v
zCloak Xero MCP
  - Host OAuth 与逐用户 Installation
  - 精确 Organisation Binding
  - 固定业务工具与最小权限
  - 准备、确认、写闸、幂等、回读、审计
        |
        v
Xero OAuth + Accounting API：正式会计记录与报表
```

PostgreSQL 只保存授权、连接、准备/写入状态、幂等键和审计证据，不复制一套总账。

> 本仓库只交付 Xero MCP。其他会计平台使用独立仓库、OAuth 应用、部署配置和发布流程；共享基础能力应通过版本化公共包复用，不复制进 Provider 仓库。

## 官方能力与自研控制层

官方组件：

- Model Context Protocol SDK；
- Xero OAuth 2.0、Accounting API 和 Demo/Trial Organisation；
- `xero-node` SDK。

zCloak 自研：

- Agent2 面向的 OAuth Broker，Xero Token 加密保存在服务端；
- Installation、Binding、Connection 和唯一 Xero Tenant 的精确绑定；
- 44 个固定工具的参数、分页、字段及返回大小边界；
- 一次性 Preparation、人工确认、临时写闸、最小 OAuth scope；
- 来源指纹、防重复、幂等、Provider 不确定结果恢复；
- 先保存 Xero ID/回执，再按同 ID 精确 GET，字段一致后才报告成功；
- Token 轮换、撤销、replay 处理、日志脱敏和审计。

项目不提供任意 endpoint、任意 JSON、raw `where`、自定义 header 或由 Agent 指定 Tenant ID 的万能工具。

## 44 个 MCP 工具

唯一清单以 [src/mcp/toolNames.ts](./src/mcp/toolNames.ts) 和 [tests/contract/expected-tools.json](./tests/contract/expected-tools.json) 为准。

### 23 个读取工具

- 连接与账套：`xero_connection_status`、`xero_get_organisation`；
- 设置：`xero_list_accounts`、`xero_list_tax_rates`；
- Contact：list/get/search；
- Invoice/Bill：list/get/get supplier bill；
- Credit Note、Payment：list；
- Quote、Purchase Order、Manual Journal、Item、Bank Transaction：list/get；
- 报表：`xero_get_trial_balance`。

读取结果都有参数、分页和输出边界。Trial Balance 是有界的 Provider 视图，不代表全账套、审计或税务完整性。

### 1 个组织切换工具

- `xero_start_organisation_switch`：会计在对话里提出切换公司后，Agent 返回 10 分钟有效、一次性使用的确认链接；用户只能从当前 Xero OAuth 已授权的组织中明确选择一家。
- 切换不会改动 Xero 数据；确认完成后，同一 MCP installation 的后续请求只解析到新组织，旧组织上下文立即失效。
- 若目标组织不在已授权列表中，才需要重新走 Xero OAuth；手动断开重连仍作为备用路径。

### 10 组“准备 + 执行”

| 业务对象 | Prepare | Execute 后允许的结果 |
|---|---|---|
| Supplier Bill | `xero_prepare_supplier_bill_draft` | `xero_create_draft_supplier_bill` → `DRAFT` |
| Sales Invoice | `xero_prepare_sales_invoice_draft` | `xero_create_draft_sales_invoice` → `DRAFT` |
| Quote | `xero_prepare_quote_draft` | `xero_create_quote_draft` → `DRAFT` |
| Purchase Order | `xero_prepare_purchase_order_draft` | `xero_create_purchase_order_draft` → `DRAFT` |
| Credit Note | `xero_prepare_credit_note_draft` | `xero_create_credit_note_draft` → `DRAFT` |
| Manual Journal | `xero_prepare_manual_journal_draft` | `xero_create_manual_journal_draft` → `DRAFT` |
| Contact create | `xero_prepare_contact_create` | `xero_create_contact` → 基础 `ACTIVE` Contact |
| Contact update | `xero_prepare_contact_update` | `xero_update_contact` → 受限基础字段 |
| Item create | `xero_prepare_item_create` | `xero_create_item` → 基础 `UNTRACKED` Item |
| Item update | `xero_prepare_item_update` | `xero_update_item` → 受限基础字段 |

所有 Execute 都需要 `xero.draft.write`，并受连接、Tenant、OAuth scope、写闸、确认、重复保护和精确回读共同约束。

## 写入共同契约

```text
1. 从服务端 Installation/Binding 解析唯一 Xero Tenant
2. Prepare：标准化、查重、验证 Contact/Account/Tax/Item/Tracking；不写 Xero
3. 展示不可变提案、账套短标识、来源指纹和一次性确认句
4. 用户明确确认当前提案
5. Execute 再检查权限、OAuth scope、写闸、Tenant 和会计引用
6. 以幂等键写入 Xero
7. 先持久化 Xero object ID 与 Provider receipt
8. 按同一个 ID 精确 GET
9. 状态和规范字段一致才返回 verified；否则保留 UNKNOWN 或 MISMATCH
```

OAuth Broker 请求以服务端精确 Binding 的 Tenant 作为写入边界；Legacy shared-bearer 模式没有逐用户 Binding，因此仍必须配置显式 `XERO_ALLOWED_TENANT_ID`。

### 当前确认边界

全部 10 组写入都使用服务端持久化 Preparation 与当前提案的一次性逐字确认句。Execute 只接受 `preparation_id + request_id + confirmation_phrase`，不再接受 Agent 在执行阶段重新提交会计字段；提案字段、材料版本或目标一变，旧确认不能执行。

这已经满足受监督 Demo 的会话确认边界，但仍不是密码学意义的独立人工审批凭证。正式生产若要求证明“某个具体用户在某个界面确认”，Host 还需提供可验签、绑定用户与提案指纹的确认收据。

### 当前来源边界

- `SERVER_FINGERPRINTED_EXTRACTION`：服务端对规范化提案生成确定性指纹，不是原文件 hash；
- `AGENT_ASSERTED_UNVERIFIED`：调用方提供 hash，MCP 没有读取原文件验证；
- `HOST_ATTESTED_FILE_RECEIPT`：已保留语义，但在 Host 可验签链路完成前拒绝使用。

文件内容始终视为数据而不是指令。当前 MCP 不能直接证明 Agent2 上传文件的原始内容和上传者身份。

## OAuth scope

Host scope：

- Prepare 和读取：`xero.read`；
- Execute：`xero.draft.write`。

HTTP 入口接受上述任一有效 Host scope，随后由每个工具校验自己的精确 scope；只有写权限的 Token 不会被强迫额外取得读取权限。Broker 也按 Host 实际授权推导 Xero consent：只读不申请写 scope，仅草稿写不附带 Trial Balance、Payment 或 Bank Transaction 读取 scope。

Xero granular write scope：

- Invoice/Bill/Quote/PO/Credit Note：`accounting.invoices`；
- Manual Journal：`accounting.manualjournals`；
- Contact：`accounting.contacts`；
- Item：`accounting.settings`。

旧 `accounting.transactions` 只作为 Invoice/Manual Journal 的迁移兼容，不替代 Contact/Settings scope；新授权不主动请求 broad transaction scope。

### 连接时效与主动断开

- Xero 上游 Access Token 约 30 分钟有效；MCP 在服务端用有效的 Xero Refresh Token 自动续期，不要求会计每 30 分钟重新登录。
- Work/Agent2 到 MCP 的 Access Token 默认 15 分钟；有效 Refresh Token 可轮换续期。
- MCP Refresh Token 是 30 天滚动闲置窗口：每次正常轮换都会签发新的 30 天 Token；连续 30 天没有续期才需要重新连接。过期、replay 或主动撤销后，旧 Access/Refresh Token 都不能继续使用；同一用户可重新连接。
- 标准 `/revoke` 是主动断开入口。产品断开应提交 Refresh Token，以撤销该 installation、binding、refresh family 及派生 Access Token；默认保留服务端 Xero provider authorization/connection，避免把“断开某个 Work 连接”扩大成 Xero 全局撤权。
- 生产环境不提供任意篡改过期时间的测试后门；自然过期用可注入时钟和隔离数据库验证。

详细行为见 [连接生命周期说明](./docs/XERO-MCP-CONNECTION-LIFECYCLE-ZH.md)。

## 明确不开放

- AUTHORISE、SUBMIT、POST、真实发送；
- Payment/receipt/refund、Credit Note allocation；
- Bank Transaction 写入、Bank Transfer、最终 reconciliation；
- Void、Delete、Archive、Merge；
- Account/Tax 写入及银行/系统科目修改；
- Contact 银行资料、税务关键字段、付款条款；
- Item 价格、科目、税码、Tracking、库存数量或价值；
- Attachment 上传；
- Tax filing、payroll、close、audit opinion；
- 无人监督批量记账和多客户生产隔离声明。

Agent 可以做只读差异分析和对账候选建议；最终银行对账留在 Xero UI。

## 本地运行与发布硬门槛

要求 Node.js 22+ 和 PostgreSQL。

```sh
npm install
npm run typecheck
npm test
npm run test:http:required
TEST_DATABASE_URL='postgresql://.../xero_mcp_test_release_20260807' npm run test:postgres:required
npm run build
```

默认测试里条件跳过的 PostgreSQL/HTTP 用例不算发布通过。测试数据库名必须是 `xero_mcp_test` 或以 `xero_mcp_test_` 开头，绝不能指向服务数据库。

配置模板见 [config/.env.example](./config/.env.example) 和 [deploy/env.vps.example](./deploy/env.vps.example)。真实 Secret 不能进入 Git、聊天、截图、Demo 材料或模型上下文。

迁移和启动：

```sh
set -a
source .env.local
set +a
npm run build
npm run migrate
npm run start
```

应用不会静默执行 migration；数据库或 schema 不就绪时 `/readyz` 必须返回 503。

## 上线验收顺序

1. 完成 typecheck、build、完整单测、HTTP 和隔离 PostgreSQL 硬门槛；
2. 部署时保持 `XERO_WRITE_ENABLED=false`；
3. 让测试 Xero 重新授权 granular scopes；
4. 验收 Organisation 与所有关键只读对象；
5. 精确确认测试 Tenant 后临时开启写闸；
6. 对计划展示的每种写对象至少完成一次真实创建、Xero ID 回执和同 ID 回读；
7. 在 Agent2 用普通会计话术跑连续 signature flows；
8. 立即关闭写闸，清理临时 SSH/UFW 通道。

OAuth 成功、工具出现在列表或 Xero 返回 2xx，都不能单独称为业务完成。

## 关键文档

- [通俗能力与边界](./docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md)
- [0.3.0 本地发布门槛记录](./docs/XERO-0.3.0-LOCAL-RELEASE-GATE-2026-08-07.md)
- [能力扩展和风险分层](./docs/XERO-MCP-CAPABILITY-EXPANSION-V1-2026-08-07.md)
- [恢复检查点](./docs/XERO-CAPABILITY-EXPANSION-RECOVERY-CHECKPOINT-2026-08-07.md)
- [产品架构](./docs/XERO-MCP-PRODUCT-ARCHITECTURE-V1.md)
- [OAuth Broker Contract](./docs/MCP-OAUTH-BROKER-CONTRACT-V1.md)
- [连接生命周期说明](./docs/XERO-MCP-CONNECTION-LIFECYCLE-ZH.md)
- [Organisation 切换与治理审计设计](./docs/XERO-ORGANISATION-SWITCH-AND-GOVERNANCE-AUDIT-ZH.md)
- [开发接手说明](./handoff/2026-08-10/02-Xero-MCP-开发接手指南.md)
- [会计同事体验指南与材料](./handoff/2026-08-10/01-Xero会计助理-会计同事体验指南.md)
- [Agent2 会计用户 UAT](./docs/AGENT2-XERO-ACCOUNTANT-UAT-V1.md)
- [Threat Model](./docs/THREAT-MODEL.md)
- [Hetzner 部署 Runbook](./deploy/HETZNER-HOST-NGINX-RUNBOOK.md)

2026-08-10 的部署与线上证据见 [0.3.1 发布与线上 UAT](./docs/XERO-0.3.1-DEPLOYMENT-AND-ONLINE-UAT-2026-08-10.md)。旧 15/43 工具验收和旧单张 Bill Demo 只可作为历史基线，不能替代本次 44 工具发布证据。
