# Xero Accounting MCP Demo — Threat Model

状态：设计与实现安全基线；本地合同及 Hetzner/zCloak 只读边界已验证，真实 Xero OAuth/写入仍未验证  
适用范围：`xero-accounting-mcp-demo-2026-08-03/` 的远程 MCP、Xero OAuth Broker、Review Gate、Provider Adapter、数据库与 Hetzner 部署面  
数据边界：仅允许合成数据和 Xero Demo Company；不得接入真实客户账套或真实凭证

## Overview

本项目不是账本或会计数据库。它是部署在 Hetzner VPS 上的受控远程 MCP，把 zCloak/LibreChat Agent 的业务判断连接到 Xero Demo Company。Xero 继续作为正式测试账本；本服务只保存连接、Posting Request、审批、幂等状态和审计证据。

首个受保护的业务动作是：创建 `ACCPAY + DRAFT` 供应商账单，在服务端验证一次性人工审批后，将同一 `InvoiceID` 更新为 `AUTHORISED`，再精确回读并验证应付账款或报表变化。

最重要的资产与权限如下：

| 资产或权限 | 失守后影响 | 保护要求 |
|---|---|---|
| Xero Refresh/Access Token | 可读取或修改授权账套 | 加密保存、日志禁止出现、租户绑定、串行轮换 |
| Xero Tenant 绑定 | 决定写入哪一个组织 | 每次调用服务端解析，不信任 Agent 传入值 |
| MCP 入站 Bearer | 允许调用 Demo MCP 工具 | 高熵、可撤销、只接受于 `/mcp`、不得复用为浏览器/OAuth/reviewer 身份或 Xero Token |
| Posting Request 与 Payload Hash | 定义被批准的账务内容 | 规范化哈希、不可静默修改、变更后重新审批 |
| Review 原子批准与 `approval_ref_hash` | 唯一允许正式入账的授权证据 | reviewer session + 绑定 CSRF 在事务内消费；只保存不可逆 hash；原始 ref 不持久化、不进入 URL、浏览器响应或 Agent |
| Idempotency Key 与写入状态 | 防止重复 Bill 或重复批准 | 数据库唯一约束、稳定重试键、未知结果先回读 |
| 审计记录与回读证据 | 证明发生了什么 | 追加式语义、租户隔离、内容最小化、敏感值脱敏 |
| Hetzner、数据库和部署密钥 | 控制完整服务 | 最小端口、non-root、Secrets 与数据库分离、定期轮换 |

安全目标按优先级排序：

1. 未经可验证人工批准，任何调用者都不能把 DRAFT 变为 AUTHORISED。
2. 一个租户、用户或连接的调用绝不能读取或写入另一个 Xero Tenant。
3. OAuth Token、Client Secret、MCP Bearer 和审批能力不能被泄漏、伪造或重放。
4. 超时、重试、并发和 Token 轮换不能造成重复写入或错误租户写入。
5. Agent 输出、MCP 参数、OAuth 回调参数和 Xero 返回数据都按不可信输入处理。
6. 只有精确回读验证过的结果才能被描述为成功；连接成功、HTTP 2xx 或写请求返回不等于正式入账成功。

## Threat Model, Trust Boundaries, and Assumptions

### Actors

- **真实用户/演示操作员**：连接自己的 Xero Demo Company，核对并批准 Posting Request。
- **zCloak/LibreChat Agent**：读取会计上下文、提出账单候选并调用 MCP；不是可信审批者。
- **Remote Accounting MCP**：认证调用者、执行策略、维护状态机并形成审计证据。
- **Xero OAuth 与 Accounting API**：外部身份与正式测试账本系统。
- **Hetzner/部署操作员**：有基础设施管理权，属于高权限受信角色。
- **外部攻击者**：可从公网构造 HTTP、OAuth callback、MCP JSON-RPC、Origin/Host 和 Review URL 请求。
- **被盗或恶意 Agent 会话**：可能持有 Demo MCP Bearer，并提交任意工具参数或重放旧请求。

### Trust boundaries

