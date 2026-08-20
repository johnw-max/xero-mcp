# Xero MCP 高质量快速上线计划

日期：2026-08-20
目标分支：`codex/xero-org-switch-governance-20260810`
接管基线：`da8e95f` + Cloud Agent 当前未提交工作树

> 架构与范围真相源：`docs/XERO-MCP-TARGET-ARCHITECTURE-2026-08-20.md`。本计划只能安排其实现，不能自行扩张产品边界；若冲突，以冻结架构为准。

## 1. 一句话目标

在不扩建会计 SaaS、总账系统或重型评审体系的前提下，把 Xero MCP 收敛为一个**功能真实可达、常规会计读写完整、写入可恢复、证据可核对、可快速回滚**的 Ledger Gateway，并尽快上线。

优先级：先完成核心链路和真实用户验收，再冻结候选并上线；不以增加架构层、评审文档或测试数量代替真实可用性。Xero Demo Company、OAuth、部署主机与所需 scopes/tier 是外部前提。

## 2. 当前结论：不是从零开始，但现在不能上线

### 已经成立

- 公共工具面当前由 capability manifest/allowlist 动态派生为 38 个；基础读、对象 list/get、Journals、报表、Organisation 绑定和 3 个 Accounting Case 工具已经存在。
- 8 个此前 provider-only 的读取已经接通到公共 MCP、read evidence 和测试：Journals、P&L、Balance Sheet、Aged AR/AP、exact Payment、Tracking Categories/Options、Contact Groups。
- typed Accounting Case 已能表达已有草稿创建，以及 Contact/Item basic create/update；quote、purchase order、manual journal 已接入公共 business intake。
- Invoice/Bill authorise 与 Manual Journal post 已形成严格 typed Case → provider receipt → same-ID final read-back/recovery 链路；42 号迁移已在临时 PostgreSQL 17 上通过必跑集成测试。
- 当前 typecheck 与相关 targeted tests 已通过；工具数量与部署 identity 已改为派生值。

### 当前硬阻塞

1. DRAFT update parity 与 Tracking Category/Option 写入已接通公共 Case/provider/receipt/read-back 代码链，但真实 PostgreSQL 与 live Xero UAT 尚未完成，因此仍未 `READY`。
2. Payment/Credit/Bank/void/reverse code paths are connected through the public Case/provider/receipt/read-back chain, but real PostgreSQL and live Xero UAT are still missing; Bank Transaction reverse is `NOT_READY` until that evidence exists.
3. capability manifest 中所有 `SHIP` commitments 仍缺按风险业务场景映射的当前冻结 candidate 真实 Xero UAT，因此 release gate 必须维持 `NO_GO`。
4. `SHIP` is an R1 commitment; `readiness=READY` requires public reachability plus automated/live evidence, and release remains `NO_GO` until all `SHIP` rows are `READY`; 少数 README/UAT 历史描述仍需标注为历史，不能冒充当前工具契约。
5. 真实用户链路尚未按 `Google Drive 材料 → Accounting Skills/Agent → Xero 读取/写入/回读` 完整验收。
6. 最终 candidate 尚未完成 admission、blue/green switch、公网 smoke 和 rollback 演练。

因此当前状态是：**功能实现部分完成，但 advertised capability、真实可达性、构建 gate 与部署入口没有对齐，NO-GO。**

## 3. 本次发布边界

