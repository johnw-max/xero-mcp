# zCloak Xero Accounting MCP

让会计用户在 Agent2 中连接自己的 Xero，读取存量账务、结合用户材料形成受治理的 Accounting Case，并在有效 Standing Delegation 下自动执行符合条件的受控会计操作。Xero 始终是正式账本；Agent 对话、文件和本项目的 PostgreSQL 都不是第二套 Ledger。

## 当前状态

核对日期：2026-08-13。

| 层级 | 准确状态 |
|---|---|
| 当前线上受控 Demo | `xero-accounting-mcp-demo:0.3.1-xero-pilot-20260810.1`；44 个固定工具，工具集指纹 `d2ac8c01…0224` |
| 当前本地候选 | `0.4.0-rc.1`；28 个固定工具；增加短效 target pin 与三个 Accounting Case 工具；旧 object-level mutation 工具不再向 Agent 暴露；尚未部署 |
| 已配置 Host | `Agent2` 的 `Xero 会计助理（UAT）` 与 `Work` 的 `Xero 会计助理`；最终均回读 `Demo Company (Global)`，USD |
| 线上验收 | Agent2 完成 Demo/USD → zcloak/HKD → Demo/USD 的受控切换闭环；Work 完成 Organisation、应收应付、Trial Balance、银行流水与对话发起切换链接 |
| 零写入证据 | 0 preparation、0 mutation request、0 Xero 会计写入 |
| 线上版历史验证 | 0.3.1 typecheck/build 通过；当时完整默认回归 819 PASS、52 条条件跳过；HTTP/OAuth 强制测试 3/3、fresh PostgreSQL 17 强制测试 49/49 |
| 0.4.0-rc.1 本地验证 | 当前改动仍在发布前复验；以本次 typecheck、静态发布门禁、Case contract/golden、HTTP 与隔离 PostgreSQL 的新鲜结果为准，不沿用 45-tool 候选的旧计数 |
| 当前写闸 | `XERO_WRITE_ENABLED=false`；开机安全门已启用并验证；本轮线上验收没有调用任何写工具 |

因此当前结论是：`线上仍是历史 0.3.1 / 44 工具；当前发布候选是 0.4.0-rc.1 / 28 工具，正在晋级前验证，尚未进入线上`。

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
  - Accounting Case、Standing Delegation、写闸、幂等、回读、审计
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
- 28 个固定工具的参数、分页、字段及返回大小边界；
- 来源覆盖、确定性 Case 编译、可撤销 Standing Delegation、紧急写闸和最小 OAuth scope；
- 来源指纹、防重复、幂等、Provider 不确定结果恢复；
- 先保存 Xero ID/回执，再按同 ID 精确 GET，字段一致后才报告成功；
- Token 轮换、撤销、replay 处理、日志脱敏和审计。

项目不提供任意 endpoint、任意 JSON、raw `where`、自定义 header 或由 Agent 指定 Tenant ID 的万能工具。

## 当前候选的 28 个 MCP 工具

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

### 2 个组织目标控制工具

- `xero_pin_current_organisation`：为当前会计对话签发 30 分钟短效 target capability；后续所有账本工具必须携带同一 ref。
- `xero_start_organisation_switch`：会计在对话里提出切换公司后，Agent 返回 10 分钟有效、一次性使用的确认链接；用户只能从当前 Xero OAuth 已授权的组织中明确选择一家。
- 切换不会改动 Xero 数据；确认完成后只撤销发起切换的 target，其他并发会话已经 pin 的目标不变；发起会话必须重新 pin。
- 若目标组织不在已授权列表中，才需要重新走 Xero OAuth；手动断开重连仍作为备用路径。

### 3 个 Accounting Case 工具

