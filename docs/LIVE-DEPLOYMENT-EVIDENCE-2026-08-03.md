# Xero Accounting MCP 现场部署证据

日期：2026-08-03  
环境：Hetzner `offbeatlabs` / `178.156.234.230`，zCloak AI 私有工作区，Xero Trial

## 结论

截至本文最新记录时，P0.6 已部署到 `https://mcp.jiayuanwang.xyz/mcp`，并在指定 Xero Trial 组织中跑通受控账本主流程：`zCloak -> 远程 MCP -> Xero OAuth -> DRAFT -> Review 核对 -> AUTHORISED -> 同一 InvoiceID 精确回读 -> Trial Balance -> Xero UI`。最终内部状态为 `AUTHORISED_READBACK_VERIFIED`，Xero 中只有一张 HKD 100 合成 Bill，且测试完成后已把 `XERO_WRITE_ENABLED` 恢复为 `false`。

这份结论只适用于单一 Trial 组织和合成数据。它不代表生产可用、真实客户账套、自动付款、月结、报税、多组织 onboarding 或附件自动抽取已完成。

## P0.6 真实 Xero E2E（2026-08-04）

- Xero Web app `zCloak Ledger MCP Demo` 已创建；OAuth callback 为 `https://mcp.jiayuanwang.xyz/oauth/xero/callback`。
- 实际授权 scopes：`openid profile email offline_access accounting.settings.read accounting.contacts.read accounting.invoices accounting.reports.trialbalance.read`；没有 bank、payment、delete 或 manual-journal 权限。
- OAuth 连接唯一 organisation `zcloak`；Tenant ID `7c3cc738-eef0-4d4e-83f8-d528390e1e61`；本位币 HKD；Provider connection 为 ACTIVE；Token 仅以加密形式持久化。
- 动态读取后选择：Supplier `zCloak Synthetic Supplier HK Limited`、ContactID `14c4056e-97d3-4e7e-8285-60bf9860d100`、Account `485 - Subscriptions`、TaxType `NONE`。
- 合成源 PDF SHA-256：`d87191ef6ffeed9bd77fea0e932fe31e3fdeb35aec4a150d222b45413bde0311`；Reference `ZC-MCP-HKD-20260804-001`；金额 HKD 100；日期 `2026-08-03 -> 2026-08-17`。
- zCloak Agent 创建唯一 Posting Request `pr_7565121c-a796-434f-b499-0eb37f9d6e13` 与唯一 InvoiceID `b4cbb8ee-d420-4343-bdd3-2a39af7cc756`；DRAFT 精确回读全部匹配。
- DRAFT 时 Trial Balance 总借/贷/YTD 均为 0；AUTHORISE 后 `Subscriptions (485)` 借记 100，`Accounts Payable (800)` 贷记 100，总借方与总贷方均为 100。
- Xero UI 精确 Bill 页面显示 Awaiting Payment、HKD 100、Subscriptions、Tax Exempt；All Bills 显示 `1 item | 100.00 HKD`，对应 href 中的 InvoiceID 与上述一致。
- 相同 request ID 与相同 payload 重放返回同一 Posting/Invoice 且 `idempotentReplay=true`；相同 request ID 改 Reference 返回 `CONFLICT`；数据库和 Xero UI 均未出现第二张 Bill。
- 独立 QA 只读复核：Posting 1、distinct InvoiceID 1、终态 `AUTHORISED_READBACK_VERIFIED`、approval consumed 1、`IN_PROGRESS` audit 0。
- 测试完成后写开关恢复为 false，只重建 Accounting MCP App；最终 App ID `c9bf1167b504e6b505919dff97d5a3439db56b5e513a410c85912f6c61a047ca`、healthy、RestartCount 0。PostgreSQL ID `7eecc70b392bd0216ef1fb71f54d150872beb57ad53e0e124ede73308fa1f271` 与启动时间保持不变。
- 关闭写入后的公网 MCP smoke 8/8 PASS；额外 create probe 返回 `FORBIDDEN / Xero write operations are disabled for this deployment`，Posting 仍为 1。
- App/Nginx 全量日志脱敏扫描：Bearer、Token、Cookie、JWT-like、ticket query、OAuth code/state query 实际命中均为 0。

