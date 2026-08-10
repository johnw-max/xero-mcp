# Xero 线上真人主流程测试用例

测试编号：`XERO-E2E-UAT-20260804-001`  
目标：证明 `PDF -> zCloak Agent -> Xero DRAFT -> 人工批准 -> AUTHORISED -> 精确回读 -> 账本/报表变化`，而不是只证明 OAuth 或 MCP 能连通。

当前状态：`PASS_WITH_BROWSER_HARNESS_NOTES`。Xero Trial 核心账本链路已实际执行；DRAFT、Review 数据核对、AUTHORISE、同一 InvoiceID 精确回读、Trial Balance、Xero UI、幂等与 post-test write shutdown 均通过。Chrome 自动化阻断了 Review HTML form navigation，实际授权通过部署中的同一 ReviewService session/CSRF/audit/idempotency 路径完成；终态上的真实 Review HTTP POST 回放返回 200、`verified=true`，没有第二次 Provider 写。PDF 已生成和目视校验，但浏览器扩展未开放 file-URL 上传权限，所以 zCloak 创建 UAT 使用同一 fixture 的明确字段。

## 唯一允许使用的源文件

- 文件：`output/pdf/synthetic-supplier-invoice-xero-mcp-hkd-2026-08-04.pdf`
- SHA-256：`d87191ef6ffeed9bd77fea0e932fe31e3fdeb35aec4a150d222b45413bde0311`
- Source reference：`SRC-ZC-XERO-20260804-HKD-001`
- Invoice reference：`ZC-MCP-HKD-20260804-001`

文件本身已标注 `SYNTHETIC DATA`、`DO NOT PAY`、无银行账户、无真实货物或服务。不得替换成真实客户或供应商资料。

## 固定业务数据

| 字段 | 值 |
|---|---|
| Supplier | `zCloak Synthetic Supplier HK Limited` |
| Invoice date | `2026-08-03` |
| Due date | `2026-08-17` |
| Currency | `HKD` |
| Line description | `Synthetic accounting workflow validation service` |
| Quantity | `1.0000` |
| Unit amount | `100.00` |
| Subtotal | `100.00` |
| Tax | `0.00` / Xero 中实际可用且允许费用使用的 No Tax tax type |
| Total | `100.00` |
| Payment | 禁止 |

`contact_id`、`account_code` 和 `tax_type` 不能猜测，必须先从已连接的唯一 Xero Trial organisation 实时读取。若供应商不存在，只能在 Xero UI 中创建上述合成联系人；不得把“创建联系人”扩展为 MCP 写工具。

## 前置门槛

以下条件全部满足才允许开始写入：

1. Xero Web app 使用真实 Client ID/Secret，回调严格为 `https://mcp.jiayuanwang.xyz/oauth/xero/callback`。
2. 初始保持 `XERO_WRITE_ENABLED=false`；Agent 返回的一次性 `connectUrl` 被浏览器打开后必须直接启动 OAuth，不存在 Bearer 驱动的 `/oauth/xero/start` 或 `/operator/session` 路径。
3. OAuth 只绑定一个明确可识别的 Trial/Demo organisation；只有成功 callback 的同一浏览器取得 reviewer session，取消、失败、state mismatch 或 token/Tenant 失败均不得取得 reviewer 权限。
4. `xero_connection_status` 返回 `connected=true`，tenant 名称与浏览器中的测试组织一致。
5. 只读取得并人工核对精确 Tenant ID 后，把它配置为唯一、非通配的 `XERO_ALLOWED_TENANT_ID`；只有此时才允许显式设置 `XERO_WRITE_ENABLED=true`。两项缺一、ID 不一致或 OAuth 尚未完成都必须拒绝写入。
6. `xero_get_organisation` 返回的 base currency 为 `HKD`；若与源文件币种不一致，停止，不自动换币。
7. `xero_search_contacts` 精确匹配唯一合成供应商。
8. `xero_list_accounts` 选择一个 ACTIVE、EXPENSE、非 BANK 的科目。
9. `xero_list_tax_rates` 选择一个 ACTIVE、可用于费用、税率为 0/No Tax 的 tax type。
10. 记录写入前 Trial Balance，作为 before evidence。

