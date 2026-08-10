# Xero Accounting MCP Demo — Test Plan

> 历史基线说明：本文记录 2026-08-04 旧 P0.6、固定 8 工具和 Review/AUTHORISE 演示链路，不是 2026-08-05 OAuth Broker + 13 工具候选版的当前验收合同。当前版本及状态以 [Xero MCP 当前能力说明](./XERO-MCP-CURRENT-CAPABILITIES-2026-08-05.md) 为准；本轮线上验收只使用 Agent2，执行 [Agent2 × Xero 会计用户 UAT V1](./AGENT2-XERO-ACCOUNTANT-UAT-V1.md)。本文后续出现的 8 工具、Work/LibreChat 和 P0.6 状态均应按历史证据理解。

版本：v0.6  
状态：P0.6 单一 Xero Trial 组织的受控账本 E2E 已通过；最终写开关已恢复为 false。浏览器附件上传和纯业务话术仍有明确验收备注。  
测试对象：Remote MCP、Xero OAuth、Tenant 绑定、DRAFT Bill、Review Gate、AUTHORISE、精确回读、审计与 Hetzner 线上部署

## 1. 验收口径

本计划验证的不是“接口有响应”，而是下面这条受控业务链是否真实成立：

`真实用户提出需求 -> 成功 OAuth 后只读确认 Tenant -> 显式开启 exact-Tenant 写门 -> Agent 读取 Xero 当前会计上下文 -> 创建同一 Tenant 的 DRAFT Bill -> 未审批不能入账 -> 用户在 Review Page 核对并批准 -> 同一可信服务内部完成 AUTHORISE -> Agent/页面精确回读并进入不可回退终态 -> Xero UI/报表可见 -> 全链路可审计且同请求最多一次 Provider 写`

以下状态必须严格区分：

- **Connected**：OAuth 与 Tenant 连接成功，不代表能写入。
- **Write enabled**：只有 `XERO_WRITE_ENABLED=true` 且连接 Tenant 精确等于 `XERO_ALLOWED_TENANT_ID` 才可能写入；仍不代表某次业务动作获批。
- **Draft created**：Xero 可见 `ACCPAY + DRAFT`，不代表正式入账。
- **Authorised**：Provider 返回状态更新，不代表结果已经验证。
- **Verified**：按相同 Tenant 和精确 InvoiceID 回读，状态、金额、类型均一致，内部状态为不可回退的 `AUTHORISED_READBACK_VERIFIED`，并取得 UI/应付/报表证据。

禁止使用真实客户数据、真实银行连接、真实支付。线上测试只允许合成凭证和用户明确授权的 Xero Trial/Demo 测试组织。

## 2. 测试层次与环境

| 层次 | Provider | 目的 | 是否允许外部写入 |
|---|---|---|---|
| L0 静态/单元 | Fake/Mock | Schema、hash、状态机、权限、脱敏 | 否 |
| L1 本地集成 | Mock Xero HTTP server + PostgreSQL | OAuth、并发、超时、数据库约束 | 否 |
| L2 本地容器 | Host Nginx + Docker Compose | Nginx/loopback app/internal db 边界与 MCP transport | 否 |
| L3 Hetzner staging | Xero Trial/Demo 测试组织 | 真实 OAuth、DRAFT、AUTHORISE、回读 | 仅合成数据 |
| L4 zCloak/LibreChat UAT | Hetzner + Xero Trial/Demo | 真人用户主流程 | 仅一张受控合成 Bill |

### 2.1 最低测试数据

固定一张合成供应商发票，避免每轮改变验收口径：

- Reference：`ZC-XERO-DEMO-<run-id>`
- 描述：`Synthetic software subscription - no real service`
- 币种：使用目标 Xero 组织的本位币；不能硬编码 SGD
- 金额：从 fixture 读取，并由服务端重新计算
- Contact、Account、TaxType：必须先从当前 Xero Tenant 读取后填入，不得写死不存在的 ID
- `source_ref`：合成文件的内部引用
- `source_sha256`：合成文件实际 SHA-256

### 2.2 测试身份

- `actor_a` / `tenant_a`：正常演示用户与已连接 Xero 测试组织。
- `actor_b` / `tenant_b`：隔离测试身份；L0/L1 必须存在，L3 若没有第二个真实测试组织则使用 Mock，不得为了测试擅自连接第三方真实组织。
- `approver_a`：允许审批 `tenant_a` 的演示操作员。
- `attacker`：无 Bearer、错误 Bearer、尝试在非 `/mcp` 路径使用 Bearer、错误 Origin 或持有另一个 Tenant 对象 ID 的调用者。

## 3. 固定 MCP 工具契约

POC 对外工具清单必须与以下集合完全一致；排序不重要，集合必须一致：