浏览器验收边界：Review 页面已在成功 OAuth 的浏览器中完整显示并逐项核对，但 Chrome 自动化层在 HTML form navigation 到达服务端前返回 `ERR_BLOCKED_BY_CLIENT`。实际授权通过部署中同一套 ReviewService session、CSRF、actor 绑定、audit、idempotency 与 exact-readback 路径完成；随后真实 `POST /review/:id/approve` HTTP 路由在终态幂等回放中返回 200、`AUTHORISED`、`verified=true`，没有第二次 Provider 写。合成 PDF 已生成并目视校验，但 Chrome 扩展未开放 file-URL 上传权限，因此 zCloak 创建 UAT 使用了同一 fixture 的明确字段。

完整脱敏证据：`artifacts/test-runs/2026-08-04-p0.6-live-xero/`。

## P0.5 最新现场验收（2026-08-04）

- 运行镜像：`xero-accounting-mcp-demo:2026-08-04.5`；digest `sha256:f28c1c96dbfec361fa1c9a982d31f483cf1914ab4d1e2536aa5c10a738fc0b94`。
- App healthy、RestartCount 0、只监听 `127.0.0.1:18002`；`XERO_WRITE_ENABLED=false`，Tenant allowlist 为空。
- migrations 001–004 全部存在；004 audit index、两项 validated constraints 与 nullable `finished_at` 均由独立 SQL 验证；`/readyz` 200。
- PG17 隔离验证：audit continuity 6 项 PASS；10,000-ticket cleanup PASS；authorise monotonicity 14 项 PASS；临时库残留 0。
- 正式库 Provider、Posting、Audit 在迁移前、迁移后、切换后三份 hash/count 完全一致；OAuth state、connect ticket、operator session、review CSRF 均为 0；`IN_PROGRESS` audit 为 0。
- App 与 PostgreSQL 的 Compose labels/working directory 均唯一指向 `/opt/xero-accounting-mcp-demo`；P0.4 的 split-provenance 残差已清除。
- 独立公网 smoke 8/8 PASS；工具清单精确 8 个；`xero_authorise_supplier_bill` 不对 Agent 暴露；401、403、413 均 PASS。
- App/Nginx 实时日志敏感模式与 `ticket=` 查询参数泄漏均为 0；PostgreSQL、Nginx、stock MCP 未重启且保持健康。
- P0.5 archive SHA：`92b0b1a9e4ec545e3e600a4e5d35f6936651aef749e561b92a0cb6b448103e40`；远端脱敏证据目录 `/root/xero-accounting-mcp-p05-evidence` 为 0700，43 个文件均为 0600。
- P0.5 部署与独立 QA 阶段未触发 OAuth、connect ticket、`tools/call`、Xero 读写或审批。其后的 zCloak UAT 按设计触发了 1 次 `xero_connection_status` 与 1 个短期 connect ticket，但未打开入口、未生成 OAuth state，也未调用 Xero Provider。

### P0.5 zCloak 发布后只读 UAT（2026-08-03T19:19:12Z）

- 用户以日常语言要求只检查是否连接，并明确禁止打开授权页及创建、修改、授权或删除账务数据。
- Agent 精确调用 1 次 `xero_connection_status`，没有调用其他 MCP 工具；结果为 `connected=false`、scopes 为空，并生成新的短时连接入口。
- Agent 用一句话说明“当前未连接，下一步需通过连接入口授权”；入口未被打开，Xero consent 未启动。
- PostgreSQL 只读复核：Provider connection 0、Posting Request 0、OAuth state 0、active connect ticket 1、audit total 6、`IN_PROGRESS` 0；最新审计为 `xero_connection_status / SUCCEEDED` 且无 Tenant。
- 最近 15 分钟 App 日志的 client secret、access/refresh token、Bearer 与 `ticket=` 泄漏命中数均为 0。
- active connect ticket 是连接状态工具按合同生成的短期一次性能力，不是 Xero 连接或账务记录；它将在过期清理窗口后删除。

## P0.3 历史证据（已被 P0.5 取代）

