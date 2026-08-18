# Work 配置 Xero MCP

核对日期：2026-08-11

## 当前测试环境可直接填写的内容

在 Work 打开 `Workspace tools → MCP Settings → Add MCP`，按下表填写：

| Work 字段 | 当前测试值 | 说明 |
|---|---|---|
| Icon | `src/oauth/assets/zcloak-app-icon.png` | 可选；建议使用 zCloak AI 图标，不把 Xero Logo 做成自有产品图标 |
| Name | `Xero Accounting MCP` | Work 中显示的连接名称 |
| Description | `Connects the accounting agent to Xero for account review, reconciliation support, and controlled draft preparation with human confirmation.` | 面向使用者的简短说明 |
| MCP Server URL | `https://mcp.jiayuanwang.xyz/mcp` | 当前个人测试地址；正式环境必须替换成公司域名 |
| Transport | `Streamable HTTPS` | 不选 SSE |
| Authentication | `OAuth` | 外层是 Work 到 MCP 的 OAuth，不是直接填写 Xero Token |
| Client ID | `work-xero-58751518d3dea403` | 2026-08-11 已完成线上 OAuth 与只读回读的 Work 测试标识 |
| Client Secret | 私下提供，不写入文档或 Git | Work 首次配置时填写；编辑页留空表示保留已有 Secret |
| Authorization URL | `https://mcp.jiayuanwang.xyz/authorize` | MCP OAuth 授权入口 |
| Token URL | `https://mcp.jiayuanwang.xyz/token` | MCP OAuth Token 入口 |
| Scope | `xero.read xero.draft.write` | `xero.draft.write` 只代表可进入受控草稿流程；服务端写闸仍可保持关闭 |
| I trust this application | 勾选 | 当前连接由 zCloak 团队自行部署和管理 |

当前已验证的 Unique Server Identifier 是 `zcloak-ledger-mcp-xero-demo`，Work 自动生成的 Redirect URI 为：

```text
https://work.zcloak.ai/api/mcp/zcloak-ledger-mcp-xero-demo/oauth/callback
```

Redirect URI 不是随意填写项。每次新增 MCP 后，应先复制 Work 实际显示的 Redirect URI，再由 MCP 部署管理员把这条完整地址加入对应 OAuth client 的 `redirect_uris`；字符、路径和结尾必须完全一致。

当前 Agent2 使用独立 Host client，不与 Work 共用 Secret：

```text
Client ID: agent2-xero-58751518d3dea403
Redirect URI: https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback
```

两边共用同一 MCP URL、Authorization URL、Token URL 和 Xero Developer App，但各自拥有独立 Host Client ID、Client Secret 和 callback allowlist。

内层 Xero OAuth 使用 Developer App Client ID `F5A3D33C975B47CB9FE3961A04FCA40C`，统一回调为 `https://mcp.jiayuanwang.xyz/oauth/xero/callback`。Xero Client Secret 只保存在服务器 Secret 源，不填写到 Work 或 Agent2。

## Client Secret 怎么交接

当前实现已经是 confidential OAuth client，存在 Client Secret 机制，不需要再额外开发一套。Secret 至少使用 32 个随机字节，只保存在：

1. Work 的 MCP Server 安全配置；
2. MCP 服务端的 Secret Manager 或权限为 `0600` 的部署环境文件；当前部署对应 `HOST_OAUTH_CLIENTS_JSON`。

Secret 不进入 Agent 提示词、聊天、飞书文档、GitHub、截图或普通日志。开发接手时，应在公司密码管理工具中重新生成并双端更新，不继续长期使用个人测试 Secret。

## 多个人如何使用

需要区分“共享 Host 应用凭证”和“共享某个人的 Xero 连接”：

- **短期多人验收：** 同一 Host 内可以由多个测试者使用同一组 Host `client_id`、`client_secret` 和 Redirect URI；不同 Host 应使用各自独立的一组凭证。服务端同时设置 `PERSONAL_POC_ONLY=true`、`SHARED_TEST_USERS=true`。Host 凭证只标识 MCP 应用；每次 OAuth 都创建独立 installation、access/refresh token family 和 Xero tenant binding，后一个测试者不会覆盖前一个测试者。
- **身份边界：** 早期测试模式没有 Work 签名的 user/workspace 身份，因此服务端给每次 installation 生成临时 subject。它能隔离 5–10 个测试连接，但不能把审计 subject 解释为已经验证的真实 Work 用户。
- **正式产品：** 由公司 Work 环境统一配置和管理 MCP client，并补齐 Work 签名的 user/workspace/installation identity；关闭 Personal POC 模式后，同一共享连接才可安全承载多个用户各自的 Xero installation。Client Secret 由平台管理员配置一次，普通会计只点击 Connect，不接触 Secret。

共享 Work client 的服务端格式如下。示例中的 Secret 必须在公司环境重新生成：

```json
[
  {
    "name": "Work production",
    "client_id": "work-xero-production",
    "client_secret": "REPLACE_WITH_AT_LEAST_32_RANDOM_BYTES",
    "redirect_uris": [
      "https://work.zcloak.ai/api/mcp/REPLACE_WITH_SERVER_IDENTIFIER/oauth/callback"
    ]
  }
]
```

## 配置后的最小验收