1. `xero_connection_status`
2. `xero_get_organisation`
3. `xero_list_accounts`
4. `xero_list_tax_rates`
5. `xero_search_contacts`
6. `xero_get_supplier_bill`
7. `xero_create_draft_supplier_bill`
8. `xero_get_trial_balance`

`xero_authorise_supplier_bill` 不对 Agent 暴露；AUTHORISE 只能由已认证 Review Gate 的人工 POST 触发。`xero_get_aged_payables` 和 `xero_attach_source_document` 当前是架构中的条件性/可选能力，也未进入 P0.4 固定八工具发布契约。当前 Xero scopes 只申请 Trial Balance 报表权限，因此用 Trial Balance 或 Xero UI 完成正式变化验证。若实现团队决定加入任一可选工具，必须更新架构、scopes、expected-tools fixture、威胁模型和测试用例后重新评审。

必须断言以下工具不存在：

- Payment/Credit Note 写入或分配、Bank Transaction、Manual Journal、Delete、Void；
- Account/Tax Rate/Contact create；
- `create_anything`、`update_anything`、raw Xero proxy；
- 任意 URL fetch、shell、文件系统或数据库查询工具。

## 4. 自动化入口

仓库自带的独立黑盒脚本不依赖项目 npm package：

```bash
MCP_BASE_URL=https://xero-mcp-demo.example.com \
MCP_BEARER_TOKEN='<demo bearer>' \
MCP_ALLOWED_ORIGIN='https://work.zcloak.ai' \
node tests/smoke-mcp.mjs
```

脚本覆盖：未授权 401、错误 Origin 403、超大请求 413、initialize、notifications/initialized、ping、tools/list 与固定工具集合。运行线上脚本会产生请求，必须使用测试服务；脚本不会调用任何账务写工具。

日志脱敏检查：

```bash
node tests/assert-log-redaction.mjs artifacts/test-runs/<run-id>/service.log
```

脚本只作为最低黑盒门槛；OAuth、Provider 写入、并发与数据库状态必须由实现仓库的单元/集成测试补齐。

## 5. 测试用例

每个用例必须记录：测试版本/镜像摘要、环境、时间、执行者、输入 fixture、期望、实际、PASS/FAIL、日志或截图路径。任何 `SKIP` 都等同未满足发布门槛，除非该能力明确不在发布范围且工具未暴露。

### A. MCP transport 与公网边界

#### MCP-001 Initialize

- 优先级：P0
- 前置：合法 Bearer、合法 Origin、服务 ready。
- 步骤：POST JSON-RPC `initialize`，协议版本使用客户端支持版本；保存响应 `Mcp-Session-Id`；发送 `notifications/initialized`。
- 期望：HTTP 200/202 符合 Streamable HTTP；响应含 `serverInfo`、`capabilities.tools`；Session ID 不含可推断用户/Tenant 信息；通知不返回敏感内容。
- 证据：脱敏响应头、响应体和服务端同一 `call_id`。

#### MCP-002 Ping

- 优先级：P0
- 步骤：使用初始化 Session POST JSON-RPC `ping`。
- 期望：成功；不访问 Xero Provider；不产生账务审计记录。

#### MCP-003 Fixed tools/list

- 优先级：P0
- 步骤：调用 `tools/list`，收集全部分页（若实现分页）。
- 期望：工具名集合与第 3 节完全一致；每个 input schema 明确、`additionalProperties=false` 或等价严格拒绝；无危险工具。
- 失败条件：多一个或少一个工具、通用 Provider 代理、写工具名称/Schema 与评审版本不符。

#### EDGE-001 Missing/invalid Bearer

- 优先级：P0
- 步骤：分别无 Authorization、空 Bearer、错误 Bearer 请求 `/mcp`。
- 期望：401；可使用标准 `WWW-Authenticate`；响应和日志不回显 Token；Provider/数据库业务查询计数为零。

#### EDGE-002 Wrong Origin

- 优先级：P0
- 步骤：使用合法 Bearer，Origin 设为 `https://evil.invalid`。
- 期望：403；不进入 MCP tool handler；合法非浏览器客户端的 Origin 策略必须由配置和文档明确，不能用 `*`。

#### EDGE-003 Oversized body

- 优先级：P0
- 步骤：发送超过配置上限的 JSON body，至少验证 `limit + 1 byte` 与显著超大两种值。
- 期望：413；连接被有界处理；body 不写日志/临时文件；内存与进程保持健康。

#### EDGE-004 Content type and malformed JSON

- 优先级：P1
- 步骤：错误 Content-Type、无效 JSON、批量 JSON-RPC、未知 method、重复 JSON key。
- 期望：按 MCP/JSON-RPC 规范拒绝；不产生 Provider 调用；错误不泄漏 stack/secret。

#### EDGE-005 Rate/concurrency bounds

- 优先级：P1
- 步骤：在单 Bearer、单 IP 和多连接下超过速率/并发上限。
- 期望：受控 429/503；恢复后服务健康；不会绕过 idempotency 或使状态机卡在伪成功。

