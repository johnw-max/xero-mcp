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