官方基线以 2026-08-20 的 [Xero 官方 MCP Available Commands](https://github.com/XeroAPI/xero-mcp-server#available-mcp-commands) 为准。官方能力是对照表，不是无条件照抄：每一项都必须在本项目矩阵中标为 `SHIP / EXCLUDED / LATER`，不得遗漏或用“基本支持”概括。

### 3.1 必须上线：读取

| 能力族 | 本次要求 |
|---|---|
| 目标与设置 | Organisation、Accounts、Tax Rates、Tracking Categories/Options |
| 主数据 | Contacts list/get/search、Items list/get、Contact Groups read |
| 业务单据 | Invoice/Bill、Credit Note、Quote、Purchase Order、Manual Journal 的 list/get |
| 资金历史读取 | Payments list/get、Bank Transactions list/get |
| 总账与报表 | Journals、Trial Balance、Profit & Loss、Balance Sheet、Aged Receivables、Aged Payables |

额外要求：

- Journals 与 Manual Journals 必须是两个不同能力，不能混淆。
- 所有读取必须返回 target/binding、observed time、query boundary、pagination/completeness 证据。
- Journals 必须先检查 Xero Advanced tier、安全评估、use-case approval 与 `accounting.journals.read`；官方说明其最多返回 100 条，partial page 不代表结束：[Xero Journals](https://developer.xero.com/documentation/api/accounting/journals)。
- 报表只做有界结构化返回，不在 MCP 内重建报表引擎：[Xero Reports](https://developer.xero.com/documentation/api/accounting/reports)。

### 3.2 必须上线：正常会计写入

所有写入仍走公共 Accounting Case，不重新开放 object-level legacy mutation tools。

| 能力族 | 本次要求 |
|---|---|
| 新建草稿 | Customer Invoice、Supplier Bill、Credit Note、Quote、Purchase Order、Manual Journal |
| 主数据维护 | Contact create/update basic；Item create/update basic untracked |
| 草稿更新 parity | Invoice/Bill、Credit Note、Quote、Manual Journal 的 existing DRAFT update |
| 维度维护 | Tracking Category/Option create/update，限非破坏性字段 |
| 状态转换 | Invoice/Bill authorise；Manual Journal post |
| 资金事实入账 | `payment.create`/`payment.reverse`；Bank Transaction create/update；Credit Note authorise/allocation/refund |
| 正常纠错 | 官方 API 支持的 void/reverse；不做 hard delete |

限制：

- create/update/authorise/post/allocate/refund/void/reverse 必须是不同 action；不得借 update 偷渡状态转换。
- Contact update 不开放银行、支付、税务身份等敏感字段。
- Item 仅 basic untracked；不开放库存数量/价值和库存会计状态。
- Tracking 只做安全 create/update，不做删除或历史重写。
- Purchase Order create 是本项目已经宣称的额外能力，保留；不因为官方 MCP 命令表未列出就回退。
- 所有写入复用现有 typed Accounting Case、当前 OAuth installation/binding、幂等、receipt、exact read-back 和 unknown-write recovery；不新增签名、审批、确认 token 或确认状态机。
- 唯一用户确认是现有 organisation-selection URL：用户在网页中选择已授权 Xero 组织，聊天文字不能直接切换；它不扩展到其他会计动作。
- 在 Xero 中记录 Payment/Bank Transaction 不等于通过银行真实转账，不得据此永久排除正常 bookkeeping 动作。

### 3.3 明确排除：不是本轮 bug

- 通过银行、支付机构或其他外部系统真实发起、批准或释放资金；
- Bank Feed 数据注入/篡改、Batch Payment 的银行执行编排；
- hard delete、绕过正常纠错状态的历史重写；
- Account/Tax/bank/system-account 的破坏性结构写入；
- Payroll 发薪、tax filing、最终 reconciliation confirmation、period close/lock、audit opinion；
- 任意 endpoint、任意 JSON、generic CRUD 或绕过 Case 的写入。

这些能力缺少稳定官方 API、会向外部真实执行资金/法定动作，或属于破坏性操作。排除原因是产品与 API 边界，不是“来不及”。

### 3.4 上线后再做

- Attachment upload/download；官方 Accounting API 支持附件，但官方 MCP 当前命令面未列出，且它属于凭证运输/来源证据，不是本次 Ledger 状态完整性的前置条件。若后续做，只允许固定已有父对象、MIME/大小白名单、content hash、不可覆盖、禁止任意 URL fetch。[Xero Attachments](https://developer.xero.com/documentation/api/accounting/attachments)
- Dedicated Prepayment / Overpayment reads；
- Fixed Assets、Budgets、regional tax reports；
- 压测、大规模并发、全历史 evidence 清理和测试人体工学重构。

## 4. Gate 0：范围和工作树

Codex 本地 token/Skill 精简是任务外事项，不进入 Xero 产品架构或发布 Gate。项目内 Gate 0 只冻结范围与工作树。

### 4.1 冻结 Cloud WIP

- 记录基线 `HEAD=da8e95f`、完整 `git status`、未提交文件列表和 diff hash；
- 不 reset、不 stash 覆盖、不 `git add -A`；
- 先把当前混合 WIP 拆为：read surface、manual journal/public intake、reference data、tax-inclusive/readback 四个批次；
- 每批通过 targeted test 后才形成 checkpoint commit；再开隔离 worktree 给并行 Agent。

### 4.2 单一 capability matrix

建立机器可读矩阵，每项能力必须同时记录：

```text
official_reference
release_disposition = SHIP | EXCLUDED | LATER
public_tool_or_case_action
input_schema
handler
policy
service_dispatch
provider_method
receipt_and_readback
tests
oauth_scope
live_uat_receipt
```

工具数、toolset hash、README 表、Agent profile、UAT manifest、deploy readiness 均从该矩阵/allowlist 派生，不再手填 28/29/30。

## 5. 实施工作包与顺序

### W0 — 当前红灯与 false-positive 收敛（已完成主体）

完成标准：

- 修复当前两处 typecheck；
- 在公共 intake 未完成前，不允许 quote/PO/manual journal 被标成 reachable；
- provider-only reads 标为 `ORPHAN`，不得写成 available；
- contact/item 三项从 `AVAILABLE_NOW` 与实际 reachability 的矛盾中收敛；
- 静态 gate 的 tool count/hash 改为派生值。

### W1 — 读取面接通（代码链已完成，待真实 Xero）

接通：Journals、P&L、Balance Sheet、Aged AR/AP、get Payment、Tracking Categories/Options、Contact Groups。

每个读取都必须贯通：

```text
public tool
  -> zod schema
  -> createServer registration/handler
  -> capability contract + OAuth scope
  -> AccountingService
  -> provider SDK call
  -> normalized read evidence
  -> bounded output/pagination
  -> route/negative/live test
```

不能只补 `registerTool`；缺 read-evidence profile 时 `runAudited` 本身会拒绝。

### W2 — 已有内部写路径真正公开（已完成主体）

接通 quote、purchase order、manual journal 的公共 business intake、normalizer 和 E2E。

关键负面：

- QUOTE + supplier 必须拒绝；
- PURCHASE_ORDER + customer 必须拒绝；
- Manual Journal 借贷不等必须在 Provider 前 `0 write`；
- 不能把 Manual Journal 当 invoice/credit 的 fallback；
- 每项必须通过同一 typed Case、幂等 request、provider receipt、exact read-back 和 recovery。

### W3 — 主数据与草稿更新 parity

按路由族串行接入，避免多人同时改 compiler/service：

1. Contact update basic；
2. Item create/update basic untracked；
3. Invoice/Bill DRAFT update；
4. Credit Note DRAFT update；
5. Quote DRAFT update；
6. Manual Journal DRAFT update；
7. Tracking Category/Option create/update。

每一项都要有独立 action ID、允许字段白名单、旧对象 version/identity、幂等键、精确回读和字段级 mismatch；禁止以一个 generic update route 承载全部对象。

### W4 — 非草稿账本动作（代码链已接通，待真实 Xero）

按真实 bookkeeping 优先级逐项验收现有 typed Case：

1. Invoice/Bill authorise 与 Manual Journal post；
2. `payment.create`/`payment.reverse`；
3. Bank Transaction create/update/reverse；
4. Credit Note allocation/refund；
5. 官方 API 支持的 void/reverse。

不新增人类确认、签名或审批系统。每项只增加明确 action、状态/金额校验、provider adapter、receipt、exact read-back 和 recovery。

### W5 — 发布机制收敛

保留为 release gate：

- typecheck、build、受影响测试和一次最终全量回归；
- 必要 PostgreSQL migrations/integration；
- HTTP OAuth edge；
- tool/capability reachability；
- immutable bundle/OCI identity；
- `/readyz` 的 version、toolset hash、migration head；
- 真实 Xero UAT；
- 单一 admission、blue/green switch 与 rollback。

退出 release gate、保留为按需诊断：

- `scripts/review/` 的独立评审/traceability closure/六轴 review；
- vendor/Codex binary identity evidence；
- 每个改动重复跑 process crash/restart；
- 7/7 长情景剧本和报告逐项人工对账。

process crash/restart 只在本轮写入状态机、持久化或 recovery 改动完成、RC 冻结后跑一次。

部署只保留：

```text
production-deployment-admission
  -> admit-and-compose
  -> candidate readiness/identity
  -> switch-xero-upstream
  -> public readiness
```

手工绕过 admission 的路径改为禁止或 break-glass 文档，不作为常规发布方式。

## 6. 子 Agent 分配与模型预算

根 Agent 负责范围、共享文件合并、外部依赖、最终 Go/No-Go，不把同一全仓上下文反复发给每个 Agent。

| 任务 | 模型 | 原因 |
|---|---|---|
| capability matrix、官方/本地逐项清点、陈旧常量扫描 | Luna xhigh | 机械、边界明确、适合高强度对照 |
| Skills 装载清理、字节预算、docs/profile/manifest 同步 | Luna high/xhigh | 低风险文本与静态验证 |
| 测试结果归档、UAT checklist、失败分类与证据索引 | Luna medium | 不需要跨架构判断 |
| Read surface 接线 | Terra high | 多层实现但领域边界清楚 |
| 单一路由族的 Case/schema/provider/read-back 实现 | Terra xhigh | 需要强编码能力，仍可限定文件面 |
| compiler、idempotency、unknown-write recovery、部署裁决 | 根 Agent / Sol high–xhigh | 跨层且出错代价高 |

执行纪律：

- 每个任务包只给“已确认事实、真相来源、允许文件、禁止文件、验收命令、未做事项”；
- 默认 `fork_turns=none`，不复制长历史；
- 每个 Agent 使用独立 worktree 或独占文件；
- Agent 不提交，或只提交自己明确列出的路径；根 Agent 不使用 `git add -A`；
- targeted test 在每批运行；全量 gate 只在 RC 冻结后运行一次；
- 不再派 Agent 做泛化的“重新审查整个系统”或重复阅读全部 Skills。

并行波次：

| 波次 | 并行任务 | 依赖 |
|---|---|---|
| A | Skill/manifest 清理；capability matrix；当前 WIP/typecheck 收敛 | 无 |
| B | Read surface；quote/PO/manual journal public intake；UAT harness/fixture | A |
| C | Contact/Item/Tracking；各类 DRAFT update（共享 compiler/service 的批次串行） | B |
| D | 非草稿账本动作；真实用户链路 fixture | C |
| E | RC gate；Demo Company 真实验收；部署与切流 | D |

## 7. 中断、重试和续跑

### 7.1 本地开发任务

每个批次保存：

```text
base SHA
worktree/branch
owned files
diff hash
last passed test
last failed command + stdout/stderr
remaining checklist
```

- 同一冻结 SHA 的同一失败步骤最多原样重试一次；再次失败进入 diagnosis，不循环消耗 token。
- 代码变化后只重跑受影响测试；RC 冻结后再跑一次全量。
- Agent 中断后从 checkpoint 与 git diff 续跑，不从任务描述重新推导全仓。

### 7.2 Xero 写入

每次 UAT 保存：

```text
candidate SHA / image digest / toolset hash / migration head
UAT run ID / tenant / action
case_id / case_version / request_id
provider object ID / mutation receipt / exact read-back
```

- timeout 或 `WRITE_UNCERTAIN`：禁止新 Case、禁止新 idempotency key、禁止盲目 create；
- 只允许同 `case_id + case_version + request_id` 恢复，并查 `xero_mutation_requests` 与 Xero exact object；
- 无法收敛则人工处理并保持 No-Go；其他对象成功不能覆盖这条不确定结果。

### 7.3 OAuth 与部署

- 重复点击/刷新不得把已经成功的连接变成裸 JSON 错误；授权处理中必须给等待/恢复状态；
- candidate 以 immutable image digest 标识；不复制旧 `XERO_BUILD_IDENTITY_JSON`；
- 先保持 write gate closed 做 OAuth、target、scopes 和 reads；
- 仅对绑定 Demo tenant 开最小写窗完成 UAT；
- 切流失败立即回旧 upstream，旧版本保持可恢复；不得边改源码边部署同一 candidate。

## 8. 最小真实验收

### 8.0 真实用户环境与交互主线

最终验收不是直接逐个调用底层工具，而是先模拟线上用户的完整工作方式：

```text
用户把真实形态材料放入线上 Google Drive
  → 线上 Accounting Agent 使用现有 Accounting Skills
  → 通过 Google Drive MCP 读取/补充材料
  → 通过 Xero MCP 读取当前 organisation 与账本事实
  → 形成 typed Accounting Case
  → 执行本场景需要的 Xero 写入
  → exact read-back，并用后续读取/Journals验证结果
```

验收材料至少覆盖 PDF 发票/账单、结构化表格和后补材料；对话使用自然业务语言，不向用户暴露 action ID、内部状态名、tool 名或测试暗号。Google Drive 是材料存储/同步层，Xero 是唯一 Ledger；测试不得把 Drive 文件或 Agent 回答当作已经记账的证据。

每条主线先验证 organisation：默认组织必须可读；需要切换时，Agent 返回现有 organisation-selection URL，用户在真实网页选择后重新 pin/读取 Organisation。除此之外不插入额外确认页面。

最终只保留四条高价值自然语言主线：

1. Drive 中的租金账单/费用说明 → Supplier Bill DRAFT → exact Bill read-back；
2. 客户开票材料 → Invoice DRAFT → authorise → exact Invoice + Journals；
3. 月末预提表与政策说明 → balanced Manual Journal DRAFT → post → exact Journal + Journals；
4. 付款通知与银行扣款证明 → 读取 Bill 未付余额 → 仅在 Xero 记录并分配 Payment → Payment/Bill/Journals 回读，明确不向银行发指令。

如果线上 Drive reader 只能列出 PDF/XLSX 而不能读取正文，文件名和 metadata 不能充当金额证据；必须使用受控导出、对话附件或可读文本补齐材料后再继续。这属于真实交互验收，不用 mock 掩盖。

### 8.1 机械可达性 gate

每个 `SHIP` 能力必须自动证明：

```text
public surface
-> schema
-> handler
-> policy/scope
-> service/action dispatch
-> provider
-> normalized receipt/read-back
```

任何一段缺失即 `NOT_SUPPORTED`，不允许 provider 方法或 policy 文案单独证明可用。

### 8.2 真实读取

读取按风险业务场景映射取证；每个独立 Xero API/provider family 至少完成一次 live operation：

- 返回非空或可解释的真实空结果；
- 结构可读、目标正确、query boundary 清楚；
- Journals 可按 offset 续页且不以 partial page 假设结束；
- P&L、Balance Sheet、Aged AR/AP 不要求逐 cell 人工重算；只核真实返回、核心结构/恒等式和日期/contact 边界；
- Payment exact read 必须由 list 得到 ID 后再 get。

### 8.3 真实写入

每个最终公开 action 至少一次经 Agent-facing public Case 跑到真实 Xero；同类 create+update 可在同一对象生命周期完成以节省时间。

每项必须同时满足：

1. `xero_mutation_requests = READBACK_VERIFIED`；
2. 无 `WRITE_UNCERTAIN` / `READBACK_MISMATCH`；
3. Xero 端按 provider ID 逐字段直查一致；
4. 账本事件用 Journals 验证借贷影响；Reference Data 则验证精确对象回读；
5. 再次提交相同 request 不产生第二对象；
6. scope 不足、错 tenant、非法状态、禁止动作在 Provider 前 `0 write`。

高信号负面只保留：

- 聊天文字不能直接切换 Organisation；错/过期/重复使用的 organisation-selection URL 不得改写 Binding；
- 错 Organisation / stale target；
- scope 不足；
- 借贷不等；
- QUOTE/PO counterparty 错向；
- update 非 DRAFT；
- timeout/unknown-result recovery 不重复创建；
- 非法对象状态或超出 typed action 的 AUTHORISE/POST/PAYMENT/VOID/REVERSE 在 Provider 前 `0 write`。

## 9. Go / No-Go

### Go

- capability matrix 中所有 `SHIP` commitments 具备 7 段公共可达链，并映射到风险业务场景；
- 没有 advertised-but-unreachable action；
- typecheck/build/targeted/full regression/必要 DB/HTTP 全绿且无条件 skip；
- allowlist、tool count/hash、README、Agent profile、UAT manifest、candidate metadata 同源；
- 每个 `SHIP` commitment 都映射到风险业务场景并有当前 candidate 的真实 Xero 证据；
- 所有写均有 provider ID、durable receipt 和 exact read-back；
- 外部真实资金指令、最终对账确认和破坏性能力明确拒绝；正常账本动作按风险业务场景映射验证；
- 线上 Google Drive MCP、Accounting Skills/Agent 与 Xero MCP 的真实用户主线通过；
- 部署只走 admission + immutable candidate + blue/green，可验证回滚。

### No-Go

- 任一 `SHIP` 能力只存在于 provider/policy/compiler 某一层；
- 任一公共 schema 无法表达 advertised action；
- 任一真实写入 `WRITE_UNCERTAIN`、read-back mismatch 或重复创建未收敛；
- Journals entitlement/scope 未确认却宣称支持 General Ledger read；
- tool count/hash/profile/部署身份漂移；
- 常规发布可以绕过 admission；
- 新能力没有真实 Xero 验收。

以下不应再作为 No-Go：旧 traceability closure 未闭合、重型 review 文档未修完、全量测试类型人体工学未清、历史情景剧本未全部重跑。它们不能证明当前 Xero 路径质量。

## 10. 立即执行顺序

1. 冻结 Cloud WIP 与拆批，不丢任何未提交修改。
2. 以 capability manifest 收敛当前工具/文档/部署 identity 漂移。
3. 为 Tracking 与 DRAFT update parity 取得真实 PostgreSQL/live Xero UAT 证据并达到 `READY`。
4. 按风险业务场景完成正常非草稿账本动作的真实验收，不增加确认/审批系统。
5. 准备真实形态 Drive 材料和自然语言业务剧本，并核对线上 Accounting Skills 配置。
6. 冻结 RC，仅跑一次精简完整 release lane。
7. 用 immutable candidate 部署到隔离端口，先验证 OAuth、organisation-selection URL 和读取。
8. 在专用 Xero test company 跑 `Drive → Skills/Agent → Xero → read-back/Journals` 主线。
9. 通过 admission 切流；公网 readiness 与只读回归后开放本次已验收写入。

最终交付物只有五类：

- 单一 capability matrix；
- 精简 Ledger Skill/Agent bundle；
- 可复现 RC source/bundle/image；
- 每项能力的自动 reachability 与真实 Xero receipts；
- Go/No-Go 与 rollback 记录。

不再新增平行架构、平行审批系统、平行总账、泛化 Workflow 平台或无法到达的验收体系。