#### EDGE-006 Bearer is MCP-only

- 优先级：P0
- 步骤：对 `/connect/xero`、OAuth callback、Review GET/POST 及旧 `/operator/session`、`/oauth/xero/start` 路径分别携带合法 MCP Bearer。
- 期望：Bearer 只在 `/mcp` 被接受；它不能直接启动 OAuth、创建 reviewer session、查看 Review 或批准账单；旧 session/start 路径不暴露可用能力。

### B. OAuth、Tenant 与 Token 生命周期

#### OAUTH-001 Start creates bound one-time state

- 优先级：P0
- 步骤：同一 actor 从 `/mcp` 连续取得两个 connect ticket；分别在浏览器打开 `/connect/xero?ticket=...`。
- 期望：每个 ticket 均短时、一次性且哈希存储；消费后直接创建高熵、互不相同的 state 并重定向 Xero consent，不经过 `/oauth/xero/start`；state 绑定 actor、同一浏览器 OAuth cookie 与 redirect intent；scope 为评审后的最小集合；redirect URI 固定 HTTPS。

#### OAUTH-002 State validation and replay

- 优先级：P0
- 步骤：callback 分别使用缺失 state、随机 state、另一会话 state、过期 state、已成功消费 state。
- 期望：全部拒绝；授权 code 不被交换或记录；重放不能创建/覆盖 connection。

#### OAUTH-003 Callback errors and secret redaction

- 优先级：P0
- 步骤：模拟 Xero `error=access_denied`、无 code、Token endpoint 4xx/5xx、畸形 Token 响应。
- 期望：连接保持未授权/失败；同一浏览器不取得 reviewer session；code、client secret、access/refresh token 不出现在页面、日志或 tracing。取消、失败或部分完成不能留下可用于 Review 的 Cookie/数据库会话。

#### OAUTH-004 Exact Tenant binding

- 优先级：P0
- 步骤：Token 可见一个和多个 Xero connection；模拟连接顺序改变；用户选择 Tenant A。
- 期望：服务不盲选数组第一项；持久化精确 `xero_tenant_id`/名称/scopes；后续所有调用只使用 Tenant A。若产品只支持单连接，发现多个时必须显式阻断并提示选择。

#### OAUTH-005 Reviewer session only after successful callback

- 优先级：P0
- 步骤：分别执行成功 callback、另一浏览器 callback、取消、错误 state、Token 交换失败、Tenant 解析失败；检查 reviewer Cookie 和服务端 session。
- 期望：只有成功完成 state/code/token/Tenant 校验的原浏览器取得 `Secure`、`HttpOnly`、`SameSite=Lax` reviewer session；任何失败分支、不同浏览器或仅持 MCP Bearer 的请求都没有 reviewer 权限。

#### WRITE-GATE-001 Default-off exact-Tenant gate

- 优先级：P0
- 步骤：在 `XERO_WRITE_ENABLED` 缺失/false，以及 true 搭配缺失、空值、通配值、其他 Tenant ID、正确 Tenant ID 的组合下调用 create/authorise；同时验证只读工具。
- 期望：默认和所有不精确组合均在 Provider 写入前拒绝；只读仍可用于识别 Tenant。只有 OAuth 完成后只读取得的精确 Tenant ID 被独立配置，且开关显式为 true 时，写请求才继续进入其他审批/状态校验。

#### OAUTH-006 Scope verification

- 优先级：P0
- 步骤：分别使用完整最小 scope、缺失 invoices write、缺失 contacts/settings/reports scope 的 Token。
- 期望：连接状态清楚指出 capability；缺写 scope 时写工具不开放或调用前阻断；不得用 broad scope 静默替代未评审权限。

#### TOKEN-001 Expired access token refresh

- 优先级：P0
- 步骤：Access Token 过期后并发发起 10 个只读调用。
- 期望：每个 connection 只发生一次有效 refresh；其余请求等待/复用新 Token；最新 Token Set 原子保存；调用最终使用新 Access Token。

#### TOKEN-002 Refresh rotation race

- 优先级：P0
- 步骤：让旧刷新请求延迟返回、新刷新请求先返回，或模拟两个实例竞争。
- 期望：旧版本不能覆盖新 Token Set；`refresh_version` 单调增加；无 `invalid_grant` 风暴；Token 不出日志。

#### TOKEN-003 Refresh failure

- 优先级：P0
- 步骤：模拟 `invalid_grant`、网络超时和解密失败。
- 期望：Provider connection 进入可解释的 `TOKEN_REFRESH_FAILED`；相关 Posting Request 保持原状态或进入明确阻断状态；不进行写调用；用户收到重新授权提示；无自动降级到另一 Tenant/Token。

### C. Tenant isolation 与权限

#### TENANT-001 Cross-tenant read

