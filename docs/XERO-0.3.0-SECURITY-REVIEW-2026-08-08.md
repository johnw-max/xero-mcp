# Xero Accounting MCP 0.3.0 发布前安全审查

- 审查日期：2026-08-08
- 审查对象：`@zcloak/xero-accounting-mcp-demo` `0.3.0`
- 结论口径：代码与仓库配置证据；不等同于线上环境、Xero 真账号或 Agent2 运行态验证
- 数据边界：本轮没有读取、打印或复制任何实际 Secret、Token、Cookie、数据库口令或 `.env` 内容

## 1. 结论先行

| 等级 | 已确认数量 | 结论 |
|---|---:|---|
| Critical | 0 | 未发现 |
| High | 0 | 未发现 |
| Medium | 3 | XSR-MED-002、003 已在 0.3.0 green 发布路径缓解；主 Compose 回退风险与多用户身份边界仍开放 |
| Low | 6 | 建议进入 0.3.x 加固清单，不阻断受控 Demo |

**发布判断：**

- **受控单人 Demo（合成材料、Xero Demo Company、OAuth Broker 已明确启用、应用端口只绑定 loopback、由审查过的 Nginx 入口承载）：CONDITIONAL GO。**
- **多用户、团队共享、真实客户账套或正式生产：NO-GO。** 当前 Host 身份仍是明确标记的 personal POC，不具备真实用户/工作区级可信身份绑定。
- 本轮未发现以下发布阻断类缺陷：开放跳转、OAuth state/PKCE 明显绕过、浏览器 Cookie 明文可读、CSRF 缺失、Xero Token 明文落库、请求参数选择任意 Tenant、SQL 注入、任意 URL SSRF、Secret/堆栈直接回显、未认证写入路径。

受控 Demo 上线前仍必须满足三项外部条件：

1. 运行配置证明 `MCP_OAUTH_BROKER_ENABLED=true`；不得静默落入 legacy shared bearer。
2. 公网只能进入 Host Nginx；`accounting-mcp` 的 loopback 端口和 PostgreSQL 不得公网暴露。
3. 由 CI 或发布操作员补一份生产依赖漏洞数据库扫描证据，并确认 Critical/High 为 0。本轮尝试查询 npm 官方 advisory 数据库时，因会向公网披露私有项目依赖元数据而被审批层拒绝，因此这里不声称“依赖无已知漏洞”。

## 2. 审查范围与方法

主范围：

- `src/http/app.ts`
- `src/oauth/**`
- `src/security/**`
- `src/providers/xeroClientManager.ts`
- `src/db/postgresRepository.ts` 及相关 PostgreSQL migration/query 证据
- `deploy/nginx/**`、`deploy/host-nginx/**`
- `deploy/Dockerfile`、`deploy/docker-compose/**`
- `package-lock.json`

为判断配置、日志和 Node timeout，额外只读检查了 `src/config.ts`、`src/logging.ts`、`src/errors.ts`、`src/server.ts` 和相关 migration。没有修改这些文件。

方法：

- 系统搜索请求输入、redirect、Cookie、CSRF、CORS、Host/proxy、CSP/HTML sink、Token/日志、SQL、网络出站、timeout、debug/inspector、容器权限和依赖来源。
- 逐段核对 OAuth Authorization Code、Xero callback、Organisation selection、外层 MCP token exchange/refresh/revoke、Tenant binding 与数据库事务。
- 运行 17 个安全/OAuth 合同测试文件，共 **217 tests passed**。
- 运行真实 loopback HTTP 边界测试，共 **2 tests passed**；首次沙箱内因 `listen EPERM` 失败，获准仅监听 `127.0.0.1` 后通过。
- 未运行 PostgreSQL integration tests：本轮环境未配置 `TEST_DATABASE_URL`；因此数据库结论来自参数化 SQL、事务/约束代码和 repository contract tests，不声称本轮重新验证了真实 PostgreSQL 实例。

## 3. Critical

### 无已确认 Critical

在本轮范围内，没有证据表明未认证公网调用者可以读取 Xero Token/Client Secret、绕过人工确认直接执行高风险写入，或批量跨 Tenant 读取/写入。

## 4. High

### 无已确认 High

在本轮范围内，没有确认 OAuth redirect/state/PKCE 绕过、可利用的跨 Tenant IDOR、SQL 注入、任意 URL SSRF、Refresh Token 明文持久化或日志泄漏。

## 5. Medium

