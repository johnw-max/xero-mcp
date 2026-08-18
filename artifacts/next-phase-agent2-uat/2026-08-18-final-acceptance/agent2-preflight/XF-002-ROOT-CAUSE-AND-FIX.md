# XF-002 根因与修复：Agent2 客户端错配

## 悬了多轮的症状

「Agent2 client-ID mismatch」，原因不明，线上 UAT 从未走完。

## 精确根因

| 位置 | client_id |
|---|---|
| Agent2 连接器发起授权用的 | `agent2-xero-58751518d3dea403` |
| 凭据文件配发给 Agent2 的 | `agent2-xero-58751518d3dea403` ✅ |
| **主机 env 注册的** | `agent2-xero-bd0796db041ee01e` ❌ |

**两边回调地址完全相同**（`https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback`），
所以从任何一侧单独检查都像是配好了。授权一发起就 `invalid_client`。

主机上 Work 那条是新一代（`work-xero-58751518d3dea403`），说明换代时
**只更新了 Work，漏了 Agent2**。这个错配至少从 042 那一代就存在。

## 修复过程中连带暴露的三处

一处配置漂移牵出一串，每一处都得单独修：

1. **`docker restart` 不会重读 `--env-file`。** env 在创建容器时就固化了。
   改完文件必须 `rm` 后重建，否则文件对了容器里还是旧的——排查时极具误导性。
2. **客户端条目缺 `name` 字段** → 启动校验失败。而且 `name` 要求唯一，
   所以不能简单地新增一条同名的：旧那条本就是废弃的，正确做法是**退役它**
   而不是并存。
3. **两个 client-ID allowlist 仍指向旧客户端**
   （`OAUTH_MANUAL_RETURN_CLIENT_IDS`、`OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS`），
   退役旧客户端后它们就成了悬空引用，启动校验拒绝。一并改指新客户端。

值得注意的是：这三处**每一处都被启动期校验挡住了**，没有一处是靠运气发现的。
配置校验在这里发挥了它该有的作用——fail closed 而不是带病启动。

## 修复后的验证

授权流程从 `invalid_client` 变为正常进入 Xero 登录页 → 同意页。

### 顺带取得 XF-003 的收口证据

授权 URL 与 Xero 同意页共同确认了 scope 收窄真实生效：

**可管理（写）**：Contacts、Invoices
**仅查看（读）**：Organisation settings、Payments、Bank transactions、
Manual journals、Trial balance reports

`accounting.manualjournals` 与 `accounting.settings` **只出现在读的一侧**，
写权限确实没有申请。这是 XF-003 一直缺的那份「实际授予 scope」证据。

## 当前状态与剩余

Xero 同意页的账套下拉列出两个：`zcloak`（正式账套）与
`Demo Company (Global)`，均标注 "Already connected"。

写闸仍关闭。候选身份核验通过且未变
（`buildIdentityHash 5bccb0e9…`，`requiredMigration 041`）。

**MFA 设置这一步我没有代做**——绑定认证器属于账号安全设置，且后续验证码
需要真人设备。Xero 提供了 "Not now" 跳过，本次走的是跳过路径。