- 优先级：P0
- 步骤：actor B 使用 Tenant A 的 InvoiceID、posting_request_id、connection_id 分别调用读取工具。
- 期望：404/403 等安全拒绝；在 Provider 调用前停止；响应不确认对象是否存在。

#### TENANT-002 Cross-tenant write/authorise

- 优先级：P0
- 步骤：actor B 组合 Tenant A 的 InvoiceID、actor B 的 approval_ref 或反向组合调用 create/authorise。
- 期望：拒绝；Provider 写调用计数为零；审计只记录最小隔离事件。

#### TENANT-003 Cache and connection mix-up

- 优先级：P0
- 步骤：A/B 并发读取 Accounts/Contacts；使用相同查询、相同 request_id、不同 Tenant。
- 期望：缓存键和唯一键包含 Tenant；A/B 结果不交叉；同 request_id 可在两个 Tenant 内独立存在但互不可见。

#### TENANT-004 Server-resolved tenant

- 优先级：P0
- 步骤：在工具参数增加伪造 `tenant_id`、`xero-tenant-id`、Provider URL/header 等未知字段。
- 期望：Schema 拒绝未知字段，或服务完全忽略且只使用认证上下文；不得允许调用者控制 Provider host/header。

### D. DRAFT、审批、Payload Hash 与 AUTHORISE

#### BILL-001 Validate real Xero context

- 优先级：P0
- 步骤：读取 Organisation、Accounts、Tax Rates、Contacts；分别提交不存在、停用、错误类型或另一个 Tenant 的 ID。
- 期望：合法值来自目标 Tenant 当前数据；非法值在创建前拒绝；Agent 自报名称不能替代精确 ID 校验。

#### BILL-002 Create exact DRAFT

- 优先级：P0
- 步骤：用固定 fixture 调 `xero_create_draft_supplier_bill`。
- 期望：只创建 `ACCPAY + DRAFT`；返回 `posting_request_id`、精确 InvoiceID、Review URL 和 payload hash；按 InvoiceID 回读的 Tenant、状态、金额、币种、行项目一致；不得返回 `verified_posted=true`。

#### APPROVAL-001 Authorise without approval is denied

- 优先级：P0
- 步骤：读取 MCP `tools/list`，尝试按旧工具名调用 `xero_authorise_supplier_bill`；再以自然语言声称用户已同意。
- 期望：工具不存在；Xero update 调用计数为零；Bill 仍为 DRAFT。服务内部遗留的直接授权方法仍需单元测试证明伪造批准无法绕过状态机，但它不属于公开 MCP 契约。

Review Gate 是唯一真人授权入口，不得形成 Agent 侧第二条授权路径。

#### APPROVAL-002 Review authentication and CSRF

- 优先级：P0
- 步骤：未成功完成 OAuth 的浏览器、OAuth 取消/失败浏览器、仅持 MCP Bearer 的调用者、另一 actor、无/错误 CSRF、跨站表单、过期 session、直接猜 Review URL 分别访问/提交。
- 期望：不可查看完整账务内容或批准；reviewer session 只能来自同一浏览器成功 OAuth callback；成功页面包含 CSP `frame-ancestors 'none'` 或等价保护；URL 和 MCP Bearer 都不是审批能力。

#### HASH-001 Deterministic payload hash

- 优先级：P0
- 步骤：对同一业务 Payload 改变 JSON key 顺序、无意义空白、等价金额表示；在支持的边界内重复计算。
- 期望：语义等价表示得到相同 hash；不同金额、税码、Account、Contact、日期、币种、行顺序或 InvoiceID 得到不同 hash；金额使用 decimal/minor-unit 规则，不依赖二进制浮点。

#### HASH-002 Payload mutation invalidates approval

- 优先级：P0
- 步骤：批准后分别改变金额、科目、税码、Contact、日期、Reference、Tenant、InvoiceID；复用原 approval_ref/hash。
- 期望：全部在 Xero update 前拒绝；Posting Request 回到/保持需重新审批状态；旧 approval 不可再次使用。

#### APPROVAL-003 Expiry, replay and concurrency

- 优先级：P0
- 步骤：使用过期 approval；成功消费后重放；并发 10 次消费同一 approval。
- 期望：最多一个状态迁移和一个 Xero Authorise 调用；其余返回已消费/一致结果，不得重复 Provider write。

#### APPROVAL-004 Review failure recovery

- 优先级：P0
- 步骤：分别在批准前回读失败、原子 claim 提交后响应丢失、Authorise 结果不确定、终态响应丢失时，让同一已认证操作员重新打开 Review Page，并用页面新签发的 CSRF 再次点击；另做并发双击。
- 期望：批准前失败保持 `APPROVAL_PENDING` 且旧 CSRF 未消费；后续点击使用稳定的服务端 request ID 和已持久化 approval hash。`AUTHORISING`/`WRITE_RESULT_UNKNOWN` 只做精确回读，不再次写 Provider；终态重放只读本地持久化结果，不调用 Xero read/write；并发最多一个 Provider write。Agent/MCP Bearer 不能调用内部 Review 恢复入口。