### XSR-MED-001 — personal POC 使用固定部署身份，不能作为真实多用户隔离

- 规则/类别：认证主体可信度、Tenant/installation binding、least privilege
- 位置：`src/oauth/mcpOAuthBrokerProvider.ts:266-268,294-313,566-573`；`src/oauth/brokerPages.ts:95-97`
- 证据：Broker 只有在 `personalPocOnly` 为真时才允许授权；workspace 固定为 `personal-poc`，subject 使用部署配置的 `demoActorId`，agent identity 只由预注册 `client_id` 派生。页面虽然明确显示 `HOST IDENTITY UNVERIFIED`，但代码没有来自 zCloak/Agent2 的签名 user/workspace/installation assertion。
- 影响：若同一 Host client 被多个真实用户使用，他们在 Broker 看来不是独立可信主体。审计归属、installation 隔离和“谁连接了哪个 Xero 组织”都不能达到正式多用户产品要求；错误地扩大使用范围会把单人 POC 的安全假设带入生产。
- 修复：在 `/authorize` 前验证平台签名的 Host installation assertion，或使用 Broker 自己的已认证用户会话；服务端取得并绑定真实 `workspace_id + subject_type + subject_id + agent_id + installation_id`。完成后移除 personal-POC 固定主体与兼容分支，并新增双用户/双 workspace PostgreSQL 与线上 UAT。
- 当前缓解：代码 fail closed——`personalPocOnly=false` 时直接拒绝；Organisation 页面也显式警告；数据库后续仍精确绑定一个 installation/binding/connection。
- 误报说明：这不是受控**单人** Demo 内的越权漏洞，而是把当前版本描述或开放为多用户产品时的真实安全缺口。因此不阻断单人合成数据 Demo，但阻断团队/真实客户上线。

### XSR-MED-002 — 生产部署缺省可静默回退到 legacy shared bearer

- Disposition：**0.3.0 green 发布路径已修复；仓库主 Compose 路径仍未修复。**
- 规则/类别：认证 fail-safe defaults、multi-tenant binding
- 位置：`src/config.ts:53,204,344-346`；`src/http/app.ts:524-556`；`deploy/docker-compose/compose.host-nginx.vps.yaml:62-67`；`deploy/docker-compose/compose.vps.yaml:62-67`；green 路径缓解见 `deploy/docker-compose/compose.host-nginx.green.vps.yaml` 与 `deploy/scripts/verify-static.sh`
- 证据：应用默认值及两个主部署 manifest 仍允许 `MCP_OAUTH_BROKER_ENABLED=false`。Broker 关闭时应用不是拒绝启动，而是把 `/mcp` 切换到单一 `MCP_BEARER_TOKEN + DEMO_ACTOR_ID` 的 legacy 路径。0.3.0 green manifest 已改为两个开关显式必填，并在容器启动前要求二者精确等于 `true`；静态发布闸门覆盖缺失、`false` 和 `true` 三类配置。
- 影响：若发布环境遗漏一个布尔配置，服务仍会健康启动，但丢失外层 OAuth token 的 installation/binding/connection 语义。任何取得共享 bearer 的调用者都会进入同一 Demo actor，无法满足用户级审计和隔离；这类配置漂移不容易从 health check 发现。
- 修复：生产配置改为显式必填；建议 `NODE_ENV=production` 时 Broker 未启用即拒绝启动，除非另有命名明确、默认关闭的 `ALLOW_LEGACY_SINGLE_USER_DEMO=true` break-glass。Compose 使用 `${MCP_OAUTH_BROKER_ENABLED:?Set ...}`，ready/release gate 同时断言 OAuth discovery 与 legacy bearer rejection。
- 当前缓解：0.3.0 green 发布路径对缺失/空值在 Compose 渲染阶段失败，对任何非精确 `true` 在容器启动阶段失败；共享 bearer 仍要求至少 32 字符，legacy 写入还要求显式 write flag 和 allowed tenant，Host Nginx 只代理固定路径。该缓解不覆盖两个主 Compose。
- 误报说明：若线上 `.env` 已明确设置 Broker 为 true，则这不是当前运行态暴露，而是仓库中仍存在的高后果误配置路径。本轮没有读取 `.env`，所以必须由部署验收提供证据。

### XSR-MED-003 — 临时写闸存在 restart-policy 切换窗口且自动关闭失败不重试