| 层级 | 证据 | 结果 |
|---|---|---|
| DNS | `mcp.jiayuanwang.xyz` 公网 A 记录 | `178.156.234.230`；无 AAAA |
| TLS | Let's Encrypt 证书 | 签发成功；到期日 2026-11-01；自动续期 dry-run 通过 |
| Edge | 宿主机 Nginx 新增独立站点 | `nginx -t` 通过；HTTP/2 无弃用警告；未改动既有 `stock-mcp` 站点 |
| App | Accounting MCP 容器 | `xero-accounting-mcp-demo:2026-08-03.3`，镜像 `sha256:37a49ce501fa34d261bacdf7815280d8eec57736f05470bc8a833abe768e3572`；仅绑定 `127.0.0.1:18002`；healthy；重启次数 0 |
| Database | PostgreSQL 17 容器 | 健康；5432 未发布到宿主机或公网 |
| Migration | `001_init.sql` | 显式执行成功 |
| Health | `/healthz`、`/readyz` | 公网 HTTPS 返回 200 |
| Auth boundary | `/mcp` 无 Bearer、错误 Bearer | 均返回 401；持真实 Bearer 调旧 `/operator/session`、`/oauth/xero/start` 均为 404；仅 Bearer 打开 Review 为 401 |
| OAuth entry | 新 ticket、重放与跳转目标 | 首次 302 到 `https://login.xero.com/identity/connect/authorize`；同一 ticket 重放 403；未完成 OAuth consent |
| Write gate | 运行容器环境 | `XERO_WRITE_ENABLED=false`；`XERO_ALLOWED_TENANT_ID` 为空；真实 Xero Tenant 尚未读取，Provider connection/posting 均为 0 |
| Reviewer-session migration | 旧版临时会话清理 | 发现并注销 1 个旧版测试 reviewer session；最终 operator session 与 review CSRF 均为 0 |
| Origin boundary | 错误 Origin | 返回 403 |
| Body boundary | 超过 1 MiB 请求 | 返回 413 |
| MCP protocol | initialize、initialized、ping、tools/list | 公网黑盒 8/8 通过，stateless Streamable HTTP |
| Tool contract | 固定工具清单 | 精确返回 9 个 allowlisted Xero 工具 |
| zCloak | 自定义 MCP `zCloak Ledger MCP Xero Demo` | 平台显示 Connected |
| Agent call | P0.2 真人口吻只读询问 | Agent 实际调用 `xero_connection_status`，正确返回 `connected=false` 和新短时入口，未创建、批准、修改或删除账务数据；P0.3 未重复网页端调用 |
| Log redaction | Nginx 与 App 日志 | 没有 `ticket=`；边缘日志仅记录 `GET /connect/xero` |
| Deployed regression | TypeScript、Build、Vitest、静态部署校验 | 全部通过；9 个测试文件、72 项测试 |
| PostgreSQL production semantics | PostgreSQL 17.10 隔离临时数据库验证器 | `PASS`；13 项检查覆盖 Review 原子 claim、CSRF 重放与绑定、Draft/Authorise 反向竞态、InvoiceID 绑定、终态不可回退和 unknown-write 回读恢复；临时库随后确认 Provider connection 为 0 并删除 |
| Dependency audit | 生产依赖 | P0.2 审计为 0 vulnerabilities；P0.3 `package-lock.json` 未变化（SHA-256 `2d4956b130f8a913e9704a4eb7c64892ad3edce759cccbb1124bd32bc4a2d197`） |
| Existing service | `stock-mcp` | 部署前后健康检查均为 200 |

## P0.3 历史发布与回滚基线

- 当前应用镜像/运行容器 ID：`sha256:37a49ce501fa34d261bacdf7815280d8eec57736f05470bc8a833abe768e3572`
- 当前容器启动时间：`2026-08-03T17:11:06.044343426Z`
- 当前容器重启次数：`0`
- 当前 Host-Nginx Compose SHA-256：`34a02b69a8c39a5d07f8c977edde0cf8cbbecb339033bb71f59631bc1d135e27`
- 当前已安装 Xero Nginx 站点 SHA-256：`ae861deb7f74ffcf949047aa8eb2357f5fdfb5ddecf9e74990f8031c415b1aa9`
- 上一版应用镜像：`xero-accounting-mcp-demo:2026-08-03.2` / `sha256:1c84859caafd2683451244be89bdf546fa3addcace5a44b960c73aed744dd035`
- 上一版源码/受保护配置备份：`/opt/xero-accounting-mcp-demo.backup-20260803-p0.2`
- 发布包 SHA-256：`6e7d28f1e3976bb96e7149cbf1bd3ebc35876982030bcdfd8d78c9c295b08b1a`