#### BILL-003 Successful DRAFT to AUTHORISED

- 优先级：P0
- 步骤：审批页核对并提交 Approve；服务端在同一受信事务流中创建并消费内部批准证据、调用 Authorise、按相同 InvoiceID 精确回读；随后 Agent 或结果页再次读取该 Bill。
- 期望：浏览器、URL、页面源码和 Agent 响应均不包含 `approval_ref`；同一 Tenant、同一 InvoiceID 从 DRAFT 变为 AUTHORISED；类型仍为 ACCPAY；金额/币种/行项目与批准版本一致；只有回读一致时 `verified=true`，内部状态进入不可回退的 `AUTHORISED_READBACK_VERIFIED`；批准记录标记已消费。

#### BILL-004 Report/UI evidence

- 优先级：P0（L3/L4）
- 步骤：记录 Authorise 前后 Aged Payables、Trial Balance 或 Xero UI；等待合理的 Provider 可见性窗口后重试读取。
- 期望：至少一个 Xero UI/应付/报表视图可见该 Bill 对应变化；若报表权限/刷新阻止验证，状态为 BLOCKED，不得只用 API 2xx 代替。

### E. 幂等、失败恢复与状态机

#### IDEMP-001 Sequential duplicate create

- 优先级：P0
- 步骤：相同 Tenant、request_id、operation、相同 payload 连续提交 3 次。
- 期望：一个 Posting Request、一个 Xero create、一个 InvoiceID；后续返回同一结果或进行安全回读。

#### IDEMP-002 Concurrent duplicate create

- 优先级：P0
- 步骤：并发 20 次相同 create，并在多个应用实例上重复。
- 期望：数据库唯一约束和原子 claim 保证相同 Tenant、request ID、operation 和 payload 最多一次 Provider create；其他并发调用者等待、resume 或返回同一持久化结果；无重复 Bill；没有 500/死锁造成盲目客户端重试。

#### IDEMP-003 Same request ID with different payload

- 优先级：P0
- 步骤：使用已消费 request_id 提交不同金额/Contact/Reference。
- 期望：409/明确冲突；不得返回旧 Bill 假装新请求成功；不得创建第二张。

#### UNKNOWN-001 Provider committed, response lost

- 优先级：P0
- 前置：Mock Provider fault injection 在 Xero 已创建 Bill 后丢弃响应。
- 步骤：调用 create，触发超时，然后重复原请求。
- 期望：状态进入 `WRITE_RESULT_UNKNOWN`；不立即第二次 create；写工具返回 pending/unknown；恢复任务精确查找并绑定唯一 InvoiceID 后才进入 `XERO_DRAFT_CREATED`。

#### UNKNOWN-002 Unknown result cannot be reconciled

- 优先级：P0
- 步骤：模拟无 InvoiceID、Provider 查询持续失败或找到多条候选。
- 期望：保持 `WRITE_RESULT_UNKNOWN`/人工介入；不得猜测第一条记录、不得 Authorise、不得返回 verified。

#### UNKNOWN-003 Authorise response lost

- 优先级：P0
- 步骤：Xero 已更新 AUTHORISED 后丢弃响应。
- 期望：不重复状态更新；按精确 InvoiceID 回读，确认状态与批准 hash 后恢复为 `AUTHORISED_READBACK_VERIFIED`；若不一致则 `READBACK_MISMATCH`。

#### UNKNOWN-004 Claim committed before Provider call, then process dies

- 优先级：P0
- 步骤：在 Review 原子 claim 已提交、但尚未发出 Xero Authorise HTTP 请求的窗口终止进程；重启后用新 CSRF 重试。
- 期望：为保证 at-most-once，恢复路径只做精确回读。若 Xero 仍为同一 DRAFT，则保持 `WRITE_RESULT_UNKNOWN` 并要求人工核对，不自动补写；只有同一 InvoiceID、同一批准 payload 的 AUTHORISED 回读才能完成终态。此窗口是当前设计明确保留的安全优先取舍。

#### STATE-002 Reverse interleaving cannot pollute authorise evidence

- 优先级：P0
- 步骤：让 Posting 分别进入 `APPROVED`、`AUTHORISING` 和带 authorise request 的 `WRITE_RESULT_UNKNOWN`，随后让迟到的 draft-error/recovery handler 尝试写入 `BLOCKED_VALIDATION`/`READBACK_MISMATCH`、错误 InvoiceID 或 Draft recovery，再尝试用错误 InvoiceID 完成 Authorise。
- 期望：Draft failure CAS 只允许从 `VALIDATED`，或不带 authorise request 的 Draft `WRITE_RESULT_UNKNOWN` 进入两个受控失败态；其他迟到写均返回冲突，终态保持 no-op。Authorise completion 对错误 InvoiceID 返回 `READBACK_MISMATCH`；原 InvoiceID、authorise request、receipt、readback 和状态保持一致。服务记录 CAS 冲突但仍返回最初的 Draft readback 错误，不能用状态写入冲突覆盖原错误。

