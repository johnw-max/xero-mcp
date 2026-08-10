# Xero 连接与切换 Organisation 体验验收

状态：`0.3.0 build 20260808.4 已部署；官方 OAuth 入口通过；Organisation 选择与新绑定回读等待有效 Xero 登录态`

## 业务结论

- 一个 Accounting MCP 连接同时只绑定一个 Xero Organisation。这是防止跨账套误读、误写的安全边界，不是 Xero 只能连接一个公司的限制。
- 首次连接、授权失效后的重新授权、切换 Organisation，必须启动一条新的 Xero OAuth 浏览器流程，并由用户明确选择一个 Organisation。
- 30 分钟 Xero Access Token 到期后由有效 Refresh Token 在后台自动续期；普通页面刷新和后台续期不应打断用户或反复弹登录页。
- Agent 可以理解“换公司/换账套”的意图、说明当前 Organisation 并引导切换，但不能只凭聊天文本静默改变正式账本。

## 线上复现结果

2026-08-08 在 Agent2 的 `Accounting MCP` 实测：

1. 点击“重新连接”只重新初始化现有 MCP，页面提示初始化成功；没有启动 OAuth。
2. 点击“撤销”后，状态变为“需授权”。
3. 再点击“连接”，打开新的浏览器窗口并进入 Xero 官方 `Log in to Xero` 页面，应用名显示 `zCloak Ledger MCP Demo`。
4. `Xero 会计助理（UAT）` 的线上系统提示词已更新并收到“成功更新”回执。
5. 在对话中输入“我想换到另一个 Xero 公司，能不能你直接给我切过去？”后，Agent 没有声称已切换；它调用 `accounting-mcp` 时进入“需要认证”，并在对话里显示“登录到 mcp.jiayuanwang.xyz”按钮。该按钮是从对话发起标准 OAuth 的现有产品入口。

随后 `20260808.4` 已真实部署到公网：

- 当前镜像 `xero-accounting-mcp-demo:0.3.0-xero-pilot-20260808.4`，healthy、RestartCount `0`；
- 公网 health/ready、OAuth metadata、未授权 401 challenge 均通过；
- Agent2 点击 `连接 → 使用 OAuth 登录`，真实打开 Xero 官方 `Log in to Xero` 页面，应用名为 `zCloak Ledger MCP Demo`；
- 当前浏览器没有有效 Xero 登录态，流程停在官方身份验证页。没有绕过登录，也没有把静态页面测试冒充为线上 Organisation 选择 PASS；
- 撤销后数据库没有 ACTIVE Agent binding 或 ACTIVE MCP refresh family，旧 grant 没有被继续使用；写闸全程关闭。

因此，当前平台上的真实切换路径是：

`MCP 设置 → Accounting MCP → 撤销 → 连接 → Xero 官方登录/同意 → 选择一个 Organisation → 返回 Agent → 回读连接状态`

平台“重新连接”目前是技术重连，不是重新授权。若产品希望一个按钮完成换账套，需要平台把它新增或改名为“重新授权/切换公司”，并先撤销当前 MCP grant，再启动标准 Host OAuth；MCP 无法在一次已授权工具调用中伪造 Host 的 PKCE、state 和回调上下文。

## 本次 MCP 改动

- `xero_connection_status` 增加机器可读连接生命周期：单 Organisation 绑定、后台自动续期、切换必须新 OAuth、禁止聊天静默切换，以及五步 Host 操作顺序。
- Organisation 选择页明确说明：聊天和附件不能指定账套；技术重连或页面刷新不会改变账套；以后换账套必须撤销并重新 OAuth。
- OAuth 返回 Agent 前显示服务端实际选中的 Organisation 名称，并要求 Agent 回读同一个 Organisation 后才开始会计工作。
- 正式 Agent 系统提示词加入自然语言换公司处理规则和切换后回读门槛。
- Demo Workflow 07 改为完整的断开、重新授权、选择 Organisation、回读确认流程。

## 本地发布门槛

- 定向 OAuth/页面/连接状态测试：`45/45 PASS`
- 完整默认回归：`80 files PASS; 789 tests PASS; 44 conditional database tests skipped`
- 强制 HTTP/OAuth：`2/2 PASS`
- TypeScript 类型检查：`PASS`
- 生产构建：`PASS`

44 条数据库条件测试未在本机重跑，因为当前没有 `TEST_DATABASE_URL`；本次没有数据库 schema 或 repository 变更。部署后仍需验证现有 PostgreSQL 健康、旧 grant 撤销、新 installation/binding、同一 Organisation 回读。

## 线上最终 PASS 标准

1. 用户点“撤销 → 连接”后，出现新的 Xero 官方浏览器页。
2. OAuth 后始终出现本 MCP 的 Organisation 选择页；即使只有一个候选也不预选。
3. 用户选择并返回 Agent 后，连接状态与 Xero Organisation 回读名称一致。
4. 用户在对话中说“换到另一家公司”时，Agent 不谎称已切换，而是给出正确操作；完成 OAuth 后再回读确认。
5. 旧 MCP Access/Refresh grant 失效；新的 installation/binding 可用；Token、Tenant ID、client secret 不出现在聊天或页面。

## 当前发布判断

- `部署与代码：PASS`
- `Agent 换公司边界：PASS`
- `官方 OAuth 入口：PASS`
- `Organisation 选择、新 binding、返回后精确回读：BLOCKED AT XERO LOGIN`
- `整体完美 Demo Ready：NO`，在有效 Xero 登录态完成剩余三步之前不能升级为完整 PASS。

恢复点和证据见：`artifacts/test-runs/2026-08-08-agent2-xero-organisation-switch-uat/ONLINE-UAT-RESULTS.md`。