1. 点击 Connect，确认进入 Xero 官方 OAuth 页面，而不是要求用户粘贴 Token。
2. Xero 返回后，在 zCloak AI 页面明确选择一个 Organisation。
3. 回到 Work，用 Agent 读取 Organisation 名称和本位币；答案必须来自本轮 MCP 回执。
4. 在对话中要求“换一家公司”，确认 Agent 返回一次性选择链接；页面确认后必须重新读取 Organisation。
5. 用同一 Work client 完成至少两个独立用户的 OAuth，确认两条 installation、token family 和 Organisation binding 同时有效、互不替换；全程保持 `XERO_WRITE_ENABLED=false`。

2026-08-11 已用 Work 与 Agent2 两个独立 Host client 完成线上验收：Work 读取 `zcloak / HKD`，Agent2 读取 `Demo Company (Global) / USD`。完整证据见 `artifacts/test-runs/2026-08-11-shared-host-oauth-uat/`。

## “Xero 已授权，但返回 Work 后认证失败”怎么定位

这类现象不能笼统归为“Xero OAuth 失败”。完成 Xero 授权和 Organisation 选择，只证明内层 Xero 授权已完成；Work 还必须完成外层 MCP callback、authorization-code 交换和本地 flow/token 持久化。

排查时先记录失败时间（含时区）、Work 用户、MCP Server Identifier、浏览器地址栏最终的 `error` 名称和页面截图。不要记录或转发 `code`、`state`、Client Secret、Access Token 或 Refresh Token。然后用同一时间窗对照 Work 后端日志和 MCP Nginx 的脱敏访问日志：

| 观察结果 | 最可能失败阶段 | 处置 |
|---|---|---|
| Work callback 为 `invalid_state` 或 `csrf_validation_failed`，且 MCP `/token` 没有请求 | Work 的 OAuth flow/state、Cookie fallback、并发 reconnect 或共享 flow store | 核对 Work 是否包含 LibreChat 的 PENDING-flow/CSRF fallback 修复；多副本必须共享 flow store |
| MCP `/token` 返回 `401` | Work 保存的 confidential Client Secret 缺失、被覆盖或与 MCP 服务端不一致 | 管理员在 Work 和服务端成对轮换同一 Work client 的 Secret；普通用户不接触 Secret |
| MCP `/token` 返回 `400 invalid_target` | Work 显式传了错误的 MCP `resource`，或一个未获兼容批准的 Host 漏传 `resource` | 修 Host 请求或核对精确 client allowlist；即使允许省略，也只能补成唯一 canonical MCP resource，绝不接受错误值 |
| MCP `/token` 返回 `400 invalid_grant` | PKCE verifier、Redirect URI、client/code 绑定不一致，或 code 已过期/消费 | 检查 Work 是否复用了最初生成的 authorization URL 和 PKCE 对，而不是 reconnect 时生成第二套 |
| MCP `/token` 返回 `200`，Work 仍显示失败 | Work 没有完成 token/flow 持久化，或完成事件被后续 reconnect 覆盖 | 检查 Work 的 flow completion、token storage 和并发连接日志 |

LibreChat 上游已经修过两组与该症状高度相关的问题：

- [#12171](https://github.com/danny-avila/LibreChat/pull/12171)：新窗口/SSE 回调缺少 CSRF 或 session Cookie、陈旧 PENDING flow、并发连接及重认证失败；
- [#13532](https://github.com/danny-avila/LibreChat/pull/13532)：`/oauth/initiate` 重新生成 authorization URL，导致原 PKCE verifier/challenge 与回调不再匹配。

2026-08-14 至 15 日的同版本线上复现进一步把两层问题分开了：MCP 已完成 Xero consent、Organisation 选择并签发外层一次性 code，但 automatic direct-302 在测试浏览器中被客户端拦截，Work 没有继续请求 `/token`；一次失败后，Work/LibreChat 又可能长期停在 `Connecting`，即使重新登录也只重新读取 OAuth metadata、不再打开 `/authorize`。因此当前 Personal POC/UAT 的精确 Work client 与 Agent2 client 都配置在 `OAUTH_MANUAL_RETURN_CLIENT_IDS`，让用户点击 `Return to Work` 后以 GET 表单提交同一个注册 callback。这个兼容页不改变或绕过 `state`、PKCE、Redirect URI、一次性 code、client secret 或 token 校验。

`OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS` 与上述浏览器返回策略仍然完全独立：前者只处理特定 Host 省略 RFC 8707 `resource` 的兼容，后者只处理浏览器跳转。若 Work 已卡在 `Connecting` 且服务端同一时间窗没有新的 `/authorize`，应先在 Work 平台清理或重建该 connector 的陈旧 OAuth flow；继续重启 MCP、重复 Xero consent 或放宽 OAuth 校验都不会修复这个客户端状态。

因此，在没有同一失败时间窗的 Work/MCP 日志前，不应把问题直接归因给 Xero 或 MCP 服务端，也不应通过关闭 PKCE、忽略 `state`、接受错误 Redirect URI 或取消 `resource` 校验来“修复”。当前证据同时说明：MCP 端此前确有陈旧 reconnect 与浏览器 handoff 兼容缺口，已经在候选版本修复；Work 卡住且不再发起 `/authorize` 则是独立的平台状态机问题，需要 Work/LibreChat 侧清理。