#### STATE-001 Illegal state transitions

- 优先级：P0
- 步骤：尝试 RECEIVED 直接 AUTHORISED、REJECTED 后 Authorise、UNKNOWN 后 Authorise、已消费 approval 再批准；对 `AUTHORISED_READBACK_VERIFIED` 尝试回退、重建、修改、拒绝、重新批准、恢复或再次 Provider 写。
- 期望：全部拒绝；`AUTHORISED_READBACK_VERIFIED` 是不可回退终态，重复同请求只能返回已持久化结果且 Provider 写计数不增加；状态机只有设计允许的边；审计记录原状态、尝试动作和拒绝类别。

### F. 日志、Secret 与运行安全

#### AUDIT-001 Success audit persistence failure

- 优先级：P0
- 步骤：先验证 audit intent 写入失败时业务 action 不执行；再让 intent 成功、业务动作成功并持久化终态，但 terminal audit 更新失败；最后重试同一 Review 操作。
- 期望：第一种故障返回 `CONFIGURATION_ERROR` 且 Provider 调用计数为零。第二种故障同样返回 `CONFIGURATION_ERROR`，不得追加伪造的 FAILED audit，账单终态不回退，且首次调用的 call ID、时间、actor、tool、request hash 仍存在；PG 响应丢失时它可能为 `IN_PROGRESS` 或已提交 terminal，必须核对，不能假定失败。重试返回同一持久化终态，不触发 Xero read/write，并为重放调用形成独立的 SUCCEEDED audit。若 action 自身先失败且 audit completion 也不确定，响应保留原 `WRITE_RESULT_UNKNOWN`/Provider error，而不是被 `CONFIGURATION_ERROR` 遮蔽。

#### AUDIT-002 Durable audit transition constraints

- 优先级：P0
- 步骤：在隔离 PostgreSQL 17 数据库运行 migration 004 与 `verify:postgres:audit-continuity`；尝试创建带 finished time 的 `IN_PROGRESS`、缺少 finished time 的终态，以及重复完成同一 call ID。
- 期望：合法 intent 先持久化，再精确一次更新为终态；三种非法情况全部拒绝；验证输出不含任何凭证或业务 payload。

#### LOG-001 Sensitive data redaction

- 优先级：P0
- 步骤：在成功和各类错误路径注入带标记的 Client Secret、Access Token、Refresh Token、MCP Bearer、OAuth code、Cookie；收集 app/nginx/db migration/tracing 日志。
- 期望：标记原值均不存在；只允许不可逆短哈希或固定 `[REDACTED]`；异常 stack 不含请求 Header/Token Set。

#### LOG-002 Accounting data minimization

- 优先级：P1
- 步骤：提交带合成供应商名称、描述和 source_ref 的请求，检查日志/metrics/health。
- 期望：业务日志只含 actor/tenant/tool/request hash/provider request ID/record ID/error class/时间；不记录完整凭证、完整请求体或行描述。

#### HEALTH-001 Health/readiness disclosure

- 优先级：P0
- 步骤：未认证访问 `/healthz`、`/readyz`；分别让 db/provider/config 不可用。
- 期望：只返回状态、版本、工具清单 hash；无 Tenant、scope、Token、连接数或账务内容；ready 在关键依赖不可用时失败但 health 可区分进程存活。
- P0.5 额外断言：缺少任一 001-004 migration 记录、002/004 索引、003 short-code 列或 004 audit shape constraint 时 `/readyz` 必须为 503。

#### DEPLOY-001 Container and network controls

- 验证两种 Nginx 拓扑都显式代理 `/connect/xero` 与 `/oauth/xero/callback`，且不暴露可用的 `/operator/session` 或 `/oauth/xero/start`；connect 访问/错误日志不得包含一次性 `ticket` 查询值。

- 优先级：P0（Hetzner 发布前）
- 步骤：检查容器用户、rootfs、capabilities、no-new-privileges、端口、数据库监听、Secret 权限、镜像/依赖锁定。
- 期望：应用 non-root；rootfs 只读；drop capabilities；数据库不对公网；只开放 443 和受限 SSH；Secret 不进镜像/git；部署版本可追溯到 commit/image digest。

### G. 真实用户主流程与线上验收

#### UAT-001 Xero onboarding and connection

