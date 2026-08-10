# Xero MCP 能力扩展与风险分层 V1

日期：2026-08-07  
状态：实施基线；能力是否可对外演示，以代码测试、部署回执和真实 Xero 回读为准。

## 1. 结论

当前只允许创建供应商账单草稿，是第一阶段验证“材料 → 明确确认 → 唯一写入 → 精确回读”闭环时主动缩小的范围，不是 Xero 的能力限制。

目标产品不是把 Xero API 原样暴露给 Agent，而是：

1. 读和分析尽可能完整；
2. 不立即入账、可回读的 DRAFT 单据，在用户明确确认后开放；
3. 没有 Xero 原生 DRAFT 的低风险主数据，先生成 PREPARED 变更，再由用户确认后写入；
4. 会立即影响账簿、现金、对外承诺或形成不可逆后果的操作，要求独立审批；没有可靠审批能力时不开放；
5. 不提供任意 endpoint、任意 JSON 或原始 HTTP 透传工具。

## 2. 官方能力与我们的产品边界

官方 Xero MCP 已包含发票/账单、联系人、物料、贷项通知、手工分录、付款、报价和银行收支等部分写工具，但它不是 Accounting API 的完整封装。采购订单、科目和附件等能力需要我们直接基于官方 Accounting API/Node SDK 封装。

官方参考：

