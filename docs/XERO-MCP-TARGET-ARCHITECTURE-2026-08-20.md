# Xero MCP 目标产品架构（上线冻结版）

状态：`FROZEN FOR R1`
日期：2026-08-20
适用范围：Xero MCP 当前上线收尾；不定义未来多会计平台产品

## 1. 架构结论

Xero MCP 的最终产品形态固定为：

> 一个面向 Agent 的、具备明确组织绑定和可审计写入闭环的 **Xero Ledger Gateway**。它完整暴露本期需要的会计读取，并支持正常会计工作中的草稿、主数据和账本状态写入；Xero 始终是唯一正式账本。

它不是：

- 会计 SaaS 或另一套总账；
- 通用 Workflow / Approval 平台；
- 多 Provider 会计抽象层；
- 原始文件库、OCR 系统或知识库；
- 任意 Xero API / generic CRUD 代理；
- 为发布而存在的独立评审、证据图或 traceability 产品。

这六条是 R1 的架构冻结线。实现过程中不得以“以后可能需要”为理由扩建。

## 2. 产品责任边界

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| Agent / MCP Host | 理解用户意图、收集资料、生成业务建议、调用 typed Case | 不能自行声明 Tenant、仅凭聊天文字切换 Xero 组织或绕过 Case |
| Xero MCP | 身份与组织绑定、有界读取、确定性校验、正常账本写入、幂等、receipt、精确回读、恢复与审计 | 不保存余额、不重建报表、不替代 Xero、不向银行发起真实资金指令 |
| Xero | 正式会计对象、状态、总账、报表和最终事实 | 不承担 zCloak Agent 的权限、幂等和操作审计 |
| PostgreSQL 控制面 | OAuth/Connection/Binding、Case/Operation 状态、幂等键、receipt/read-back 摘要、审计 | 不复制完整 Xero Ledger，不成为第二事实来源 |
| Host 文件层 | 原始 PDF/Excel/邮件及其版本 | MCP 只接收不可猜测引用与必要 hash，不扩建文件平台 |

一句话判断：**凡是 Xero 已经是事实来源的东西，不在 MCP 内再造一份。**

## 3. 最小运行架构

```text
Accounting Agent / MCP Host
            │
            ▼
┌──────────────────────────────────────────────┐
│ 1. MCP Edge + OAuth / Target Binding         │
│ 2. Typed Capability Surface                  │
│    ├─ bounded read tools                     │
│    └─ Accounting Case prepare/review/execute │
│ 3. Deterministic Ledger Application Core     │
│    schema · policy · balance · idempotency    │
│ 4. Xero Provider Adapter                     │
│ 5. Operation Store + Audit                   │
└──────────────────────────────────────────────┘
            │
            ▼
       Xero Accounting API
            │
            ▼
       Xero formal ledger
```

只保留五个运行时职责，不再拆成更多平台子系统。

### 3.1 MCP Edge 与 Target Binding

- MCP Access Token 解析出服务端可信的 user / installation / binding / connection；
- Tenant/Organisation 只能由有效 Binding 决定，工具参数和对话文本不得自报；
- 每次响应包含足够的 target identity，能让操作者确认“读写的是哪一个组织”；
- 多组织只通过现有 `xero_start_organisation_switch` 返回的短效 URL 选择：用户在网页中选择一个已授权组织，Agent 不能仅凭聊天文字切换；这是 R1 唯一需要用户确认的流程。Host 可能提供通用 tool-permission UX，但它不是 MCP 依赖的人类确认或安全 gate。
- R1 写入安全依赖 immutable typed Case/plan hash（预览即执行，ADR-002 §8）、当前 OAuth target、write switch、`ledgerProviderWritePermit` 一次性许可、provider receipt 与 exact read-back；不增加旧 approval 状态机。

### 3.2 Typed Capability Surface

公共面只有三类：

1. 连接与能力：target context、capabilities；
2. 有界、类型化的读取工具；
3. Accounting Case 的 prepare / review / execute。

所有对象写入都通过 Accounting Case 的 typed action union。生产环境不重新开放 legacy object-mutation tools，不提供 raw endpoint、raw JSON 或 arbitrary filter。

工具数量不是架构常量。工具名、数量、capability hash、文档和部署 metadata 必须从同一个 machine-readable capability manifest 派生。

### 3.3 Deterministic Ledger Application Core

这一层只做会造成真实生产风险的确定性控制：