- Disposition：**0.3.0 green 发布路径已修复；仍需 VPS 运行态故障注入验收。**
- 规则/类别：fail-safe transition、bounded retry、release safety
- 证据：旧 `open` 先按 Compose 的 `unless-stopped` 创建写开启容器，再执行 `docker update --restart=no`；15 分钟 autoclose 与 boot-close 都只有一次关闭尝试。若恰在切换窗口重启，或关闭时 Docker 短暂不可用，写开启状态可能超过预定窗口。
- 修复：green Compose 的 restart policy 参数化；open 在同一次 create 使用 `no`，close/autoclose/boot-close 在同一次 create 使用 `unless-stopped`。两个 systemd 关闭路径均采用 `Restart=on-failure`、15 秒间隔、15 分钟窗口和最多 4 次启动；status 校验 timer/service/retry 的 systemd 实际属性。boot-close 仍由 Nginx `Wants=` 而不是 `Requires=` 引入。
- 验证：仓库静态闸门验证 open/close 参数、禁止 `docker update --restart`、检查有界 retry 配置及 status 的失败断言；Compose 与现有切流故障注入均通过。本轮按发布范围未在 VPS 人为中断 Docker，因此不把 systemd 真实重试次数写成线上已验证。

## 6. Low

### XSR-LOW-001 — OAuth 专用 64 KB body limit 被全局 parser 顺序覆盖

- 规则：`EXPRESS-BODY-001`
- 位置：`src/http/app.ts:497-503`；`src/oauth/mcpOAuthRouter.ts:86-90`
- 证据：全局 `express.urlencoded({ limit: config.requestBodyLimitBytes })` 在 OAuth router 之前执行；请求流已解析后，router 内的 `64kb` parser 不会再次应用更小的 limit。
- 影响：`/token`、`/revoke` 和 Organisation selection 实际接受到应用层全局上限，而不是代码看起来的 64 KB，增加无效大表单的解析成本。
- 修复：在全局 body parser 前挂载 OAuth router，或对 `/token`、`/revoke`、`/oauth/xero/select` 使用 route-scoped parser，并让全局 parser 排除这些路径。
- 当前缓解：Host Nginx `client_max_body_size 1m`，OAuth 路径有 2 r/s 的 IP rate limit；应用全局默认也是 1 MiB。
- 误报说明：这不是无限 body 或当前可利用的内存耗尽；它是“64 KB 安全意图没有实际生效”的 defense-in-depth 缺口。

### XSR-LOW-002 — legacy/review Cookie 未采用 `__Host-` 名称且 parser 不拒绝重复 Cookie

- 规则：`EXPRESS-COOKIE-001`、`EXPRESS-SESS-002`
- 位置：`src/http/app.ts:29-39,68-81,602-608,628-630,640-648`
- 证据：Broker Cookie 已使用 `__Host-zcloak_oauth_flow` 并拒绝重复值，但 legacy OAuth 和 reviewer session 分别使用 `zc_xero_oauth_session`、`zc_review_session`；`parseCookie` 返回遇到的第一个同名值。
- 影响：若同一父域的其他子域被控制，攻击者可以设置 Domain Cookie 制造同名歧义，主要造成 OAuth/review 会话拒绝服务。当前没有证据表明攻击者可借此猜出高熵 session 并接管账户。
- 修复：改用 `__Host-zc_xero_oauth_session`、`__Host-zc_review_session`，始终 `Secure; Path=/;` 且无 Domain；复用 `readExactCookie` 的“恰好一个值”语义。
- 当前缓解：值为高熵随机值、服务端 hash/actor/CSRF 绑定；生产 Cookie 是 Secure/HttpOnly/SameSite=Lax；Broker 主流程已经使用更强实现。
- 误报说明：在 Broker-only 单人 Demo 且没有不受信 sibling subdomain 时，现实影响很低。

### XSR-LOW-003 — Node HTTP server 未显式固定 request/header/keep-alive timeout

- 规则：`EXPRESS-DOS-001`
- 位置：`src/server.ts:97-109`；外层缓解见 `deploy/host-nginx/mcp.jiayuanwang.xyz:67-74,108-123`
- 证据：应用直接使用 `app.listen` 后没有设置 `requestTimeout`、`headersTimeout`、`keepAliveTimeout` 或 `maxRequestsPerSocket`。超时主要依赖 Node 当前默认值和 Nginx。
- 影响：若未来应用端口被错误暴露、增加另一层代理或 Node 默认行为变化，慢请求与长连接的资源边界会弱于设计意图。
- 修复：显式设置并测试 Node server timeouts；普通 HTTP 路径与 Nginx 15/30 秒边界一致，MCP 长请求单独设定经过评审的上限；继续保持应用只监听 loopback/私网。
- 当前缓解：当前 Host Compose 只发布 `127.0.0.1:18002`；Nginx 有 header/body/connection timeout、per-IP rate/connection limit，`/mcp` 的 300 秒是明确的业务例外。
- 误报说明：在当前单层 Nginx 且 loopback 端口没有外露时，这是拓扑变更风险，不是当前公网 slowloris 绕过。

