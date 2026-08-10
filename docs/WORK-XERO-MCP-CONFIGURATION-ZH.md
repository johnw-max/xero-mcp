# Work 配置 Xero MCP

核对日期：2026-08-10

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
| Client ID | `work-xero-f70c2c68107535c1` | 当前 Work 测试连接的公开标识 |
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

## Client Secret 怎么交接

当前实现已经是 confidential OAuth client，存在 Client Secret 机制，不需要再额外开发一套。Secret 至少使用 32 个随机字节，只保存在：

1. Work 的 MCP Server 安全配置；
2. MCP 服务端的 Secret Manager 或权限为 `0600` 的部署环境文件。

Secret 不进入 Agent 提示词、聊天、飞书文档、GitHub、截图或普通日志。开发接手时，应在公司密码管理工具中重新生成并双端更新，不继续长期使用个人测试 Secret。

## 多个人如何使用

需要区分“共享一套正式连接”和“当前 Personal POC”：

- **当前测试版：** `PERSONAL_POC_ONLY=true`，Host 没有提供可验证的 Work 用户/工作区身份。不要让多个真人共用上面的 Client ID 和 Secret；同一 OAuth client 的重新授权会替换其原有 grant，且不能据此证明团队级隔离。
- **短期多人验收：** 为开发 1、开发 2、老板分别分配独立的 `client_id`、`client_secret` 和 Work Redirect URI，并把多个 client 同时登记到 `HOST_OAUTH_CLIENTS_JSON`。每个人再用自己的 Xero 账号完成 OAuth 和 Organisation 选择。现有代码支持多个预注册 Host client 并行存在。
- **正式产品：** 由公司 Work 环境统一配置和管理 MCP client，并补齐 Work 签名的 user/workspace/installation identity；关闭 Personal POC 模式后，同一共享连接才可安全承载多个用户各自的 Xero installation。Client Secret 由平台管理员配置一次，普通会计只点击 Connect，不接触 Secret。

多 client 的服务端格式如下。示例中的 Secret 必须在公司环境重新生成：

```json
[
  {
    "name": "Work production",
    "client_id": "work-xero-production",
    "client_secret": "REPLACE_WITH_AT_LEAST_32_RANDOM_BYTES",
    "redirect_uris": [
      "https://work.zcloak.ai/api/mcp/REPLACE_WITH_SERVER_IDENTIFIER/oauth/callback"
    ]
  },
  {
    "name": "Work developer acceptance",
    "client_id": "work-xero-developer-acceptance",
    "client_secret": "REPLACE_WITH_A_DIFFERENT_SECRET",
    "redirect_uris": [
      "https://work.zcloak.ai/api/mcp/REPLACE_WITH_ANOTHER_SERVER_IDENTIFIER/oauth/callback"
    ]
  }
]
```

## 配置后的最小验收

1. 点击 Connect，确认进入 Xero 官方 OAuth 页面，而不是要求用户粘贴 Token。
2. Xero 返回后，在 zCloak AI 页面明确选择一个 Organisation。
3. 回到 Work，用 Agent 读取 Organisation 名称和本位币；答案必须来自本轮 MCP 回执。
4. 在对话中要求“换一家公司”，确认 Agent 返回一次性选择链接；页面确认后必须重新读取 Organisation。
5. 两个独立测试 client 同时保持各自连接，互不替换；全程保持 `XERO_WRITE_ENABLED=false`。
