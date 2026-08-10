# Xero MCP 当前能力说明

核对日期：2026-08-07  
测试宿主：Agent2  
公网入口：`https://mcp.jiayuanwang.xyz/mcp`  
产品判定：`PERSONAL POC PASS / PRODUCTION NOT APPROVED`

## 先说结论

当前 `0.2.13` `.4` release 已完成 Agent2 × Xero Trial 的单人核心闭环：OAuth 连接和组织绑定、真实存量读取、材料辅助分析、只读草稿准备、明确确认后的单张 `DRAFT` 创建、同 ID 回读和应用层幂等重放均有线上证据。

它不是一套新总账。Xero 始终保存正式账目；Agent2 负责会计对话、材料和模型编排；zCloak MCP 负责受控工具、组织绑定、权限、写入保护、防重复、回读和审计；PostgreSQL 只保存授权、流程状态、幂等和审计证据。

当前结果只适用于预配置个人测试身份和 Xero Trial 组织 `zcloak`。团队身份、多用户隔离、Host 签名确认和 Host 签名材料来源收据尚未达到生产门槛。

## 当前证据分层

| 层级 | 已验证 | 边界 |
|---|---|---|
| 当前公网 | 新域名、OAuth metadata、健康/就绪、15 工具、Agent2 MCP 调用 | 不代表每个工具在所有数据规模和故障条件下均已生产验证 |
| Agent2 业务 UAT | 4 个会计 Persona、5 类场景、11 个浏览器组合 | 不是完整 33 次 Remote Agents 重复批测 |
| 受控读取 | 写入前窗口 61 次读/prepare、0 次写入；联系人 list/get 最终 4 调用闭环 | 材料来源仍没有 Host 签名收据 |
| 受控写入 | 本轮唯一一张 `DRAFT`、同 ID 回读、应用层幂等重放 | 不代表任意网络故障下底层 HTTP “恰好一次” |
| 生产状态 | Personal POC 可演示 | 多用户真实客户生产写入仍为 `NO-GO` |

## 当前 15 个 MCP 工具

除创建草稿外，其余工具只需要 `xero.read`。创建草稿还需要 `xero.draft.write`、明确确认声明和临时写入开关。

| # | 工具 | 会计用途 | 关键边界 |
|---:|---|---|---|
| 1 | `xero_connection_status` | 查看 Xero 连接状态 | 不返回 Token |
| 2 | `xero_get_organisation` | 查看当前公司和本位币 | Organisation 由服务端绑定，Agent 不能传 Tenant ID |
| 3 | `xero_list_accounts` | 查询有效会计科目 | 只读，不创建或修改 |
| 4 | `xero_list_tax_rates` | 查询可用税码 | 只读，不自行发明税率 |
| 5 | `xero_list_contacts` | 不知道名称时分页列出联系人 | 默认 `ACTIVE`；可按供应商/客户筛选；单页最多 100；不接受 raw `where` |
| 6 | `xero_get_contact` | 按精确 ContactID 回读联系人 | 只返回白名单会计字段；可读归档联系人；不返回银行、税号、邮箱或地址 |
| 7 | `xero_search_contacts` | 按关键词分页查找联系人 | 有页码和结果上限；不创建联系人 |
| 8 | `xero_list_invoices` | 查看销售发票和供应商账单历史 | 固定筛选和分页，不接受任意查询语句 |
| 9 | `xero_list_credit_notes` | 查看 Credit Note 历史和明确关联 | 只读，不创建、分配、Void 或删除 |
| 10 | `xero_list_payments` | 查看付款和回款历史 | 只读，不返回银行账号，不创建或对账 |
| 11 | `xero_get_invoice` | 按精确 ID 读取一张 Invoice/Bill | 只读，ID 必须属于当前绑定组织 |
| 12 | `xero_get_supplier_bill` | 按精确 ID 读取供应商账单 | 只读 |
| 13 | `xero_prepare_supplier_bill_draft` | 将材料字段与联系人、科目、税码精确匹配，生成提案 | 始终 `executionAllowed=false`；不写 Xero；不猜 ID |
| 14 | `xero_create_draft_supplier_bill` | 创建一张 ACCPAY `DRAFT` 并立即回读 | 需要明确确认、`xero.draft.write` 和写闸；不 AUTHORISE、不付款 |
| 15 | `xero_get_trial_balance` | 读取有界 Trial Balance | 只读；结果和 Provider 下载均有大小、节点、深度和超时上限 |

联系人新能力已用真实 Agent2 会话验收：平台重新同步 MCP 元数据后，Agent 用 4 次调用完成 `connection → organisation → list_contacts → get_contact`。服务器审计显示四次全部 `SUCCEEDED`，list/get 各一次，prepare/create 为 0。测试联系人 `14c4056e-97d3-4e7e-8285-60bf9860d100` 被真实回读为供应商、非客户；默认币种和采购默认科目未由 Xero 返回，因此 Agent 如实报告未知。

Trial Balance 正常规模结果已在真实 Agent2 场景中读取。15 秒 deadline、压缩前 2 MiB 和解压后 8 MiB 的超限行为主要由本地 socket 回归证明，没有专门制造真实 Xero 超大响应。

## 已验收的会计主流程