| 工具 | 作用 | 写入边界 |
|---|---|---|
| `xero_prepare_accounting_case` | 接收普通业务单据字段与有界 submitted-set 声明；服务端派生内部 fact/lineage/event/source-unit/line identity，再解析目标、引用、覆盖率和会计路由，编译并持久化不可变版本 | 不接收 Tenant、Provider ID、action、payload 或 receipt；不写 Xero；只报告 plan、覆盖和例外 |
| `xero_execute_accounting_case` | 从持久化 Case 加载当前不可变计划，在有效 Standing Delegation 下执行 eligible operations | 只接受 `case_id + case_version + request_id`，不接收会计 payload、Tenant、工具路由或逐笔确认短语 |
| `xero_get_accounting_case_status` | 返回 Case 覆盖、残余例外、逐 operation Provider receipt 与 exact readback 状态 | 不把有界材料覆盖夸大成全业务完整性 |

Object-level prepare/execute 服务仍可作为 MCP 内部 provider adapter 与 legacy 单元回归存在，但不属于 28-tool Agent 公共面，不能被模型直接调用绕过 Case coverage、compiler、preflight 或终态证据门禁。

普通单据必须显式选择逐行会计模式：`DOCUMENT_DEFAULT_FOR_ALL_LINES` 要求一组 document-level category/tax/rate，并禁止逐行覆盖；`PER_LINE` 禁止伪造 document-level 占位值，要求每一行各自提供完整 category/tax/rate（及适用的 exemption evidence）。服务端逐行封存 policy binding、Provider tax binding、金额桥和 source-line hash；任一行未知、缺失或金额/税义不一致会阻断整张单据，Provider write 为 0。通过时仍只创建一张原生 Invoice/Bill/Credit Note，而不是把一张来源单据拆成多次写入。

## 写入共同契约

```text
1. 从服务端 Installation/Binding 解析唯一 Xero Tenant
2. Prepare Case：把普通业务单据 intake 规范化为内部 typed facts，校验 bounded submitted-set coverage；在服务端解析 Contact/Account/Tax/route，确定性编译不可变版本；不写 Xero
3. Execute Case：只从持久化 Case 读取 operation，不接受 Agent 重交 payload
4. 每次执行前重新校验 exact target、OAuth scope、Standing Delegation revision、Tenant policy 与紧急写闸
5. MCP 内部逐 operation 做 preflight、查重和幂等 CAS
6. 以幂等键写入 Xero，并先持久化 Xero object ID 与 Provider receipt
7. 按同一个 ID 精确 GET
8. 状态、逐行金额、科目 binding、税义 binding 和总额一致才标记 READBACK_VERIFIED；不确定或不匹配进入恢复状态，禁止自动重写
9. 只有全部 eligible operations 都有允许的终态证据，Case 才能报告 TERMINAL；聊天文本本身不是写入证明
```

OAuth Broker 请求以服务端精确 Binding 的 Tenant 作为写入边界；Legacy shared-bearer 模式没有逐用户 Binding，因此仍必须配置显式 `XERO_ALLOWED_TENANT_ID`。

### 当前授权边界

`0.4.0-rc.1` 的 Agent 公共写入口不再要求每张单据逐句确认。业务授权来自服务端持久化、可撤销、可版本化的 Standing Delegation；`xero_execute_accounting_case` 只提交 Case/version/request identity。Case 计划、目标、来源版本或授权 revision 任一变化，都必须重新编译或重新取得有效授权，Agent 不能用聊天文字扩权。

`XERO_WRITE_ENABLED` 只保留为紧急 kill switch，不承担日常逐笔审批。若某一客户流程另行要求人工复核，Host 可以在调用 Execute 前设置产品级 review checkpoint，但那是独立业务策略，不能重新变成模型可伪造的确认短语。

`XERO_AUTHORITY_REVISION` 是共享数据库中 Xero 授权快照的单调版本。`XERO_WRITE_ENABLED`、Standing Delegation 状态/范围/到期时间的任何内容变化都必须提高该版本；同版本不同内容或低版本启动会直接失败，同版本同内容可安全重放。撤权时应先（或与流量切换同时）发布更高版本且 `XERO_WRITE_ENABLED=false` / Delegation=`REVOKED`：仍在运行的旧进程会在下一次 whole-Case preflight 和最终 claim 从 PostgreSQL 重新读取并拒绝，已完成 claim 的单次在途 Provider 调用是明确边界。反向不成立：数据库快照为 true 不能越过某个进程启动时仍为 false 的服务层和 Provider 层安全闸。