- action 与字段白名单；
- Tenant/Binding 校验；
- 对象状态与 action 的允许转换；
- Manual Journal 借贷平衡；
- 税码、科目、tracking option 等引用合法性；
- case version、一次性执行许可和幂等；
- write receipt、exact read-back 和 mismatch；
- unknown-write recovery。

会计判断、材料理解和建议由 Agent 完成；上述硬控制不能只写在 prompt 或 Skill 里。

ADR-002 的网关边界继续有效：MCP 只核验绑定、类型和账务硬约束，不做会计判断；Agent 必须传入显式 `account_code` / `tax_type`。

### 3.4 Xero Provider Adapter

- 直接封装官方 `xero-node` / Accounting API；
- 一种能力对应明确方法和明确输出，不做万能 provider 方法；
- 保留薄的 adapter 边界以隔离 SDK response shape，不建设 QuickBooks 等未上线 Provider；
- Provider 方法存在不等于产品支持，只有公共调用链完整才可标记 `SHIP`。

### 3.5 Operation Store 与 Audit

只持久化完成安全执行与恢复所需的数据：

```text
binding / connection
case_id + case_version
action_id + idempotency_key
request hash + policy result
provider object id + receipt
read-back result + final operation state
timestamps + actor/installation identity
```

不保存可计算成另一套余额的完整会计镜像。

## 4. R1 能力边界

每项能力在唯一 capability manifest 中只能是：

- `SHIP`：本期 R1 承诺；可达性和证据由 `readiness` 单独裁判；
- `EXCLUDED_RISK`：真实外部资金指令、官方 API 不支持的最终动作，或本产品明确禁止的破坏性操作；
- `LATER_NONCORE`：合法但不影响本期 Ledger Gateway 上线。

不得使用“基本支持”“Provider 已有”“开发完成 80%”等模糊状态。

### 4.1 R1 必须完整的读取

| 能力族 | R1 读取 |
|---|---|
| 目标与配置 | Organisation、Accounts、Tax Rates、Tracking Categories/Options |
| 主数据 | Contacts、Items、Contact Groups |
| 单据 | Customer Invoice、Supplier Bill、Credit Note、Quote、Purchase Order、Manual Journal 的 list/get |
| 资金历史只读 | Payments list/get、Bank Transactions list/get |
| 总账与报表 | Journals、Trial Balance、Profit & Loss、Balance Sheet、Aged Receivables、Aged Payables |

规则：

- `Journals` 是真实总账事件读取，不能用 `Manual Journals` 替代；
- 读取必须有 query boundary、pagination/completeness 和 observed-at 证据；
- 报表只返回 Xero 的有界结构，不在 MCP 内建立报表计算引擎；
- Journals 若受 Xero tier/approval 限制，产品必须明确返回 `ENTITLEMENT_REQUIRED`，不能伪装成空结果；
- Contact Groups 是官方 MCP 当前命令面的一部分，本期必须 `SHIP`；
- Attachment read/upload 是来源材料运输，不是正式 Ledger 状态，R1 明确为 `LATER_NONCORE`；
- dedicated Prepayment/Overpayment read 属于资金相邻扩展，且不在官方 MCP 当前命令面，R1 明确为 `LATER_NONCORE`；
- Payroll、Fixed Assets、Budgets 和地区税表不属于本期 Ledger Gateway，R1 明确为 `LATER_NONCORE`。

### 4.2 R1 普通写入

共同条件：有确定性校验、有 provider receipt、有 exact read-back。

| 能力族 | 普通动作 |
|---|---|
| Contacts | create basic、update basic；禁止银行/支付/敏感税务身份字段 |
| Items | create/update basic untracked；禁止库存数量、价值与 inventory state |
| 单据草稿 | Customer Invoice、Supplier Bill、Credit Note、Quote、Purchase Order 的 create/update DRAFT |
| Manual Journal | create/update DRAFT，且写前借贷平衡 |
| Tracking | Category/Option 的安全 create/update；禁止删除和历史重写 |

### 4.3 R1 非草稿账本状态写入

以下动作属于正常 bookkeeping。它们会改变 Xero Ledger，但“在 Xero 中记录资金事实”不等于“向银行发起真实付款”，不得因名称包含 Payment/Bank 就永久排除：