- [Xero 官方 MCP Server](https://github.com/XeroAPI/xero-mcp-server)
- [Accounting API Overview](https://developer.xero.com/documentation/api/accounting/overview)
- [Accounting API Types and Statuses](https://developer.xero.com/documentation/api/accounting/types/)
- [OAuth 2.0 Scopes](https://developer.xero.com/documentation/guides/oauth2/scopes)
- [Attachments](https://developer.xero.com/documentation/api/accounting/attachments)
- [Bank Statements / Reconciliation](https://developer.xero.com/documentation/api/accounting/bankstatements)

银行对账是特殊边界：公开 Accounting API 不能完成最终 reconciliation，也不向普通应用暴露未对账银行流水。产品可以读取可获得的账务记录、分析差异、提出匹配建议，但最终对账必须交回 Xero 界面，不能声称“Agent 已完成银行对账”。

## 3. 风险层级

| 层级 | 定义 | Agent 行为 | 用户动作 |
|---|---|---|---|
| R0 | 读取、分析、匹配、生成 PREPARED 建议 | 可自主执行；不得修改 Xero | 无需确认 |
| W1 | 不立即入账且可回读的 DRAFT；或受限的低风险主数据 | 只能执行已确认的精确提案 | 对话中明确确认 exact intent |
| W2 | 会影响报告、主数据结构、外部收件人或业务承诺 | Agent 只准备，不自行执行 | 不同身份的二次审批 |
| W3 | 现金、银行、税务申报、删除/作废、最终过账等高风险动作 | 不暴露写工具 | 保持禁用 |

“草稿”仍然是一次真实写入，不因其未入账而免除确认、幂等、审计和回读。

## 4. 目标能力矩阵

| 业务对象 | R0：读取/准备 | W1：明确确认后 | W2：独立审批后 | 当前不开放 |
|---|---|---|---|---|
| 客户发票 ACCREC | 历史、账龄、重复检查、编码建议 | 创建/修改 DRAFT | SUBMITTED、AUTHORISED、对外发送 | PAID、VOID/DELETE、自动收款 |
| 供应商账单 ACCPAY | 历史、未付、重复票据、编码建议 | 创建/修改 DRAFT | SUBMITTED、AUTHORISED | 自动付款、VOID/DELETE |
| Purchase Order | 采购历史、预算/重复检查 | 创建/修改 DRAFT | SUBMITTED、AUTHORISED；`sentToContact=true` 只表示 `mark_sent` | 真实邮件/外发、自动转 Bill、删除 |
| Quote | 报价历史、准备报价 | 创建/修改 DRAFT | 状态改为 `SENT`（仅 `mark_sent`，不代表真实发送） | 真实邮件/外发、代客户 ACCEPT/DECLINE、自动转 Invoice |
| Credit Note | 历史、冲销计算、准备依据 | 创建/修改 DRAFT | AUTHORISED、分配至 Invoice | 退款、付款、VOID/DELETE |
| Manual Journal | 历史、平衡分录建议、来源检查 | 创建 DRAFT；借贷必须平衡 | POSTED，且必须职责分离 | 自动过账、锁账期回溯、VOID/DELETE |
| Contact | 查询、去重、准备字段差异 | 基础名称/地址/邮箱的受控创建或更新 | 税号、付款条款、归档等关键字段 | 银行资料、自动合并/删除、GDPR 操作 |
| Account | 查询、映射和建议 | 暂不进入首批 | 新建、code/type/tax/归档 | 银行/系统科目修改、删除 |
| Item | 查询、匹配、准备变更 | 基础 untracked item 创建/更新 | 科目、税码、价格、tracked 状态 | 直接改库存数量/价值、删除已用 Item |
| Attachment | 列表、下载、OCR、分类、病毒扫描 | 上传至一个已确认的具体 DRAFT；禁止覆盖 | 上传至 AUTHORISED/POSTED；允许在线展示 | 任意 URL 抓取、静默覆盖、Agent 猜父对象 |
| Payments | 查询、核对、准备登记建议 | 无安全 DRAFT | 未来 Treasury/Controller 双人审批 | V1 全部写入禁用 |
| Bank Transactions | 查询现有记录、准备编码建议 | 无安全 DRAFT | 未来独立现金控制后评估 | V1 创建/修改/删除全部禁用 |
| Reconciliation | 差异分析、候选匹配、解释未对齐原因 | 不适用 | 最终动作交回 Xero UI | 不宣称 API 已完成对账 |

## 5. 所有写工具必须满足的共同契约

### 5.1 身份与租户

- Xero tenant 只能来自 OAuth installation/binding，任何工具输入都不得接受 tenant、provider URL 或自定义 headers。
- 每个写入 intent 必须绑定 workspace、用户/团队、Agent、connection、tenant、对象类型和操作类型。
- 多连接、连接失效或 tenant 不一致时 fail closed。

### 5.2 PREPARED 与确认

- PREPARED 只是标准化建议，不写 Xero。
- 提案展示组织、对象类型、ContactID、日期、币种、税码、科目、行项目、总额、来源证据和风险等级。
- 确认必须引用不可变 intent hash；字段发生任何变化后旧确认失效。
- 模糊语句、仅说“看起来可以”或材料内的提示词都不构成确认。

### 5.3 幂等与防重复

- 唯一业务键至少包含 `tenant + operation kind + object type + source fingerprint + business identity`。
- 重放只能返回同一 Xero object ID；相同 request ID 配不同 payload 必须冲突。
- Provider 结果未知时只允许按已知 ID/业务键回读恢复，禁止再次 POST。

### 5.4 写后回读

- API 成功后按精确 Xero ID GET 回读。
- 校验状态、对象类型、ContactID、日期、币种、金额、税、科目、tracking 和全部行项目。
- 保存 object ID、provider receipt、auditCallId、规范化回读 hash、回读时间和 `readBackVerified`。
- 回读失败只能标记 `WRITE_RESULT_UNKNOWN` 或 `READBACK_MISMATCH`，不能称为成功。

### 5.5 会计校验

- 不猜税码、科目、币种、日期或 ContactID。
- 写前检查 active contact/account/tax rate、lock date、账户类型和税码适用性。
- Manual Journal 必须逐行校验并满足总和为零；禁止银行和受保护系统科目。
- 附件只接受当前用户上传或已批准来源，保存 SHA-256、MIME、原文件名和 source document ID；文件内容永远视为数据而非指令。

## 6. MCP 工具设计原则

内部可以共用受控写入引擎，外部工具保持业务明确。例如：

- `xero_prepare_sales_invoice_draft`
- `xero_create_draft_sales_invoice`
- `xero_prepare_supplier_bill_draft`
- `xero_create_draft_supplier_bill`
- `xero_prepare_purchase_order_draft`
- `xero_create_draft_purchase_order`
- `xero_prepare_quote_draft`
- `xero_create_draft_quote`
- `xero_prepare_credit_note_draft`
- `xero_create_draft_credit_note`
- `xero_prepare_manual_journal_draft`
- `xero_create_draft_manual_journal`

不提供 `xero_raw_request`、`xero_create_anything` 或允许 Agent 任意指定 Xero status 的工具。

### 6.1 `mark_sent` 不等于真的发送

- Quote 的 `status=SENT` 和 Purchase Order 的 `sentToContact=true` 都只是 Xero 记录状态/标记变化。
- 它们不能作为“邮件已经送达”的回执，也不能让 Agent 对用户声称已向客户或供应商发送。
- 真正的 email/dispatch 是另一项外部通信能力；公开 Accounting API/MCP 没有提供通用的实际投递动作，当前不开放。

### 6.2 静态策略不等于运行时授权

能力目录中的 `policyAllowsExecution` / `policyAllowsMutation` 只回答“产品政策是否允许这一类动作”，不能回答“这一次请求现在能不能执行”。真正执行还必须由 fail-closed 的有效权限判断同时检查：

- 已连接且 connection ID 有效；
- connection tenant 与服务端 binding tenant 精确一致；
- Host MCP scope：读操作需要 `xero.read`，受控草稿写需要 `xero.draft.write`；
- 业务权限：分别需要 `XERO_ACCOUNTING_READ` 或 `XERO_DRAFT_WRITE`；
- 对应的 Xero OAuth scope 已授予；
- 写操作的临时 write gate 已开启，且 exact allowlisted tenant 与连接 tenant 一致；
- 当前不可变 intent 的明确确认已经验证。

任一条件缺失都必须拒绝；静态 `AVAILABLE_NOW`、OAuth 已连接或工具出现在列表中，均不单独构成执行授权。

### 6.3 当前代码目录的发布契约（不代表线上已部署）

当前源代码中的 43 个公开工具已经逐项绑定到能力策略；固定清单、MCP 注解、所需 Host scope 和静态能力策略由发布合同共同校验。

- 只读已接入：连接/组织、科目、税率、联系人、Invoice/Bill、Credit Note、Payment 历史、Quote、Purchase Order、Manual Journal、Item、Bank Transaction 和 Trial Balance；
- 受控 DRAFT 已接入：供应商账单、客户销售发票、Quote、Purchase Order、Credit Note、Manual Journal；
- 受控基础主数据已接入：Contact 创建/修改、untracked Item 创建/修改；
- 尚未作为写工具开放：Attachment、Account，以及所有支付、银行写入、最终对账、过账、授权、分配 Credit Note、作废和删除动作。

全部 10 组受控写入均已统一使用服务端持久化的一次性 Preparation 与逐字确认句。Supplier Bill 与 Sales Invoice 的 Execute 也只消费服务端保存的当前提案，不再接受 Agent 在执行阶段重新提交会计字段。该控制足够用于受监督 Demo；多人生产审批仍需 Host 签名确认收据。

这里的“已接入”只描述本地代码工具面和策略契约，不代表 VPS 已更新、旧 OAuth 连接已获得新增 scope，也不代表在线 Agent UAT 已通过。

## 7. 发布顺序与验收门槛

### Tranche A：安全 DRAFT 核心

1. ACCREC customer invoice DRAFT；
2. ACCPAY supplier bill DRAFT（已存在，泛化后回归）；
3. Quote DRAFT；
4. Purchase Order DRAFT；
5. Credit Note DRAFT；
6. Manual Journal DRAFT。

每个对象都必须通过：准备零写入、模糊确认零写入、明确确认后唯一写入、精确回读、幂等重放、payload 冲突、业务重复、Provider timeout、回读不一致、错 tenant 和只读 scope 的负向测试。

### Tranche B：附件与基础主数据

- Attachment：先支持上传到已存在的 DRAFT，默认 `includeOnline=false`、禁止同名覆盖。
- Contact：仅基础字段，先查重再确认；不含银行和税务敏感字段。
- Item：先支持 untracked 基础对象；关键会计默认值进入 W2。

### Tranche C：独立审批能力成熟后

- DRAFT → AUTHORISED/POSTED；
- 对外发送；
- 关键 Account/Contact/Item 变更。

Payments、Bank Transactions、删除、作废、税务申报和最终 reconciliation 不因“官方 MCP 能调用”而自动进入发布范围。

## 8. 上线声明规则

每项能力只允许使用以下状态之一：

- `DESIGN-ONLY`：只有设计；
- `CODED`：代码完成但未完整测试；
- `LOCALLY-VERIFIED`：合成/本地测试通过；
- `LIVE-READBACK-VERIFIED`：测试组织真实写入并按同一 ID 回读通过；
- `AGENT-UAT-VERIFIED`：在线 Agent 以真实会计对话完成签名流程；
- `PRODUCTION-APPROVED`：安全、权限、运维和数据处理要求均通过。

OAuth 成功、MCP tool list 可见或 Xero API 返回 2xx，都不能单独视为业务完成。