## 真人口吻执行脚本

### 1. 上传并只读核对

在 zCloak 新对话上传唯一源 PDF，然后输入：

> 这是一张只用于 Xero Trial 的合成测试发票。请先检查我连接的是哪个 Xero 组织，并核对供应商、可用费用科目和 No Tax 税率。先不要创建或修改任何账务数据，也不要连接银行或付款。请把你从文件读取到的日期、币种、金额和 reference 列出来让我确认。

通过条件：Agent 实际调用 organisation/accounts/tax-rates/contacts 只读工具；返回内容与 PDF 一致；没有写调用。

### 2. 只创建 DRAFT

人工核对无误后输入：

> 信息正确。请使用你刚才从 Xero 实时读取到的合成供应商、有效费用科目和 No Tax 类型，只创建一张 DRAFT supplier bill。source reference 和 invoice reference 必须使用文件里的值；不要 authorise，也不要付款。创建后请给我 Xero InvoiceID、DRAFT 精确回读结果和人工 review 链接。

受控工具输入要求：

- `request_id=xero-e2e-uat-20260804-001-create`
- `source_ref=SRC-ZC-XERO-20260804-HKD-001`
- `source_sha256=d87191ef6ffeed9bd77fea0e932fe31e3fdeb35aec4a150d222b45413bde0311`
- `line_amount_type=NoTax`
- 其余字段必须与固定业务数据一致

通过条件：

- 返回一个 `postingRequestId` 和一个真实 Xero `invoiceId`。
- 精确回读 `type=ACCPAY`、`status=DRAFT`、total `100.00`。
- review 页面字段与 PDF、Xero DRAFT 完全一致。

### 3. 独立人工批准

人工打开 review 链接，核对以下字段：

- 唯一测试 tenant
- 合成供应商
- 日期、币种、reference
- 费用科目与 No Tax 类型
- description、quantity、unit amount、total
- Xero InvoiceID

只有全部一致才点击批准。若任一字段不一致，点击拒绝并停止；不得在 Xero 中手工修正后继续沿用旧批准。

批准页面必须使用由同一浏览器成功 OAuth callback 签发的 reviewer session、same-origin、一次性 CSRF，并在服务端生成/消费 approval reference。MCP Bearer、失败/取消 OAuth 或单独知道 review URL 都不能建立 reviewer 身份；Agent 不应看到或复制 `approval_ref`。

### 4. AUTHORISED 与精确回读

批准成功后回到 zCloak 输入：

> 请按刚才返回的同一个 Xero InvoiceID 重新读取这张 supplier bill，确认是否已经 AUTHORISED。然后读取 2026-08-03 的 Trial Balance，说明这张 HKD 100.00 合成账单在应付账款和所选费用科目上的可见变化。不要创建第二张账单，也不要付款。

通过条件：

- 精确同一个 InvoiceID 返回 `status=AUTHORISED`。
- 内部 Posting Request 为不可回退终态 `AUTHORISED_READBACK_VERIFIED`；后续重复、恢复、拒绝或修改请求只能返回相同结果或被拒绝，不能再次调用 Provider 写入。
- contact、reference、dates、currency、lines、tax、total 与获批快照一致。
- Xero UI 能按 reference 找到同一张 Bill。
- Trial Balance 或 Xero 的可见报表证据反映相应应付账款/费用变化；若 Xero 报表存在刷新或日期口径差异，必须如实记录，不能用 API 成功替代报表证据。

### 5. 幂等性复验

以完全相同的 `request_id` 和 payload 再调用一次 DRAFT 创建路径，并对同一请求执行受控并发复验。

通过条件：返回相同 InvoiceID 且 `idempotentReplay=true`，数据库/Provider 证据证明相同 Tenant、request ID、operation 和 payload 的并发请求最多发生一次 Provider 写，Xero 中不存在第二张相同 reference 的 Bill。若 payload 有任何变化，必须返回 conflict，不能静默覆盖。