更换 Xero Client ID/Secret 时只允许修改受保护的 `deploy/.env.vps` 并重建 `accounting-mcp`；不重建 PostgreSQL，不执行 `down -v`。

## P0.3 历史重新部署验证

以下为 2026-08-03 P0.3 单容器重新部署后的现场回执：

- 一次性 connect ticket 被消费后直接生成浏览器绑定的 OAuth state 并 302 到 `login.xero.com`，不经过 `/oauth/xero/start`；重放同一 ticket 返回 403。
- `/operator/session` 与 `/oauth/xero/start` 均为 404；MCP Bearer 仅在 `/mcp` 生效，单独携带 Bearer 访问 Review 返回 401。
- 旧版曾签发的 1 个临时 reviewer session 已在确认 Provider connection/posting 均为 0 后注销；级联 CSRF 与最终 session 计数均为 0。
- 线上容器以 `XERO_WRITE_ENABLED=false`、空 `XERO_ALLOWED_TENANT_ID` 启动；OAuth 成功前没有任何 Provider connection 或 Posting Request。
- 本地负向回归证明 OAuth callback 失败/取消不会签发 reviewer session；真实成功 callback 的浏览器签发仍属于 `NOT-RUN`。
- 真实 PostgreSQL 17.10 隔离验证器返回 `PASS`，run ID `7ae1442bd2744b93ad6d6f0210d50854`；临时数据库 `xero_mcp_verify_20260803_p03` 中 Provider connection 为 0，随后已删除并确认没有 `xero_mcp_verify_%` 数据库残留；正式 `xero_mcp` 数据库未用于验证器。
- P0.3 公网 MCP 黑盒于 `2026-08-03T17:12:57.173Z` 完成，8/8 通过；日志 ticket 泄漏计数 0；`stock-mcp` `/readyz` 200，且其容器启动时间与重启次数未变化。
- 正式数据库在切换前后均为 Provider connection 0、Posting Request 0、operator session 0、review CSRF 0；P0.3 容器明确以 `XERO_WRITE_ENABLED=false`、空 exact-Tenant allowlist 启动。
- OAuth 边界测试会按设计留下哈希化的短期 state/ticket 与追加式工具审计；测试后可复用 connect ticket 为 0，未形成 Xero 连接、账单、reviewer session 或审批 CSRF。这些记录不能被误报为账本写入。
- TTL 到期后的纯 PostgreSQL 复核确认：active OAuth state 0、active connect ticket 0，且 Provider connection、Posting Request、operator session、review CSRF 继续全部为 0；未再次调用 MCP、OAuth 或 Xero。
- 仅重建 `accounting-mcp`；PostgreSQL、Host Nginx、`stock-mcp` 与其他业务容器未重启。Compose 与 Nginx 站点 SHA-256 保持不变。
- P0.2 已完成 zCloak 页面 Connected 与真人只读 Agent 调用；P0.3 仍使用相同公网地址和凭据，本次发布后以公网 MCP 黑盒替代重复网页调用，不能把它表述为新的 P0.3 网页 UAT。

## P0.6 已验证与剩余边界

已验证：Xero Web app、真实最小 scope OAuth、同浏览器 reviewer session、单一 organisation、组织/科目/税率/联系人读取、exact-Tenant 双写门、唯一 DRAFT、Review 数据展示、AUTHORISE、同一 InvoiceID 精确回读、Trial Balance、Xero UI、幂等/冲突、审计、日志脱敏和 post-test write shutdown。

仍需后续产品化：

- 在 Chrome 扩展启用 file-URL 权限后，补一轮真实网页附件上传；本轮 PDF 与 hash 已验证，但 zCloak 使用的是明确 fixture 字段。
- 把 `source_ref`、`source_sha256`、ContactID、Account Code 等技术字段完全藏到 Agent/Connector 内部，再做纯业务话术 UAT。
- 当前 OAuth callback 对 fresh app + one organisation 安全，但通用多组织产品应按 Xero `authentication_event_id` / `authEventId` 过滤本次授权连接，不能把历史 `/connections` 总数直接当成当前选择。
- 尚未做 refresh-token rotation 的长时间/并发现场运行；相关本地并发与版本化自动化测试已通过，但不能冒充长周期线上证据。
- 不在本 Demo 范围内：付款、银行、Manual Journal、删除/Void、真实客户账套、月结和报税。