1. **浏览器/Agent → Hetzner HTTPS Edge**：公网边界。请求方法、Header、Origin、Host、Bearer、JSON-RPC body 均不可信。
2. **Edge → `accounting-mcp`**：容器边界。只有反向代理应可访问应用端口；应用仍需独立认证和输入验证，不能只相信 Nginx。
3. **MCP Router → Policy/Approval Gate**：权限边界。工具名存在不代表调用获准；每次高风险操作都要重新校验租户、状态和审批。
4. **应用 → PostgreSQL**：持久化边界。查询参数、唯一约束、事务和租户过滤决定隔离与幂等是否成立。
5. **应用 → Xero OAuth/API**：第三方边界。Token Set、Tenant ID、响应对象、超时与重试语义需要独立验证。
6. **浏览器 → Review Gate**：人类授权边界。Review URL 本身不能成为 Bearer capability；审批必须认证操作者并防 CSRF/重放。
7. **CI/开发环境 → Hetzner 运行环境**：供应链与部署边界。开发依赖、镜像、环境变量和迁移拥有改变运行时安全属性的能力。

### Input ownership

**攻击者或不可信调用者可控：**

- MCP JSON-RPC `method`、工具名、参数、`request_id`、`source_ref`、金额、日期、Contact/Account/Tax ID；
- HTTP Host、Origin、Content-Type、Accept、body 长度、并发、断连与重试时机；
- OAuth callback 中的 `code`、`state`、`error` 和重复 callback；
- Review URL 参数、表单字段、Cookie、CSRF 请求和重复提交；
- Xero 中可被授权用户修改的 Contact、Account、Tax Rate、Invoice 和 Tenant 数据。

**操作员可控：**

- 选择哪个 Xero Tenant、是否批准、Demo Company 的测试配置和合成数据；
- Hetzner 域名、TLS、Secrets、数据库备份和部署窗口。

**开发者可控：**

- 固定工具清单、OAuth scopes、Provider 映射、Payload 规范化规则、迁移、日志字段和镜像依赖。

### Required invariants

下列约束任一无法由测试证明时，不得发布写入能力：

- 正常用户路径由 Review Page 的受认证 POST 触发同一服务内部的 Authorise；Review 路径只持久化不可逆 `approval_ref_hash`，原始 `approval_ref` 不持久化、不能返回浏览器或 Agent。MCP 不暴露 `xero_authorise_supplier_bill`，Agent 的自然语言声明永远无效。
- MCP Bearer 只在 `/mcp` 生效。连接票据消费后必须直接启动 OAuth；不得存在 Bearer 换 reviewer session 或 Bearer 驱动的浏览器 OAuth start。只有 state、code、Token 和 Tenant 全部验证成功的同一浏览器 callback 才能取得 reviewer session，失败、取消或部分完成均不得授予 Review 权限。
- 批准必须绑定 `actor_id + xero_tenant_id + posting_request_id + invoice_id + approved_payload_hash`；当前 Posting Request 不存 `connection_id`，active connection 由 actor 解析并在写入前精确核对其 Tenant。
- `approved_payload_hash` 对应 Posting 中持久化的确定性 `provider_payload_hash`；金额不得经过不稳定的浮点格式化。
- 任意账单字段、Tenant、InvoiceID 或批准内容改变后，旧批准立即失效。
- Authorise 前后均按精确 `InvoiceID` 回读，并验证 `ACCPAY`、Tenant、状态和金额。
- 数据库对 `tenant_id + request_id + operation` 建立唯一约束；并发相同请求只能产生一个 Provider 写入。
- `AUTHORISED_READBACK_VERIFIED` 是不可回退终态；任何重试、恢复、拒绝、修改、重新审批或其他状态迁移都不能离开该状态，也不能再次触发 Provider 写入。
- Provider 超时或连接中断时进入 `WRITE_RESULT_UNKNOWN`；在恢复回读前不得盲目重试，也不得继续批准步骤。
- OAuth `state` 必须高熵、单次、短时有效并绑定发起会话；callback 不接受缺失、错误或重放 state。
- Xero Token 刷新必须按连接串行化，并原子保存最新 Token Set；旧 Refresh Token 不可覆盖新 Token。
- Tenant 必须从已认证 actor 的 active connection 解析；不得信任工具参数或 callback 中自报 Tenant。
- `XERO_WRITE_ENABLED` 必须默认 `false`。任何写入还必须要求解析出的 Tenant 精确等于非空、非通配的 `XERO_ALLOWED_TENANT_ID`；该值只能在 OAuth 成功后通过只读调用取得并由操作员独立核对后配置。
- Provider 业务读取必须由已认证 actor 的 active connection 解析 Tenant。Posting 状态读取/迁移可使用全局唯一 `posting_request_id` 定位，但必须在服务层和事务行锁内再次校验 actor、Tenant、InvoiceID 与 Payload binding；以 Tenant 为范围的查询和缓存键必须包含 Tenant。
- 对外 MCP 工具名必须与固定 allowlist 完全一致，不得暴露通用代理、Payment/Credit Note 写入或分配、Bank Transaction、Manual Journal、Delete/Void 或任意 URL fetch。
- 日志、错误、health/readiness 和 MCP 响应不得出现 Token、Secret、Bearer、Cookie、授权 code 或完整凭证内容。
- 未完成精确回读时只能返回 pending/unknown/mismatch，不能返回 `verified=true`。