### XSR-LOW-004 — 容器基础镜像按 tag 固定，未按 digest 固定

- 规则：`EXPRESS-DEPS-001`
- 位置：`deploy/Dockerfile:3-5`；`deploy/docker-compose/compose.host-nginx.vps.yaml:5,45`；`deploy/docker-compose/compose.vps.yaml:5,45,112`
- 证据：Node、PostgreSQL 和 Nginx 使用精确版本 tag，但没有 `@sha256:...` digest；同名 tag 理论上可以被 registry 重新指向不同内容。
- 影响：重建同一 Git 版本时不保证得到逐字节相同的基础镜像，削弱供应链可复现性和紧急回滚证据。
- 修复：发布 manifest 同时 pin tag 与 digest；由受控机器人定期提交 digest 更新并附 CVE/构建测试证据。
- 当前缓解：Docker runtime 为 non-root、read-only、drop all capabilities、no-new-privileges；npm production install 使用 lockfile、`--ignore-scripts`；本轮统计 128 个生产 registry tarball 均有 integrity，且没有非 npm registry 来源。
- 误报说明：未发现镜像被篡改的证据；这是供应链 hardening，而不是已发生的 compromise。

### XSR-LOW-005 — 高价值 Secret 通过容器环境变量注入

- 规则/类别：Secret management、least exposure
- 位置：`deploy/docker-compose/compose.host-nginx.vps.yaml:13-17,60-82`；`deploy/docker-compose/compose.host-nginx.green.vps.yaml:21-45`
- 证据：数据库口令、Xero Client Secret、Token encryption key、OAuth hash/state key 和 Host client 配置由环境变量传入容器。
- 影响：具有 Docker inspect/daemon 读取权或进程环境读取能力的主体可以看到 Secret；故障诊断工具若错误收集环境也可能扩大泄漏面。
- 修复：正式部署使用 Docker secrets、只读 `0400` 文件、systemd credentials 或云 KMS/secret manager；应用支持从 `*_FILE` 读取，并在启动后尽量缩短原始 Secret 的环境暴露时间。
- 当前缓解：这类权限通常已接近 VPS root；应用日志采用字段 allowlist 和敏感模式 scrub；Xero Token 本身以 AES-256-GCM 密文落库，数据库网络为 internal。
- 误报说明：单机个人 Demo 可以作为已接受的运维风险，但不能把环境变量注入描述为生产级 secret isolation。

### XSR-LOW-006 — OAuth HTML 依赖 inline CSS，因此 CSP 允许 `style-src 'unsafe-inline'`

- 规则：`JS-CSP-001`、`JS-CSP-002`
- 位置：`src/oauth/brokerPages.ts:69-78,99-113`；`src/oauth/mcpOAuthBrokerProvider.ts:173-186`；`deploy/host-nginx/mcp.jiayuanwang.xyz:76-84`
- 证据：Organisation selection 和 Personal POC return page 内嵌静态 `<style>`；应用与 Nginx CSP 因而允许 inline style。`script-src` 没有放开，页面也没有脚本。
- 影响：当前不是脚本执行漏洞，但会使未来新增不可信 style 属性/模板内容时少一层 CSS 注入防护，也让 CSP 难以收紧为 hash/nonce 模式。
- 修复：把 CSS 移到固定 same-origin 静态资源，或为不可避免的静态 style 使用 CSP hash；保持 `script-src 'none'`/等效限制。
- 当前缓解：所有动态 tenant/name/scope/hidden field 都经过 HTML escaping；没有 `innerHTML`、`document.write`、`eval`、外部脚本、Web Storage 或 `postMessage`；CSP 同时禁止 object、base 和 framing。
- 误报说明：`unsafe-inline` 仅位于 `style-src`，不是 `script-src`；所以本项按 Low 而不是 Medium/High。

## 7. 已验证的正向安全控制