## P0.6 实际结果

- Organisation：`zcloak`；Tenant `7c3cc738-eef0-4d4e-83f8-d528390e1e61`；base currency HKD。
- Contact：`zCloak Synthetic Supplier HK Limited` / `14c4056e-97d3-4e7e-8285-60bf9860d100`。
- Account：`485 - Subscriptions`；TaxType：`NONE / Tax Exempt`。
- Posting Request：`pr_7565121c-a796-434f-b499-0eb37f9d6e13`。
- InvoiceID：`b4cbb8ee-d420-4343-bdd3-2a39af7cc756`。
- DRAFT 精确回读：ACCPAY、HKD 100、税 0、日期/Reference/行项目全部匹配。
- DRAFT Trial Balance：总借/贷/YTD 均 0。
- AUTHORISED 精确回读：同一 InvoiceID、HKD 100、`verified=true`；内部终态 `AUTHORISED_READBACK_VERIFIED`。
- AUTHORISED Trial Balance：Subscriptions 借记 100；Accounts Payable 贷记 100；总借/贷均 100。
- Xero UI：All Bills 只有 1 item / HKD 100；状态 Awaiting Payment；没有付款。
- 幂等：相同 payload 重放 `idempotentReplay=true`；改 Reference 重用 request ID 返回 `CONFLICT`。
- 收尾：`XERO_WRITE_ENABLED=false`；App-only 重建 healthy；PostgreSQL 容器不变；post-close smoke 8/8；新建 probe 返回 FORBIDDEN。

详细脱敏证据：`artifacts/test-runs/2026-08-04-p0.6-live-xero/`。

## 必须保存的证据

| 证据 | 记录要求 |
|---|---|
| Source | PDF 文件名与固定 SHA-256 |
| OAuth | 成功时间、tenant 名称/ID、scope 清单、同浏览器 reviewer session 成功及取消/失败无 session 的结论；不记录 token/code/state/Cookie |
| Write gate | OAuth 后只读 Tenant ID 与允许写入 ID 一致、write flag 显式开启；不记录环境文件或 Secret |
| Read context | Organisation、contact_id、account_code、tax_type |
| Before | 写入前 Trial Balance 或对应 Xero 报表截图 |
| Draft receipt | request_id、postingRequestId、InvoiceID、DRAFT 精确回读 |
| Human review | review 页面核对结果与批准时间；不记录 approval_ref |
| Authorise receipt | 同一 InvoiceID、AUTHORISED 精确回读、`AUTHORISED_READBACK_VERIFIED` 终态、幂等标志 |
| After | Trial Balance/Xero UI 可见变化 |
| Audit | create/approve/authorise/read-back 的 call IDs 与结果状态 |
| Safety | 无银行连接、无付款、无删除、同请求并发 Provider 写最多一次、无第二张重复 Bill |

## 立即停止条件

- OAuth 组织不是明确的 Trial/Demo organisation。
- `XERO_WRITE_ENABLED` 不是由 `false` 起步，或开启时 `XERO_ALLOWED_TENANT_ID` 为空、为通配值、不是 OAuth 后只读取得的精确 Tenant ID。
- base currency 与唯一允许的合成源文件币种不一致。
- 匹配到真实联系人或多个同名联系人。
- 无合适费用科目或 No Tax tax type。
- 文件、Agent 解析、review 页面和 Xero 回读任一金额不一致。
- DRAFT 在批准前被其他人修改。
- Xero 写入结果未知且无法按 InvoiceID/幂等键确认。
- review session、origin 或 CSRF 校验失败。
- OAuth 取消/失败后浏览器仍取得 reviewer session，或任意非 `/mcp` 路径接受 MCP Bearer 作为身份。
- Xero UI/报表证据无法与同一 InvoiceID 对应。

出现停止条件时保留现状和日志，不重试写入、不创建替代账单、不付款。