### Assumptions and limits

- Demo 使用单一操作员和单一 Xero Demo Company，但实现仍要按多租户隔离编写并通过双租户模拟测试。
- Demo MCP Bearer 只适用于封闭测试；它不是生产多用户身份方案。若平台不能安全携带 Bearer，应先实现标准 MCP OAuth/OIDC，不能把 Token 放进 URL 或工具参数。
- Xero、Hetzner 平台本身和 TLS 根信任不在本仓库控制范围内；本项目仍必须安全处理它们的错误、超时和不一致响应。
- 恶意 root/部署管理员可以窃取进程内 Token，属于基础设施治理风险；不能用应用层加密声称完全防御 root。
- 本阶段不处理真实客户数据、支付、银行连接、Payroll、Manual Journal、Delete/Void、自动建科目/税码/供应商。

## Attack Surface, Mitigations, and Attacker Stories

### Remote MCP and HTTP edge

主要风险包括 Bearer 猜测或泄漏、工具枚举漂移、JSON-RPC 参数注入、请求体耗尽、连接耗尽、Host header poisoning、跨站浏览器调用和错误信息泄漏。

设计控制：TLS；高熵且仅限 `/mcp` 的 Bearer；应用与 Nginx 双层请求上限；Host/Origin allowlist；速率、并发和超时限制；严格 JSON Schema；未知字段拒绝；固定工具清单；统一安全错误；应用 non-root、只读 root filesystem、drop capabilities。

现实攻击故事：攻击者取得演示 Bearer 后尝试调用未列出的 `create_payment`，或用畸形/超大 JSON 造成资源耗尽。服务必须分别返回方法不可用或 413，且不能将请求体或 Bearer写入日志。

### OAuth initiation, callback and token lifecycle

主要风险包括 login CSRF、state substitution/replay、redirect URI 混淆、code 泄漏、过宽 scope、错误 Tenant 选择、并发刷新令牌覆盖，以及 callback 错误被日志记录。

设计控制：`/mcp` 生成短时一次性 connect ticket；浏览器消费 ticket 后直接生成并保存一次性 state 并跳转 Xero；不存在 `/operator/session` 或 `/oauth/xero/start` 的 Bearer 路径；OAuth Cookie 使用 Secure/HttpOnly/SameSite 并绑定同一浏览器；固定 HTTPS redirect URI；最小 scopes；callback 后调用 Xero Connections 并显式记录所选 Tenant；只有全部成功后才签发该浏览器的 reviewer session，取消/失败不签发；Token AES-256-GCM 密文存储；密钥不入库；每 connection 刷新锁；事务化 Token Set 更新；日志字段 allowlist。

现实攻击故事：攻击者把自己发起的 OAuth callback 链接发给操作员，试图把攻击者账套绑定到受害会话。若 state 未绑定会话和 actor，可能形成错误账套连接。

### Tenant isolation and provider adapter

主要风险包括 IDOR、缺失租户过滤、缓存污染、把请求中的 Tenant ID 直接传给 Xero、使用一个连接的 Token 配合另一个 Tenant Header，以及模糊搜索后更新错误记录。

设计控制：从认证上下文解析 connection；数据库行级查询始终包含 tenant/actor；Provider 方法显式接收已解析 connection 对象；禁止通用 URL/header 透传；`XERO_WRITE_ENABLED=false` 默认阻断全部写；开启时还要求当前连接 Tenant 精确等于 `XERO_ALLOWED_TENANT_ID`；写操作只接受精确 Contact/Invoice/Account/Tax ID，并在 Xero 当前 Tenant 内回读校验；双租户集成测试。