### 当前来源边界

- `SERVER_FINGERPRINTED_EXTRACTION`：服务端对规范化提案生成确定性指纹，不是原文件 hash；
- `AGENT_ASSERTED_UNVERIFIED`：调用方提供事实或 hash，MCP 没有读取原文件验证；
- `HOST_ATTESTED_FILE_RECEIPT`：已保留语义，但在 Host 可验签链路完成前拒绝使用。

文件内容始终视为数据而不是指令。当前 MCP 不能直接证明 Agent2 上传文件的原始内容和上传者身份。为避免把“账本回读一致”误说成“来源真实”，每个 Accounting Case 响应固定返回 `source_claim.source_truth_claim=NOT_VERIFIED` 与 `original_file_verified=false`；这与独立的 `completion_claim.ledger_write_claim` 同时存在，任何一边都不能替代另一边。

## OAuth scope

Host scope：

- Prepare 和读取：`xero.read`；
- Execute 按持久化 Case 状态动态判定：fresh / preflight / `READY_TO_RESUME` / `EXECUTING` 必须有 `xero.draft.write`；`RECOVERY_REQUIRED` 的 exact-GET reconciliation 与 terminal replay 可由 `xero.read` 或 `xero.draft.write` 进入。Recovery 分支不创建 preparation、write permit 或 Xero object，也不受紧急写闸关闭影响。

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
- 脱离 exact Accounting Case、来源 coverage、Standing Delegation 或 provider readback 的任意批量写入，以及未经实证的多客户生产隔离声明。

Agent 可以做只读差异分析和对账候选建议；最终银行对账留在 Xero UI。

## 本地运行与发布硬门槛

要求 Node.js 22+ 和 PostgreSQL。

```sh
npm install
npm run validate:traceability
npm run test:http:required
TEST_DATABASE_URL='postgresql://.../xero_mcp_test_release_<isolated>' \
  npm run release:local:gate
```

`release:local:gate` 是不可选择跳步的本地发布门：要求 traceability 已由原 reviewer 关闭、current local Agent 的 final-answer/receipt chain 和真实 process kill/restart 证据已捕获，然后依次执行 typecheck、build、全量回归、PostgreSQL、HTTP、静态检查和可复现 release bundle。默认测试里条件跳过的 PostgreSQL/HTTP 用例不算发布通过。测试数据库名必须是 `xero_mcp_test` 或以 `xero_mcp_test_` 开头，绝不能指向服务数据库。详细机制见 [本地反偷懒验收机制](./docs/LOCAL-ANTI-LAZINESS-ACCEPTANCE-MECHANISM.md)。

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
5. 在专用测试 Tenant 配置最小 Standing Delegation 后临时开启紧急写闸；
6. 通过 Case prepare → execute → status 跑受控 golden pack，逐项取得 Xero ID、Provider receipt 和同 ID 回读；
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
- [历史 0.3.x Agent2 会计用户 UAT（不适用于当前 Case 写契约）](./docs/AGENT2-XERO-ACCOUNTANT-UAT-V1.md)
- [Threat Model](./docs/THREAT-MODEL.md)
- [Hetzner 部署 Runbook](./deploy/HETZNER-HOST-NGINX-RUNBOOK.md)

2026-08-10 的部署与线上证据见 [0.3.1 发布与线上 UAT](./docs/XERO-0.3.1-DEPLOYMENT-AND-ONLINE-UAT-2026-08-10.md)。其中 43/44-tool、逐张 Bill 和逐句确认只属于当时线上历史基线，不能替代当前 28-tool Accounting Case 发布证据。