- 优先级：P0
- 角色：非技术演示用户。
- 步骤：保持写开关关闭，完成必要的 Xero Trial/Demo 组织 onboarding；跳过银行连接和非必要设置；从 zCloak 的“连接 Xero”入口用一次性 ticket 直接进入官方授权并明确选择测试组织。成功后先只读取得 Tenant ID，独立核对后才配置精确 allowlist 并开启写入。
- 期望：用户能看懂将连接哪个组织和申请哪些能力；只有成功 callback 的同一浏览器取得 reviewer session；取消/失败无 reviewer；返回 zCloak 后显示组织名称与连接状态但不显示 Token；写开关在 Tenant 核对前保持关闭。

#### UAT-002 Natural-language supplier bill journey

- 优先级：P0
- 用户表达示例：“这是一张测试用的软件订阅供应商发票。请帮我登记到 Xero，但正式入账前先给我确认。”
- 步骤：用户在 zCloak/LibreChat 发起请求；Agent 读取真实 Accounts/Tax/Contacts；解释选择；创建 DRAFT；给用户 Review 入口；用户在页面批准；页面背后的同一可信服务完成 Authorise 与首次精确回读；Agent/页面再展示精确结果。
- 期望：对话使用用户语言，清楚区分待审、DRAFT、已批准、已验证；不会要求用户提供 Tenant ID、Account UUID、Token、`approval_ref` 或其他技术参数；不会在未审批时正式入账。

P0.6 现场结果：Agent 在 zCloak 实际调用 5 个工具并创建唯一 DRAFT，随后用 2 个只读工具完成 AUTHORISED 与 Trial Balance 回读。由于 Chrome 扩展没有开放 file-URL 上传权限，本轮创建提示显式携带了受控 fixture 的 ContactID、source hash、request ID 和科目/税码；因此“核心账本链路”通过，但“普通用户完全不见技术字段”仍需在附件上传与 Agent 内部 source registration 完成后复测。

#### UAT-003 Xero-visible proof

- 优先级：P0
- 步骤：用户从结果链接进入 Xero，核对同一 Reference/InvoiceID、供应商、金额、状态；再查看 Aged Payables/Trial Balance 中至少一个证据。
- 期望：状态为 AUTHORISED，金额与批准页面一致，没有第二张重复 Bill；zCloak 给出精确记录链接和简明结果，不把日志或 API receipt 当成用户证据。

#### UAT-004 User correction before approval

- 优先级：P1
- 步骤：用户在审批前指出科目或税码不对并要求修改。
- 期望：旧 payload hash/approval 失效；修改后重新展示；用户再次批准前不能 Authorise。

## 6. 线上证据包

每次候选发布建立 `artifacts/test-runs/<UTC-run-id>/`，至少保存以下脱敏证据：

1. `run-manifest.json`：commit、image digest、域名、环境、时间、执行者、测试数据标识。
2. `mcp-smoke.json`：initialize/ping/tools 结果、401/403/413 结果和固定工具集合 hash。
3. `oauth-receipt.json`：actor、授权时间、Tenant ID/Name、granted scopes、connection status；不含 code/token/secret。
4. `draft-readback.json`：posting_request_id、InvoiceID、ACCPAY/DRAFT、金额摘要、request/idempotency hash。
5. `approval-receipt.json`：approver、时间、approved payload hash、服务端内部一次性 approval 标识的不可逆摘要；不得保存或展示原始 `approval_ref`。
6. `authorised-readback.json`：同一 InvoiceID、AUTHORISED、金额/Tenant 一致、`verified=true`，内部状态为不可回退的 `AUTHORISED_READBACK_VERIFIED`。
7. `report-or-ui-proof.*`：Aged Payables、Trial Balance 或 Xero UI 证据；只含合成数据。
8. `idempotency-proof.json`：重复请求次数、Provider 写调用次数、唯一 InvoiceID。
9. `negative-tests.json`：跨租户、审批绕过、payload mutation、unknown result 的结果。
10. `redaction-report.json`：扫描文件、敏感模式、零命中结论；原始 Secret 不写入报告。

不得把 `.env`、Cookie、Authorization Header、OAuth callback URL 全文、Token Set、数据库 dump 或真实凭证放入证据包。

## 7. 发布门槛

### Gate 0 — 安全设计

- `docs/THREAT-MODEL.md` 与实际工具、OAuth、部署拓扑一致。
- 所有 Required invariants 有对应测试；没有 Critical/High 未关闭项。
- `XERO_WRITE_ENABLED` 默认必须为 `false`；OAuth 后先只读取得 Tenant，只有显式配置精确、非通配的 `XERO_ALLOWED_TENANT_ID` 才能把开关设为 true。

### Gate 1 — 本地自动化

- MCP-001 至 MCP-003、EDGE-001 至 EDGE-003 及 EDGE-006 全部 PASS。
- OAuth state/Tenant/reviewer-session/Token rotation、default-off exact-Tenant write gate、双租户、hash、审批、不可回退终态、同请求并发最多一次 Provider 写、unknown outcome 的单元/集成测试全部 PASS。
- 日志脱敏测试 PASS；测试覆盖错误路径，不只覆盖成功路径。

### Gate 2 — 容器与 Hetzner

