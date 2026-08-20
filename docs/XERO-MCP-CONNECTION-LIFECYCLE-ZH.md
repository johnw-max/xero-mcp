# Xero MCP 连接生命周期（通俗版）

核对日期：2026-08-10

## 一句话结论

Xero 的 30 分钟不是“30 分钟后用户被踢下线”，而是 Xero 上游短时 Access Token 到期；MCP 会在服务端自动续期。Work/Agent2 自己拿到的 MCP Token 另有更短的 Access Token 和 30 天滚动闲置期的 Refresh Token。用户可以随时主动断开，闲置过期后也可以用同一身份重新连接。

## 三层凭证不要混在一起

| 层级 | 默认时效 | 到期后行为 | 用户是否通常要重新登录 |
|---|---:|---|---|
| Xero Access Token | 约 30 分钟 | MCP 服务端用 Xero Refresh Token 自动续期 | 否 |
| Xero Refresh Token | 最多 60 天未使用；每次刷新会轮换 | 有效时由服务端安全保存新 Token；连续未使用到期后需重新授权 Xero | 仅闲置到期或被 Xero 撤销时 |
| Work/Agent2 → MCP Access Token | 15 分钟 | Host 用当前有效的 MCP Refresh Token 换新 | 否 |
| Work/Agent2 → MCP Refresh Token | 30 天滚动闲置窗口 | 正常使用会轮换并重置 30 天；连续 30 天未续期后不能再换新，需要重新连接 | 仅闲置到期时 |

Xero Refresh Token 的上游策略由 Xero 管理；本项目不把它暴露给 Agent 或浏览器，也不把 Xero Token 存进对话。

## 同一会计如何切换代理公司

用户不需要先理解 MCP 管理页或手动断开连接。对于同一 Xero OAuth 已经授权的 Organisation，可以直接在对话里说“切换到某某公司”：

1. Agent 调用 `xero_start_organisation_switch`，返回 10 分钟有效的一次性确认链接；
2. 用户在 MCP 自己的页面中明确选择一家 Organisation；
3. MCP 原子更新该 installation 的当前 binding；
4. Agent 重新读取连接状态，确认公司名称后继续工作。

Agent 不能仅凭聊天文本静默切换，也不能把用户上传文件中的公司名当成授权。目标 Organisation 不在当前已授权列表时，才需要重新走 Xero OAuth。详细控制见 [Organisation 切换与治理审计设计](./XERO-ORGANISATION-SWITCH-AND-GOVERNANCE-AUDIT-ZH.md)。

2026-08-10 线上验收已证明：同一个 Agent2 installation 可以从 `Demo Company (Global)` 切到 `zcloak`，按工具回读得到 HKD，再切回 Demo Company 并回读 USD；Work 的独立 OAuth client 同时保持自己的 Demo Company binding，不会被另一个 Host 的切换覆盖。

## 主动断开做什么

产品的“断开 Xero”调用标准 OAuth `/revoke`，优先提交当前 MCP Refresh Token：

```text
撤销当前 refresh family
  -> 撤销该 family 派生的 MCP Access Tokens
  -> 撤销当前 installation 与 binding
  -> 旧会话立即不能再调用 MCP
```

默认不调用 Xero 的全局 Token revoke，也不删除服务端 Xero provider authorization/connection。原因是用户要断开的是“这个 Work/Agent2 installation”，不是默默把同一 Xero app 的其他连接一起撤掉。

## 自然过期与重连

- Access Token 到期会在鉴权时直接失败，不会因为数据库行仍显示 ACTIVE 而继续可用。
- MCP Refresh Token 每次正常使用都会轮换并重新获得 30 天闲置窗口；若连续 30 天没有续期，到期后不能再轮换，服务端会把对应 installation、binding、refresh family 和派生 Access Token 收口为撤销状态。
- Personal POC 在同一用户、同一 Agent、同一 OAuth client 再次连接前，会原子清理已经没有可用 Refresh Token 的旧本地 installation，避免旧 ACTIVE 状态阻塞重连。
- 清理本地 MCP grant 时保留 Xero provider authorization/connection；只有 Xero 本身的授权确实无效时，才要求用户重新走 Xero consent。

## 如何测试

1. **短时 Access Token：** 用可注入时钟推进 15 分钟，证明旧 Access Token 被拒绝、有效 Refresh Token 能轮换。
2. **30 天闲置过期：** 在隔离 PostgreSQL 测试库推进到当前 Refresh Token 的过期点，证明旧 Refresh Token 为 `invalid_grant`、派生 Access Token 失效、同身份可重连；另证明正常轮换会签发新的 30 天窗口。
3. **主动断开：** 调 `/revoke`，证明旧 Access/Refresh Token 立即失效，而 Xero provider authorization/connection 保留。
4. **replay：** 重用已经消费的旧 Refresh Token，撤销整个 family，并要求重新连接。

生产环境不增加“把任意用户 Token 立即改成过期”的后门。主动断开用标准 `/revoke`；自然过期用测试时钟验证。

## 当前产品边界

- 30 天是当前 MCP Refresh Token 的滚动闲置期，不是活跃连接的绝对寿命，也不代表每 30 天必然重新弹出 Xero consent；若服务端 Xero 授权仍有效，只需重建 Work/Agent2 installation。
- 数据库是授权、幂等与审计控制面，不是 Ledger；Xero 仍是正式账本。
- Demo 可以用数据库保持重启后的连接状态。正式平台可替换为已有的通用 OAuth/Connector 存储，只要保留精确 installation/binding、加密 Token、原子 rotation/revoke 和审计语义。
- Organisation 切换后，旧 binding 只作为历史授权和 token family 证据保留，不再是运行时 current binding；旧账套上的未完成准备不能在新账套执行。