现实攻击故事：Agent 从先前会话保留了 Tenant A 的 `invoice_id`，在 Tenant B 会话中请求 Authorise。服务必须在到达 Xero 写调用前拒绝，并留下不包含账务内容的隔离告警。

### Review Gate and approval integrity

主要风险包括未认证审批、Review URL 泄漏即获权、CSRF、点击劫持、Payload swap、过期或重放批准、批准与 Authorise 并发竞争，以及 Agent 自称“用户同意”。

设计控制：Review Page 只接受成功 OAuth callback 为同一浏览器签发的 reviewer session，不接受 MCP Bearer 或仅 Review URL；CSRF token；exact same-origin POST；`frame-ancestors 'none'`；Review 批准/恢复入口不注册为 MCP 工具。数据库事务先锁定 Posting，校验 actor/Tenant/InvoiceID/payload/状态，再校验并消费该页面新签发的 CSRF，并把 `APPROVAL_PENDING`/兼容态 `APPROVED` 原子推进到 `AUTHORISING`；无效对象或状态不会消费 CSRF。服务端持久化稳定 request ID、idempotency key 与不可逆 approval hash，原始批准能力不出服务端；Authorise 前回读并重算 hash。`AUTHORISING`、`WRITE_RESULT_UNKNOWN` 和终态只允许同一操作员带新 CSRF 恢复：前两者只做精确回读，终态直接返回本地持久化结果且不调用 Xero。拒绝操作同样在一个事务内完成对象/状态校验、CSRF 消费和状态更新。

现实攻击故事：账单获批后，恶意调用者把金额从 109 改为 10,900，并尝试伪造或重放内部批准。服务必须在 Provider 写入前因 hash/状态不一致拒绝，且原始 `approval_ref` 不应出现在调用者侧。

### Idempotency, concurrency and unknown outcomes

主要风险包括重试创建重复 Bill、双击批准、并发 Authorise、不同租户复用同一 request ID、Xero 2xx 响应丢失，以及错误地把未知结果当失败后重写。

设计控制：数据库唯一约束与原子 write claim；状态迁移 compare-and-set；同一 Tenant/request/operation/payload 的并发调用最多一个进入 Provider；每 operation 稳定 Xero `Idempotency-Key`；Provider 调用前持久化 posting intent；超时进入 `WRITE_RESULT_UNKNOWN`；恢复任务按已知 InvoiceID 或受控业务键精确查询；未解析前阻断后续动作；精确回读后提交不可回退的 `AUTHORISED_READBACK_VERIFIED` 终态。Draft unknown/recovery 不得覆盖已存在的 Authorise intent；通用 Draft failure 迁移只接受 `BLOCKED_VALIDATION`/`READBACK_MISMATCH` 两个目标，且仅能从 `VALIDATED`，或不带 authorise request 的 Draft `WRITE_RESULT_UNKNOWN` 原子进入。`APPROVED`、`AUTHORISING`、Authorise unknown 和其他状态均拒绝迟到的 Draft failure，终态保持 no-op。任何 Authorise completion 的回读 InvoiceID 必须与 Posting 的原 InvoiceID 完全相等。

每次 MCP/Review 动作还必须先独立提交带唯一 call ID 的 `IN_PROGRESS` audit intent；intent 写失败则业务动作不执行。业务动作成功但 terminal audit 更新结果不确定时，只返回 `CONFIGURATION_ERROR` 并保留业务终态和原始 call row；该 row 只能是仍待核对的 `IN_PROGRESS` 或已经提交的 terminal，不能消失，也不能追加伪造的 FAILED audit。终态重试不触发 Provider，并产生自己的独立 audit。`IN_PROGRESS` 只能由单次 compare-and-set 更新到 `SUCCEEDED`、`REJECTED` 或 `FAILED`，不能被第二次完成覆盖。若业务 action 本身失败且 audit completion 同时不确定，对调用者保留原始 `WRITE_RESULT_UNKNOWN`/Provider 错误语义，并附带内部 audit-completion unknown 证据，避免把账务不确定性误报成普通配置错误。