| 能力族 | 正常动作 |
|---|---|
| Invoice / Bill | authorise；仅允许从合法前置状态转换 |
| Manual Journal | post；写前借贷平衡并核对会计期间 |
| Payment | `payment.create` 记录 payment；`payment.reverse` 纠正 eligible payment |
| Bank Transaction | create/update Xero 中的 SPEND/RECEIVE ledger record |
| Credit Note | `credit_note.allocate`；`credit_note.refund` |
| 纠错 | 对官方 API 支持的对象执行 void/reverse；优先纠错状态，不做 hard delete |

安全能力的稳定 SDK / adapter 边界是 `payment.create`/`payment.reverse` 与 `credit_note.allocate`/`credit_note.refund`。现有 Payment 对象的 generic `payment.allocate`/`payment.refund` 当前没有稳定 SDK exact primitive，不得伪接；Prepayment/Overpayment allocation 是不同对象的非核心能力，不能冒充 Payment allocation/refund。generic action 没有对应公共 action 时标为 `NOT_APPLICABLE`，如保留候选项则标为 `LATER_NONCORE`，除非未来明确 scoped。

这些动作不增加签名、审批、确认 token 或新确认状态机。它们和其他写入一样走现有 typed Accounting Case，并要求：

- target 来自当前 OAuth installation/binding；如果用户要换组织，只能先走现有 organisation-selection URL；
- 状态转换、金额、币种、对象 ID、未分配余额和会计期间必须重新读取并校验；
- 继续使用同一幂等、receipt、exact read-back 和 unknown-write recovery；
- capability manifest 必须把纳入 R1 的 create/update/authorise/post/allocate/refund/void/reverse 分成独立 row，不能用一个笼统 action 代替；不在 R1 的 generic `payment.allocate`/`payment.refund` 不得用其他对象 endpoint 填充。

上述 R1 Payment/Credit actions 已完成公共 schema → read-back 的代码闭环，但冻结 candidate 仍需真实 PostgreSQL 与 live Xero UAT；本地代码、provider 测试或 typecheck 不能把当前 `NO-GO` 改为 Go。其他尚未完成公共 schema → read-back 的能力，仍必须标成 `LATER_NONCORE` 或明确 `NOT_SHIPPED`；不能用隐藏 legacy tool、provider 方法或文档宣称替代。

### 4.4 继续明确排除的操作

- 通过银行、支付机构或其他外部系统真实发起、批准或释放资金；
- Bank Feed 数据注入或篡改、Batch Payment 的银行执行编排；
- hard delete、绕过 Xero 正常纠错状态的历史重写；
- Account、Tax、bank/system account 的破坏性结构变更；
- Payroll 发薪、tax filing、period close/lock；
- final bank reconciliation confirmation。MCP 可以读取、匹配、解释差异和准备建议，但当前官方 Accounting API 没有稳定的最终确认写入面时不得模拟成功；
- 任意 API、任意 URL、任意 JSON 或 generic CRUD。

这些才是 `EXCLUDED_RISK`。如果未来官方 API 出现稳定能力且用户明确扩展边界，必须按第 10 节重新裁决。

## 5. 一项能力怎样才算“真的支持”

唯一 capability manifest 至少包含：

```text
capability_id
official_reference
release_disposition
public_tool_or_case_action
input_schema
handler
policy
service_dispatch
provider_method
receipt_and_readback
read_evidence_profile
oauth_scope
automated_tests
live_uat_evidence
```