1. 预配置个人测试身份在 Agent2 完成 Xero OAuth，并明确选择 Organisation。
2. Agent 每轮重新确认公司和本位币，再读取联系人、科目、税码、Invoice/Bill、Credit Note、Payment 和 Trial Balance。
3. 用户材料与 Xero 存量记录一起分析；输出区分材料事实、Xero 回读、推断、冲突和未知。
4. `xero_prepare_supplier_bill_draft` 只有在联系人、科目和税码精确匹配时生成规范提案；准备成功不授权写入。
5. 含糊确认不写入。只有用户对当前提案明确要求创建 `DRAFT`，Agent 才能声明 `CONFIRMED_FOR_DRAFT`。
6. 明确确认、`xero.draft.write` 和临时写闸同时通过后，只创建一张 `DRAFT`。
7. Agent 按同一 Xero InvoiceID 回读关键字段；相同 posting request 重放返回同一记录。
8. 完成受控写入后立即关闭写闸；Agent 不批准、不付款、不删除。

本轮唯一 DRAFT：

- Invoice ID：`ed78bd41-9025-4f26-a708-9b67e20b37c4`
- Reference：`ZC-AGENT2-UAT-20260805-001`
- 状态：`DRAFT`
- 总额：HKD 12.34
- 首次创建：`readbackVerified=true`、`idempotentReplay=false`
- 相同 posting request 重放：同一 Invoice ID、`idempotentReplay=true`

## 官方能力与 zCloak 自研层

| 层 | 提供方 | 负责什么 |
|---|---|---|
| 身份与正式账本 | Xero 官方 | OAuth、Organisation、Contacts、Accounts、Tax、Invoices/Bills、Credit Notes、Payments、Trial Balance 和 Xero 网页 |
| API 调用 | Xero Accounting API 与 `xero-node` | 按 Xero 权限读取或创建对象 |
| MCP 协议 | 官方 Model Context Protocol SDK | 工具发现、参数合同和 Streamable HTTP |
| 会计对话与材料界面 | Agent2 | 用户聊天、模型推理、文件加入会话和工具编排 |
| 安全连接与会计控制 | zCloak 自研 | OAuth Broker、Token 加密、Organisation 绑定、15 个工具、写闸、精确匹配、幂等、回读、审计、撤销和重连 |

zCloak 不复制 Xero 总账，也不开放任意 Xero endpoint、raw `where` 或由 Agent 指定 Tenant ID 的万能工具。

## OAuth 与 Personal POC 身份边界

Agent2 只持有 zCloak MCP access/refresh token；Xero access/refresh token 加密保存在服务端，不进入模型上下文或工具结果。MCP token 绑定 Installation、Binding、Connection 和已选 Xero Organisation，提示词不能切换租户。

当前 `PERSONAL_POC_ONLY=true` 表示：

- 一个预配置测试身份；
- 一个 Host client；
- 同一时间一个 active installation；
- 没有由 Agent2 签名、可供服务端验证的 workspace/user/agent 身份声明。

所以当前可证明单人 OAuth、组织绑定、撤销、重连和会计主流程，不能证明团队、多用户、多客户之间的生产隔离。

## 用户确认与材料来源边界

`xero_prepare_supplier_bill_draft` 返回的 `technicallyReady` 和 `readyForUserConfirmation` 只表示提案可供审阅；`requiresUserConfirmation=true` 和 `executionAllowed=false` 保证准备调用本身不授权写入。

当前 `CONFIRMED_FOR_DRAFT` 是 Agent 根据同一会话里的明确用户话术作出的声明，不是 Host 签名确认、电子签名或独立审批回执。

`source_ref`、Agent 声明的 hash 或服务端结构化提案指纹可以绑定后续流程，但都不能证明真实上传文件属于当前 workspace/user，会话中的文件也尚未获得 Host 签名来源收据。

## 已完成与仍未完成

已完成：

- 新域名、OAuth、Organisation 明确绑定；
- 普通会计话术的真实 Xero 读取；
- 4 Persona、5 类场景、11 个浏览器组合；
- prepare 阶段零写入、含糊确认零写入；
- 明确确认后的唯一 DRAFT、同 ID 回读和应用层幂等重放；
- 联系人 list/get 的真实 Agent2 4 调用闭环；
- AUTHORISE、Payment、Delete 等高风险请求拒绝。

仍未完成：

- 33 次 Remote Agents 重复稳定性批测；
- Host 签名材料来源收据；
- Host 签名用户确认与独立审批证据；
- 多用户、多客户隔离、并发限流和持续灾备验收；
- 隔离 PostgreSQL 发布库的本轮完整条件测试套件。

## 当前明确不支持

- Agent 自主 AUTHORISE、批准自己的草稿或付款；
- Credit Note 创建、分配、Void、删除；
- Payment 创建、分配、对账、冲销或删除；
- 银行连接、流水、对账和 Bank Transfer；
- Manual Journal、自动更正、删除或 Void 已入账对象；
- 创建或修改联系人、科目、税码；
- 原始 PDF 自动附加到 Xero Bill；
- 由 MCP 直接读取 Agent2 文件或验证 Host 签名来源；
- 工资、固定资产、库存、税务申报、月结和审计意见；
- 真实客户账套的无人监督自动记账。

## 当前适合的对外口径

> zCloak Xero MCP 已通过受控的 Agent2 单人 Personal POC：预配置个人测试身份可以连接所选 Xero Trial Organisation，读取并分析存量账务，结合材料准备供应商账单，并在明确确认和临时写闸内创建本轮唯一一张 `DRAFT`；系统提供审计、应用层幂等重放和同一 Xero ID 回读。联系人列表和精确读取已用真实 Agent2 会话验证。它尚未达到多用户生产隔离、独立审批证明或无人监督自动记账标准，Xero 始终是正式账本。

详细证据见 [Agent2 × Xero MCP Personal POC 验收记录](./AGENT2-XERO-PERSONAL-POC-ACCEPTANCE-2026-08-07.md)。