### OAuth redirect、state、PKCE 与浏览器边界

- Host redirect URI 必须与预注册值逐字匹配：`src/oauth/mcpOAuthBrokerProvider.ts:269-285,606-609`。
- Host state 有界、keyed hash + AES-GCM 短时保存，返回前再次验 hash：`src/oauth/mcpOAuthBrokerProvider.ts:272-305,555-560`。
- 外层只接受 S256 challenge；token exchange 验 verifier、redirect、resource：`src/oauth/mcpOAuthTokenService.ts:134-167`。
- Xero callback 要求恰好一个 state、浏览器 `__Host-` Cookie，并由数据库原子进入 exchange 状态：`src/oauth/mcpOAuthBrokerProvider.ts:389-412`。
- Organisation selection 同时验证 Origin/Fetch Metadata、一次性 CSRF、Cookie 和精确 connection ID：`src/oauth/mcpOAuthBrokerProvider.ts:482-553`。

### Cookie、CSRF、CORS、Host 与 CSP

- Broker Cookie 是 `Secure; HttpOnly; SameSite=Lax; Path=/`，名称带 `__Host-`，重复 Cookie fail closed：`src/oauth/brokerCookies.ts:1-37`。
- review POST 要求 exact same-origin + 一次性、session/posting-bound CSRF：`src/http/app.ts:246-258,676-750`；数据库消费见 `src/db/postgresRepository.ts:2971-3000`。
- CORS 只对固定 machine endpoints 和 exact configured origins 开放；不允许 wildcard/credentials：`src/http/app.ts:139-228`。
- Host header 有 allowlist，`x-powered-by` 关闭；Nginx 无效 Host 不反射：`src/http/app.ts:487-499`；`deploy/nginx/default.conf.template:8-27,43-54`。
- HTML 动态值有 context-appropriate escaping；Xero deep link 由固定 HTTPS origin 和 UUID/short-code allowlist 生成。未发现 DOM XSS sink。

### Token、日志与错误

- Xero Token set 只以 AES-256-GCM + AAD 密文保存：`src/security/tokenCipher.ts:9-52`；`src/providers/xeroClientManager.ts:377-399`。
- 外层 access/refresh/code/state 仅保存 domain-separated keyed HMAC：`src/security/oauthSecrets.ts:13-43`；`src/oauth/mcpOAuthTokenService.ts:151-175,317-325,343-380`。
- HTTP、OAuth exchange 和 provider refresh 日志只记录 allowlisted 元数据，不记录 callback query、Token、Cookie、client credentials 或 error message/stack：`src/logging.ts:12-84`；`src/http/app.ts:570-576,766-792`；`src/oauth/brokerXeroAuthorizationService.ts:35-75,166-181`。
- Nginx access log 使用 `$uri` 而不是 `$request_uri`；authorize/callback error log 被抑制，避免 code/state 进入边缘日志：`deploy/nginx/00-security.conf:3-8`；`deploy/host-nginx/mcp.jiayuanwang.xyz:158-173,197-225`。

### SQL、SSRF 与 Tenant binding

- 本轮扫描到的 248 个 `pool/client.query` 调用均使用静态 SQL + `$n` 参数；唯一 query template 分支仅由内部 boolean 决定是否追加固定 `FOR UPDATE`：`src/db/postgresRepository.ts:4490-4524`。Migration runner 执行的是仓库内、文件名 allowlist 后的 SQL 文件，不接受 HTTP 输入：`src/db/migrate.ts:21-37`。
- 没有任意 URL fetch/proxy/upload；Xero SDK 客户端只使用部署配置的 Xero OAuth/API，并设置 10 秒 provider HTTP timeout：`src/providers/xeroClientManager.ts:365-374`。
- 非 legacy 请求必须由 access token 解析完整 installation/binding/workspace/subject/agent/connection tuple；工具参数不能选择 Tenant：`src/security/requestContext.ts:50-102,184-232`；`src/providers/xeroClientManager.ts:147-220`。
- 数据库解析 token 时同时要求 access token、binding、installation、connection、provider authorization 和 refresh family 都为 ACTIVE：`src/db/postgresRepository.ts:2261-2297`。

### Rate limit、body 与容器边界