Manifest 的官方基线固定引用当期 [Xero 官方 MCP Available Commands](https://github.com/XeroAPI/xero-mcp-server#available-mcp-commands)，并允许用 `zcloak_extension` 标识 Journals、Purchase Order 等本产品额外承诺。它必须逐项列出而不是只列能力族；第一项实施工作就是建立这个文件。现有 `XERO_WRITE_ACTIONS`、policy、tool contract、allowlist、read-evidence profile、README/UAT/deploy metadata 都必须由它生成或被它自动校验，不能继续成为并列真相源。

`SHIP` 只表示 R1 承诺；`readiness=READY` 才表示公共链、自动化证据和真实 live 证据均已完成。发布 Go 要求所有 `SHIP` rows 都为 `READY`。

`READY` 的公共链判据：

```text
public route
  → typed schema
  → handler
  → policy
  → service/action dispatch
  → provider SDK call
  → receipt or normalized read evidence
  → exact read-back（写入时）
  → automated + live acceptance evidence
```

任一段缺失即为 `ORPHAN`，不得对 Agent 宣称可用。Provider、policy、schema 或测试中的单独存在都不构成支持。

## 6. 写入状态机与中断恢复

```text
PREPARED
  → REVIEWED
      → EXECUTING
  EXECUTING
      ├─ provider 未受理 → FAILED_SAFE（可在同一 case/version 重试）
      ├─ 结果不确定     → WRITE_UNCERTAIN（禁止新请求）
      └─ provider receipt
             → exact read-back matched → READBACK_VERIFIED
             → mismatch / absent       → WRITE_UNCERTAIN
```

恢复规则：

- 只允许同一 `case_id + case_version + action_id + idempotency_key` 恢复；
- 不因超时创建新 Case 或新 idempotency key；
- 先查本地 operation，再按 provider object ID 精确读取 Xero；
- 无法收敛时转人工，绝不盲重试；
- OAuth/进程中断不改变上述语义。

## 7. 上线架构

只有一条常规生产路径：

```text
frozen commit / immutable image
  → migration
  → production admission
  → candidate /readyz identity
  → capability hash match
  → live Xero acceptance
  → blue-green switch
  → public readiness + read-only smoke
  → rollback window
```

手工绕过 admission 只能作为显式 break-glass，不能写成常规 runbook。

`/readyz` 至少证明：build/commit identity、migration head、capability hash、provider mode 和依赖健康。工具数量不得人工钉死为 28/29/30。

## 8. 验收 Gate 与“Gate 本身是否合理”

### Gate A — Build health

- typecheck、build；
- 受影响测试；
- RC 冻结后一次完整 release suite。

### Gate B — Capability reachability

- 先检查官方基线与 zCloak 扩展是否逐项出现在 manifest，防止“整项漏列”；
- 每个 `SHIP` manifest row 自动检查完整链路；
- allowlist、contract、profile、README、UAT manifest、deploy metadata 同源；
- 每个 `EXCLUDED_RISK` 有拒绝测试。

### Gate C — Real Xero acceptance

- 不按 manifest row 数机械逐项执行；每个 `SHIP` row 必须映射到风险业务场景证据，多个 rows 可以共享同一场景，但不能用未映射的场景宣称 `READY`；
- 最小真实验收包含：一条完整账务闭环（contact → supplier bill DRAFT/authorise → `payment.create` 后 AmountDue 为 0 → `bank_transaction.create` → credit note DRAFT/authorise/allocate → manual journal DRAFT/post → Journals 借贷相等且科目符合预期 → Aged Payables 确认 bill 消失）；
- `credit_note.refund` 必须在 credit-note 场景中单独取证，不得用 allocation 证据冒充 refund；
- 所有当前支持的非草稿纠错动作各执行一次：`payment.reverse`、`bank_transaction.reverse`、invoice/bill `void`、`credit_note.void`、`manual_journal.void`。Bank Transaction reverse 代码链已接通，但在真实 PostgreSQL 与 live Xero UAT 前保持 `NOT_READY`；只对已支持的 reverse action 取证；
- `credit_note.unallocate` 是同一 bounded allocation family 的纠错补强；未取得真实 PostgreSQL 与 live Xero UAT 前保持 `NOT_READY`，不得宣称 `READY`。
- 四个关键负例必须失败：借贷不等返回 `JOURNAL_NOT_BALANCED` 且不产生操作；付款超过未核销余额且不得部分写入；聊天文字不能切换组织；同一 `case_id + case_version` 重提命中幂等且 Xero 只有一个对象；
- 每个独立 Xero API/provider family 至少有一个 live operation；P&L、Balance Sheet、Aged Receivables、Aged Payables 各做一次 bounded response。Journals 验证账务事件和借贷影响，不假装覆盖所有报表读取；
- 每次写入必须拿到 provider receipt、对象 ID、exact read-back 和字段核对；组织切换必须通过真实 URL，并验证错/过期/重复使用链接不能改写当前 Binding；
- 测试数据与 Tenant 明确标记，可追溯但不包含 token。Attachment 仍是 `LATER_NONCORE`，不纳入本轮核心验收。

### Gate D — Deployment and rollback

- migration、candidate identity、capability hash；
- 唯一 admission 路径；
- 切流后公网 readiness 和 read-only smoke；
- 对冻结 candidate 至少演练一次由坏 image/readiness 或等价安全负例触发的真实回滚；
- 回滚不得破坏已经成功并在 Xero 留存的写入。

### Gate sanity meta-check

一个检查只有同时满足以下条件，才允许成为硬 Gate：

1. 能说出它防止的具体生产故障；
2. 在当前发布路径上真实可执行；
3. 对一个已知坏例或故意构造的负例会失败；
4. 通过结果能区分“可上线”和“不可上线”；
5. 成本与风险相称，且不依赖无关系统。

不满足者降为诊断项。陈旧 tool-count、恒失败 review closure、vendor identity、与本次改动无关的全历史审查不得阻塞发布。

## 9. 实施 SOP 的架构约束

- 根 Agent 负责 scope、共享接口、跨层裁决和最终 Go/No-Go；
- 机械清点、常量/文档同步、测试结果归档使用 Luna；
- 单一能力族的 schema/service/provider 接线使用 Terra，并限定文件所有权；
- idempotency、unknown-write recovery、compiler 共享核心和部署切流由根 Agent / 高能力 coding model 处理；
- 独立任务并行，依赖同一共享文件的任务串行合并；
- 子 Agent 默认 `fork_turns=none`，只接收事实包、允许文件、禁止文件和验收命令；
- 先跑 targeted tests，代码冻结后只跑一次完整 release lane；
- 每个 checkpoint 记录 commit/diff、已过命令、未过原因和下一恢复点；
- 不给 Agent 分配“泛化审查整个系统”或“阅读所有 Skill”的任务。

## 10. 架构变更规则

R1 实现阶段，只有以下情况可以修改本文件：

- 发现现有约束导致真实 Xero API 无法正确实现；
- 发现重大安全/会计正确性风险；
- 用户明确改变本期产品边界。

提议变更必须同时写清：真实证据、最小替代方案、上线影响和新增验收。仅因“未来可能复用”“架构更完整”“最好统一抽象”不得改变冻结架构。

## 11. 当前代码与目标架构的已知差距

以下是实现缺口，不是重新设计理由。2026-08-20 当前进度已经完成 38 个公共读工具、基础 Contact/Item 与 DRAFT create Case、Invoice/Bill authorise、Manual Journal post，以及新的生产迁移真实 PostgreSQL 验证；仍缺：

- Invoice/Bill/Credit Note/Quote/Purchase Order/Manual Journal 的 DRAFT update、Tracking Category/Option create/update、`payment.create`/`payment.reverse`、Bank Transaction create/update/reverse、`credit_note.allocate`/`credit_note.refund` 与支持的 void/reverse 已接通公共 Case → provider → receipt/read-back 代码链路；冻结 candidate 尚缺真实 PostgreSQL 与 live Xero UAT，所有相关 `SHIP` commitments 仍未 `READY`，候选保持 `NO-GO`。Bank Transaction reverse 在 live evidence 前保持 `NOT_READY`；`credit_note.unallocate` 是同一 bounded allocation family 的纠错补强，也不得提前宣称 `READY`；generic `payment.allocate`/`payment.refund` 没有稳定 SDK exact primitive，不在 R1，标为 `LATER_NONCORE`/`NOT_APPLICABLE`，不得以 Prepayment/Overpayment allocation 冒充；
- capability manifest 的 `SHIP` rows 仍需按风险业务场景取得映射证据并达到 `readiness=READY`；
- Google Drive → Accounting Skills/Agent → Xero MCP → exact read-back/Journals 的真实在线用户链路，以及 admission、blue/green、public smoke、rollback 尚未执行。

后续计划只围绕关闭这些差距和完成真实验收，不再扩建产品边界。

按上述裁判，2026-08-20 当前工作树仍为 **NO-GO**：R1 DRAFT/Tracking/Payment/Credit/Bank/void/reverse 代码链已接通，但冻结 candidate 尚未完成真实 PostgreSQL 与 live Xero UAT 映射证据，相关 `SHIP` rows 尚未全部 `READY`。Bank Transaction reverse 与 `credit_note.unallocate` 在 live evidence 前保持 `NOT_READY`。NO-GO 的含义是继续按冻结架构补真实断点，不是启动新一轮架构设计。

## 12. 本文件取代什么

本文件取代 `XERO-MCP-PRODUCT-ARCHITECTURE-V1.md` 中尚未实现的扩张性设计，尤其是独立 Source Bundle 平台、Evidence Graph、通用 Policy/Approval Engine、Rate Limit Scheduler/Cache、Webhook Inbox、多 Provider 架构和通用 Operation Proposal 平台。

旧文件可作为历史背景，但不得作为 R1 实现清单或发布 Gate。