明确保留的 crash window：原子 claim 已提交、但 Xero Authorise HTTP 尚未发出时进程可能死亡。由于没有 Provider 可验证的“请求已开始”证据，为保证 at-most-once，重启后的新 Review 点击只能精确回读；若仍看到同一 DRAFT，系统保持 `WRITE_RESULT_UNKNOWN` 并要求人工核对，不能自动补写。当前版本不以牺牲重复入账安全来换取这一窗口的自动恢复能力。

现实攻击故事：客户端在写响应前断网并立即重发十次。最终只能存在一个 Xero Bill，所有调用返回同一 `posting_request_id`/InvoiceID，或一致的 unknown 状态。

### Database, logs, health endpoints and deployment

主要风险包括 SQL 注入、Token 密文与主密钥同处、备份泄漏、日志注入、异常堆栈暴露 Secret、health endpoint 泄露 Tenant、容器横向移动和依赖供应链攻击。

设计控制：参数化查询/ORM；迁移唯一约束；主密钥通过受限 secret 注入；数据库不对公网开放；最小数据库账号；备份同等保护；结构化日志与字段 allowlist；敏感模式 CI 扫描；health/ready 只返回状态、版本、工具清单哈希；锁定依赖与镜像摘要；容器 non-root、只读、无多余 capabilities；VPS 只开放 443 与受限 SSH。

### Less relevant or out-of-scope stories

- Payment/Credit Note 只有有界只读历史工具；Payment/Credit Note 写入或分配、Payroll、Bank Transaction 和 Manual Journal 不在工具面中。若写路径误暴露，则立即升级为高风险发布阻断项。
- 本服务不渲染原始凭证内容，也不抓取 Agent 提供的任意 URL；因此文件解析 RCE、SSRF 在本阶段应通过“不实现该能力”规避。未来增加附件抓取时必须重新建模。
- Xero 或 Hetzner 平台级全面失陷、恶意 root 管理员、终端浏览器已完全被控，不可能仅由本仓库完全缓解；需要平台、密钥轮换和运营控制共同处理。
- 财务建议正确性与科目选择质量属于产品风险，但未经审批正式入账、金额/税码篡改或错误租户写入仍属于安全问题。

## Severity Calibration (Critical, High, Medium, Low)

### Critical

- 无需有效操作员批准即可远程 Authorise 任意金额账单，并能影响正式/未来真实客户账套。
- Xero Client Secret、Refresh Token 或加密主密钥可被未认证公网请求直接读取，导致持续控制账套。
- 可跨租户批量读取或写入账务数据，且生产多租户条件下可现实利用。

Demo 仅合成数据会降低即时数据损害，但上述类别仍是生产路径的结构性 Critical，必须在 Demo 阶段阻断。

### High

- 单个租户审批绕过、Payload swap、审批重放或错误 Tenant 写入。
- 幂等/并发缺陷稳定地产生重复 Bill 或重复 Authorise。
- OAuth state 缺陷可让攻击者把错误账套绑定到受害会话。
- 日志、错误响应或 health endpoint 泄漏可用的 Xero Token/MCP Bearer。
- 固定工具清单外暴露 Payment/Credit Note 写入或分配、Delete、Manual Journal、任意 Provider 代理或任意 URL fetch。

### Medium

- 已认证 Demo 用户可通过资源耗尽导致短时不可用。
- 非敏感账务元数据、Tenant 名称或内部 ID 在错误信息中不必要暴露。
- 若审批页的 `Content-Security-Policy: frame-ancestors 'none'` 或 `X-Frame-Options: DENY` 回归缺失，则属于 Medium；当前应用与 Nginx 均已启用这两层 clickjacking 防护。
- Token 刷新故障造成连接不可用，但不会回退到错误 Token 或错误 Tenant。

### Low

- health endpoint 暴露精确版本，但不包含 Secret、Tenant 或账务内容。
- 已认证用户得到过于详细但不含敏感值的验证错误。
- 仅影响本地开发工具、测试夹具或不可部署路径，且没有通往 Token、审批或 Provider 调用的路径。

发布判断不按“Demo 没有真实钱”降低门槛。任何 Critical/High 未关闭项、任何核心 invariant 无测试证据、或无法确认 Tenant/审批/幂等边界，都必须保持写工具关闭。

Repository: xero-accounting-mcp-demo-2026-08-03
Version: p0.3-image-sha256:37a49ce501fa34d261bacdf7815280d8eec57736f05470bc8a833abe768e3572