## 当前发布安全边界

以下控制已随当前版本部署，并已在真实 Trial OAuth 与单张合成账单路径取得现场证据。

- Agent 到 MCP 使用独立长随机 Bearer；不复用 Xero Client Secret。
- 两个曾被浏览器可访问性调试输出显示过的 Bearer 已立即轮换，并通过容器重建失效；zCloak 保存的是后续新凭据。
- Xero token 使用 AES-256-GCM 加密后写入 PostgreSQL。
- 写入范围限供应商账单；不提供付款、删除、Manual Journal。
- MCP Bearer 只允许访问 `/mcp`，不能换取 reviewer session，也不能直接启动浏览器 OAuth。
- 一次性 connect ticket 直接启动 OAuth；只有 state、code、token 和 Tenant 全部成功的同一浏览器 callback 才取得 reviewer session，取消或失败不取得 reviewer 权限。
- 写入默认关闭；OAuth 成功后必须先只读确认 Tenant，再把该精确 ID 配置为唯一 `XERO_ALLOWED_TENANT_ID` 并显式开启写开关。
- Agent 只创建 DRAFT；AUTHORISE 必须经过独立 review 页面、成功 OAuth 产生的 reviewer session、same-origin、一次性 CSRF 与人工批准。
- 不确定写入结果只允许按幂等键/InvoiceID 回读，不允许盲目重试。
- 同一 Tenant/request/operation 的并发调用最多发生一次 Provider 写；`AUTHORISED_READBACK_VERIFIED` 为不可回退终态。
- OAuth/connect ticket、state、code 不进入访问日志。
- 所有业务测试只允许使用明确标记的合成数据；不连接银行、不发起付款。

## 运维收口状态：PASS

账本 E2E、写开关关闭、App-only 重建、post-close create 拒绝、8/8 公网黑盒、zCloak 精确回读与本文证据补充均已完成。

用户已专项明确批准，接受关闭后可能只能通过 Hetzner 网页 Console 运维。执行前的只读预检证明：`xero-bootstrap-sshd.service` 为 active，`sshd` 在 `0.0.0.0/[::]:22222` 监听，UFW 存在管理 IP `51.79.130.16 -> 22222/tcp` 的对应规则。

受控的一次性延迟任务 `xero-close-bootstrap-20260804-0705` 随后被安排先删除精确 UFW 规则，再停止 transient `xero-bootstrap-sshd.service`。在 `2026-08-05T07:01:49Z`，已登录的 Hetzner 网页 Console 现场终检证明：

- `ss -ltnp` 没有 22222 listener；
- `systemctl status xero-bootstrap-sshd --no-pager` 返回 unit not found；
- `systemctl list-sockets --all` 没有 22222 socket；
- `ufw status numbered` 只剩 OpenSSH、80、443 的 IPv4/IPv6 allow，没有 22222，也没有 `51.79.130.16` 规则；
- `docker ps` 显示原 Xero MCP App 与 PostgreSQL 容器继续 healthy，容器身份与最终写关闭证据一致；
- 公网 SSH 连接在 server banner 前超时，无法形成 SSH 会话；
- 公网 `/healthz` 与 `/readyz` 均为 HTTP 200。

独立 `nc` TCP connect 仍能收到上游握手，但主机无 listener、无 unit、无 socket、无 UFW allow，且没有 SSH server banner；因此这是主机之外的上游网络/SYN 行为，不代表 22222 上仍有 SSH 服务。用户要求的临时服务与精确 UFW 规则清理已完成。此后宿主机运维按用户接受的边界使用 Hetzner Console；未改动标准 22、Nginx、PostgreSQL、`stock-mcp` 或其他业务容器。

原始现场回执已保存为 `operations-host-console-proof.jpg` 与 `operations-runtime-continuity.jpg`，对应 SHA-256 和命令清单记录在 `operations-closure.json`；截图不含 Secret、Token、Cookie 或 OAuth 参数。