- Nginx 对一般、MCP、OAuth 分别限速，并限制 per-IP connection：`deploy/nginx/00-security.conf:10-15`；Host Nginx 同类配置见 `deploy/host-nginx/mcp.jiayuanwang.xyz:18-21,67-74`。
- 应用与 Nginx 都有 1 MiB 默认 body limit；413 返回统一安全错误：`src/http/app.ts:497-499,766-779`；`deploy/nginx/default.conf.template:68-73`。
- 应用容器 non-root、read-only、no-new-privileges、drop all capabilities、tmpfs、PID/memory/CPU/log limits；PostgreSQL 仅在 internal data network：`deploy/Dockerfile:20-41`；`deploy/docker-compose/compose.host-nginx.vps.yaml:4-43,44-112,181-186`。

## 8. 连接过期与主动撤销结论

这里有两层不同的 OAuth，不能把“Xero 约 30 分钟”直接等同于 Agent2 到 MCP 的登录时长：

| 凭证 | 当前行为 | 结论 |
|---|---|---|
| Xero access token | 使用 Xero 返回的 `expires_at`；缺失时保守按约 25 分钟；到期前 60 秒由服务自动 refresh | 自动处理，不需要人为每 30 分钟重连 |
| 外层 MCP access token | 代码硬上限 **900 秒（15 分钟）** | 短期凭证自动失效；Host 用 refresh token 无感续期 |
| 外层 MCP refresh token | 硬上限 **2,592,000 秒（30 天）**；每次使用旋转并把新 token 的 30 天从当次刷新重新计算 | 约 30 天不使用会自然过期；持续使用则为滑动有效期 |
| Browser OAuth flow | 默认最多 600 秒 | 未完成连接会短时失效 |
| Authorization code | 默认最多 300 秒且一次性 | 防止 code 重放 |

代码证据：`src/oauth/mcpOAuthTokenService.ts:60-62,121-130,178-240,245-340`；`src/providers/xeroClientManager.ts:71-90,223-340`。

主动失效路径已经存在：

- `/revoke` 仅允许无浏览器 Origin 的 confidential server client，并要求常量时间 client authentication：`src/oauth/mcpOAuthRouter.ts:46-90`；`src/oauth/clientAuthentication.ts:98-168`。
- 若 Host 撤销 **refresh token**，repository 会撤销该 installation 下 refresh family、全部相关 MCP access tokens、binding 和 installation：`src/oauth/mcpOAuthTokenService.ts:384-404`；`src/db/postgresRepository.ts:2821-2889,4663-4740`。
- 若只撤销 **access token**，只保证该 access token 立即失效；refresh token 仍可续期。测试“完全断开连接”时应撤销 refresh token，或调用受认证的 installation revoke 管理能力。
- Refresh token 重放会撤销整个 installation grant，而不是只拒绝一个请求：`src/db/postgresRepository.ts:2676-2688,4663-4740`。

因此，自动过期/自动刷新机制本身无需改成“Xero 30 分钟后强制用户重新登录”。产品侧仍建议提供一个清晰的“Disconnect Xero”入口，由服务端撤销 refresh token/installation，而不是只丢弃前端 access token。

## 9. 未完成的动态证据与发布清单

以下不是已确认漏洞，但不能被写成“已验证通过”：

1. **生产依赖 advisory：NOT VERIFIED。** `package-lock.json` 是 lockfile v3，生产 tarball 均有 integrity，Docker build 使用 `npm ci --ignore-scripts`；但本轮没有获得 npm advisory 响应。
2. **PostgreSQL integration：NOT RE-RUN。** 本轮没有 `TEST_DATABASE_URL`；需在隔离测试库运行 OAuth broker/identity/revoke integration suites。
3. **运行态配置：NOT INSPECTED。** 未读取 `.env`，所以 Broker 是否启用、实际 Host allowlist、redirect allowlist、key separation 和 loopback 绑定需要部署证据确认。
4. **真实 Agent2/Xero：NOT PART OF THIS REVIEW。** 本报告只给代码安全闸门；线上关键节点仍需独立 UAT，且只能使用合成材料与 Demo Company。

建议发布证据最小集合：

- `npm audit --omit=dev` 或公司 SCA 报告：Critical/High = 0；
- PostgreSQL required integration tests 全绿；
- OAuth discovery、wrong redirect、wrong state、wrong PKCE、wrong resource、expired token、refresh rotation/replay、refresh-token revoke 全绿；
- 线上确认 legacy bearer 被拒绝、Agent2 重新连接成功、一个 signature read flow 和一个受控 draft-write/read-back flow 成功；
- 完成后主动 revoke refresh token，确认旧 access token 与 refresh token 都不能再调用，再重新授权恢复。
