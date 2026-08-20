# 精简真实验收清单

用户明确要求：**验收要快，不要用力过度**。本清单按风险业务场景取证，不按 capability manifest row 数机械重复执行；一个场景可以覆盖多个已映射的 `SHIP` row。

驱动方式：部署候选 → 切 nginx → 在 **agent2.zcloak.ai / work.zcloak.ai** 里驱动。
不要再走 Claude connector（见 memory `xero-live-acceptance-path`）。Work 会缓存工具清单，新工具要到 MCP 面板点刷新才可见。

`SHIP` 只表示 R1 承诺；`readiness=READY` 才表示公共链、自动化证据和真实 live 证据完成；发布要求所有 `SHIP` rows 都为 `READY`。Attachment 保持 `LATER_NONCORE`，不纳入本轮核心验收。Bank Transaction reverse 代码链已接通，但在真实 PostgreSQL/live Xero UAT 前保持 `NOT_READY`；`credit_note.unallocate` 是同一 bounded allocation family 的纠错补强，也不得提前宣称 `READY`。

## 一、验收前置

- 使用 immutable candidate、真实 Demo Company、已核对的 OAuth target/binding、真实 PostgreSQL migration 和开启的 write switch。
- 每次写入都由 immutable typed Case/plan hash、one-shot `ledgerProviderWritePermit`、provider receipt 和 exact read-back 保护；Host 通用 tool-permission UX 不是 MCP 依赖的人类确认 gate，唯一 MCP 用户确认仍是 organisation-selection URL。
- `xero_mutation_requests` 必须出现 `READBACK_VERIFIED`，且全程不得出现 `WRITE_UNCERTAIN` 或 `READBACK_MISMATCH`。

## 二、最小完整账务闭环

在 Demo Company 上跑一条完整业务链：

1. 建立或读取 contact；
2. supplier bill `create_draft` → `authorise`；
3. `payment.create` 核销该 bill，确认 AmountDue 变为 0；
4. `bank_transaction.create` 写入一笔 SPEND（银行手续费）；
5. credit note `create_draft` → `authorise` → `credit_note.allocate` 到一张发票；
6. manual journal `create_draft` → `post`；
7. 用 `xero_list_journals` 拉出上述账务事件，确认借贷合计相等、科目符合预期；
8. 用 `xero_get_aged_payables` 确认第 2 步的 bill 已从账龄消失。

Credit Note refund 必须在映射的 typed Case/provider/receipt/read-back 证据中单独记录，不得用 allocation 证据冒充 refund。

## 三、非草稿纠错路径

每个当前支持的纠错动作各真实执行一次：

- `payment.reverse`，确认第 3 步 AmountDue 回来；
- `bank_transaction.reverse`；代码链已接通，但必须取得真实 PostgreSQL/live Xero UAT 证据后才可 `READY`；
- invoice/bill `void`；
- `credit_note.void`；
- `manual_journal.void`。

`credit_note.unallocate` 只作为 bounded allocation reversal 记录，未取得 live evidence 前保持 `NOT_READY`。只验收已支持的 reverse action，不把未完成 live evidence 的动作计入当前 `READY`。

## 四、四个关键负例

- 借贷不等的日记账 → `JOURNAL_NOT_BALANCED`，且不产生任何操作；
- 付款金额超过未核销余额 → 明确拒绝，不得部分写入；
- 聊天文字试图切换 Organisation → 拒绝；错、过期或重复使用 organisation-selection URL 不得改写 Binding；
- 同一个 `case_id + case_version` 重复提交 → 幂等命中，Xero 端只有一个对象。

## 五、读取与 provider-family 覆盖

- 每个独立 Xero API/provider family 至少完成一个 live operation；证据可由上述场景共享，但必须记录映射关系。
- `xero_get_profit_and_loss`、`xero_get_balance_sheet`、`xero_get_aged_receivables`、`xero_get_aged_payables` 各做一次 bounded response，确认真实返回、目标和边界可读；不要求逐 cell 人工重算。
- `xero_list_journals` 验证完整闭环的总账事件和借贷影响；Journals 不假装覆盖所有报表读取。

统一判据：Xero 端按 provider ID 直查与 Agent 所述逐项一致；所有写入有 durable receipt、exact read-back 和幂等证据。未满足即保持 `NO-GO`，不得仅因本地 typecheck、provider 测试或 manifest 行可达而宣称 `READY`。