- Docker/Nginx/PostgreSQL 安全控制通过 DEPLOY-001。
- 公网黑盒 401/403/413 和固定工具清单 PASS。
- TLS、域名、ready/health、版本和镜像摘要有证据。

### Gate 3 — 真实 Xero Trial/Demo

- OAuth 精确绑定用户授权的唯一测试 Tenant。
- 成功 callback 只给同一浏览器签发 reviewer session，取消/失败分支不签发；Bearer 只对 `/mcp` 有效。
- OAuth 后只读取得并独立核对精确 Tenant ID；write flag 与 exact-Tenant allowlist 两道门有配置和负向证据。
- DRAFT 创建、未审批拒绝、批准后同 InvoiceID AUTHORISED、`AUTHORISED_READBACK_VERIFIED` 不可回退、同请求并发最多一次 Provider 写、幂等和 UI/报表证据全部 PASS。
- 任何 `WRITE_RESULT_UNKNOWN` 均已完成恢复或人工确认；不存在待解释的外部写入。

### Gate 4 — zCloak/LibreChat 真人流程

- UAT-001 至 UAT-003 全部 PASS。
- Agent 不暴露技术参数，不绕过 Review Gate，不把 DRAFT/HTTP 成功表述为正式入账。
- 线上证据包完整，且已做 Secret/个人数据检查。

只有 Gate 0–4 全部通过，才可以对外表述：

> 已在指定 Xero Trial/Demo 测试组织中，通过 zCloak Agent 与远程 MCP 跑通一张合成供应商账单的 DRAFT、人工批准、AUTHORISED、精确回读和 Xero 可见验证。

不得扩展表述为生产可用、真实客户账套已验证、自动记账、支付、月结或报税。

## 8. 当前执行状态

| 范围 | 状态 | 说明 |
|---|---|---|
| 测试规格 | READY | 本文已定义 |
| 独立 MCP 黑盒脚本 | PASS | 关闭写入并完成 App-only 重建后，公网 401/403/413、initialize、initialized、ping、精确八工具 8/8 PASS。 |
| 日志脱敏与证据扫描 | PASS | P0.6 App/Nginx 全量扫描的 Bearer、Token、Cookie、JWT-like、ticket、OAuth code/state query 命中均为 0；证据包不含环境文件、Cookie、Token 或 callback query。 |
| 实现单元/集成测试 | LOCAL + PG17 PASS | TypeScript/Build、14 个文件 121 项自动化测试通过；PG17 audit continuity 6 项、10,000-ticket cleanup、authorise monotonicity 14 项全部 PASS；三个隔离库均删除且正式库未用于 verifier。 |
| Hetzner 公网边界 | P0.6 LIVE-VERIFIED | health/ready、401/403/413、work.zcloak.ai Origin MCP 8/8、精确八工具、App-only 重建、PostgreSQL 不变、日志脱敏均通过。 |
| 真实 Xero OAuth | P0.6 LIVE-VERIFIED | Web app、精确 callback、最小 scopes、同浏览器成功 callback、唯一 organisation `zcloak`、ACTIVE connection、加密 token 持久化均有现场证据。 |
| exact-Tenant 写门 | P0.6 LIVE-VERIFIED | false/空门、wrong-tenant、exact-tenant true 三阶段验证通过；E2E 后恢复 false，post-close create probe 在 Provider 前返回 FORBIDDEN。 |
| Xero Trial/Demo 写入 | P0.6 LIVE-VERIFIED | 唯一 Posting/Invoice 完成 `DRAFT -> AUTHORISED -> AUTHORISED_READBACK_VERIFIED`；同一 InvoiceID 精确回读；没有付款或第二张 Bill。 |
| Trial Balance / Xero UI | P0.6 LIVE-VERIFIED | DRAFT 时 0；AUTHORISE 后借记 Subscriptions 100、贷记 Accounts Payable 100；Xero All Bills 仅 1 item / HKD 100，状态 Awaiting Payment。 |
| zCloak/LibreChat 写入 UAT | CONTROLLED PASS | Agent 实际创建 DRAFT 并返回 Review URL；最终只读提示实际调用 `xero_get_supplier_bill` 与 `xero_get_trial_balance`。创建提示仍含 fixture 技术字段，浏览器 PDF 上传待补。 |
| Review 浏览器路径 | PASS WITH HARNESS NOTE | Review GET 和逐字段核对通过；Chrome 自动化阻断 HTML form navigation。实际写入走同一 ReviewService session/CSRF/audit/idempotency 路径；真实 Review HTTP POST 在终态回放返回 200/verified=true、无第二次 Provider 写。 |
| 线上证据包 | READY | `artifacts/test-runs/2026-08-04-p0.6-live-xero/` 包含 OAuth、DRAFT、Review、AUTHORISED、Trial Balance/UI、幂等、负向、smoke 与脱敏证据。 |
