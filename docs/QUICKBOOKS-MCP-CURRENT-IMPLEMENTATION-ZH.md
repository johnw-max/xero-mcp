# QuickBooks 与 Xero MCP：官方能力、自建范围和当前进度

版本：v0.1  
核对日期：2026-08-05  
线上验收环境：`https://agent2.zcloak.ai`（测试环境，不是某个 Agent 的名称）

## 一句话结论

用户设想的主流程是可行的：

> 会计在 Work/Agent2 对话 → 连接自己的 Xero 或 QuickBooks → Agent 读取历史账务 → 会计加入材料 → Agent 核对、分析并准备录入 → 人工确认关键写入 → 会计软件保存正式账目 → Agent 精确回读。

但“安装官方 MCP”只能解决会计 API 的一部分。要变成 Work 上可给真实用户使用的产品，我们还必须自己做用户连接、多人隔离、材料证据链、人工审核、防重复和回读审计。

当前准确状态：

- **Xero**：单一 Trial 账套的受控核心账本链路已经真实跑通；多材料自动进入和多用户自助连接仍待补齐。
- **QuickBooks**：受控服务、9 个 MCP 工具、OAuth、Token 加密、人工 Review Gate、防重复和精确回读已在本地完成并通过自动化测试；Intuit Development App 和 Sandbox 已创建，尚未保存我们的 callback、注入 Development credentials 或完成线上真实验证。
- **Agent2**：确定作为 QuickBooks 首个线上部署和 UAT 环境；生产环境不动。

## 官方 MCP 的差别，通俗版

| 比较项 | QuickBooks 官方 MCP | Xero 官方 MCP | 对我们的实际影响 |
|---|---|---|---|
| 官方提供方式 | Intuit 官方开源仓库；当前说明为本机运行的 stdio MCP | Xero 官方开源仓库；示例也是在 Claude Desktop 里用 `npx`/Node 启动 | 两者都不是开箱即用的 Work 多用户远程服务 |
| 工具广度 | 很宽：官方 README 当前列出 144 个工具、29 类对象 CRUD、11 张报表 | 较聚焦但也覆盖读取、创建、更新、付款、手工日记账和部分 Payroll | QuickBooks 官方版本更像“把大部分 API 暴露给 Agent”；我们的产品不宜原样全开 |
| 默认连接模型 | Client ID/Secret、Refresh Token、Realm ID 放在本机环境；一次绑定一个 QBO Company | 支持 Custom Connection；也支持外部传入 Bearer Token，文档明确用于运行时多 Xero 账户 | Xero 官方包更容易被我们放在自建 OAuth Broker 后面；两边仍需自建用户绑定层 |
| 权限粒度 | Accounting API 主要是一个很宽的 `com.intuit.quickbooks.accounting` scope；授权后能否调用某对象主要由我们服务端控制 | Xero 已提供更细的 accounting invoice/payment/report 等 scope；2026 年后的 Custom Connection 也支持更细权限 | QuickBooks 必须更依赖我们自己的工具白名单和审批门；不能只靠 OAuth scope 保安全 |
| 禁用危险动作 | 官方包可用环境开关整体隐藏 create/update/delete 类工具 | 官方包按取得的 Xero scopes 和已注册工具工作 | QuickBooks 官方开关有用，但仍不等于“逐公司、逐用户、逐任务审批” |
| 历史账务读取 | 公司、供应商、Bill、Invoice、Payment、总账及报表等覆盖很广 | 联系人、发票、付款、Bank Transaction、Trial Balance、P&L 等 | 两边都能支持“查历史后分析” |
| 写入方式 | 可直接 create/update/delete Bill 等对象 | 可 create Invoice/Credit Note/Payment/Manual Journal 等，也能更新草稿类对象 | 官方工具会直接改正式系统；缺少我们需要的材料证据、人工 Review 和业务状态机 |
| “草稿”语义 | QBO Bill 没有可直接照搬 Xero 的 DRAFT 审批语义；创建 Bill 就已经写入 QBO | Xero Invoice/Bill 支持 DRAFT，适合先生成草稿再审批 | QuickBooks 必须先在我们这里保存 `PREPARED`，人工点击后才创建 QBO Bill |
| Sandbox / Demo | Intuit Developer Portal 可建 Sandbox Company，不收费 | Xero Trial/Demo Company 可用于测试 | 都能免费做验证，但都必须先完成开发者账号和 OAuth App 配置 |
| 材料上传与理解 | 不负责 | 不负责 | PDF、图片、表格的上传、解析、来源定位和冲突判断由 Work/Agent 与我们自建服务完成 |
| 多用户 Work 产品 | 不负责 | 不负责 | 这是我们必须自建的核心层 |

官方依据：

- [Intuit QuickBooks Online MCP Server](https://github.com/intuit/quickbooks-online-mcp-server)
- [Xero MCP Server](https://github.com/XeroAPI/xero-mcp-server)
- [Intuit Accounting API scopes](https://developer.intuit.com/app/developer/qbo/docs/learn/scopes)
- [Intuit Sandbox 管理](https://developer.intuit.com/app/developer/qbo/docs/develop/sandboxes/manage-your-sandboxes)

## 哪些可以直接利用官方能力

### 两边都可以直接利用

- 官方 OAuth 和正式 Accounting API；
- 公司、联系人/供应商、科目、税码、历史交易和财务报表读取；
- 创建或更新会计对象的底层 API；
- Sandbox、Trial 或 Demo Company；
- 官方对象结构、错误码和限流规则。

### QuickBooks 官方 MCP 特别省事的地方

- API 覆盖范围非常广，查 Bill、Invoice、Payment、Vendor、总账和报表都已有现成参考实现；
- 有 create/update/delete 整体禁用开关；
- 本地单公司、开发人员自用场景可以很快跑起来。

### Xero 官方 MCP 特别省事的地方

- 已把常见 Xero 会计对象整理成 MCP 命令；
- Scope 比 QuickBooks 会计总 scope 更细；
- 官方 README 已考虑由外部 OAuth/PKCE 客户端提供 Bearer Token、多账户运行时切换的方式。

## 哪些必须我们自己做

| 自建项 | 通俗解释 | 当前情况 |
|---|---|---|
| 远程 MCP 服务 | 官方示例主要跑在个人电脑；Work 需要通过 HTTPS 调用我们的长期服务 | Xero 已有；QuickBooks 已完成本地 HTTP 服务，待部署 Agent2 测试环境 |
| Work 用户与会计账套绑定 | Agent 不能靠自己填写 Realm ID/Tenant ID 换公司；连接必须由服务端认定 | Xero 演示有受控绑定；QuickBooks 已实现单连接解析，生产 OAuth Broker 绑定待接 |
| OAuth 连接入口 | 用户点“连接 QuickBooks/Xero”，在官方页面授权，Token 由服务端安全保存 | QuickBooks 已实现连接票据、state、回调、加密 Token 和 Refresh 轮换；待真实 App 验证 |
| 多用户、多公司隔离 | A 会计不能看到 B 会计或 B 客户的账 | 数据模型已按 actor/connection/realm 设计；尚未做 Agent2 多用户线上 UAT |
| 材料库和解析 | 接收 PDF、图片、表格，提取字段并保留页码/单元格位置 | Work 已能提供材料入口；QuickBooks MCP 目前只接收 `sourceRef + sourceSha256`，尚未接材料注册/解析桥 |
| 证据与冲突判断 | 说明每个字段来自材料、会计软件还是 Agent 推断；冲突时停止 | QuickBooks 写入结构已保存 source hash；完整 Source Bundle/字段证据仍需接共享材料层 |
| 小而安全的工具面 | 不把 144 个底层工具全部交给 Agent，只给真实会计流程需要的工具 | QuickBooks 当前只开放 9 个工具，其中只有“准备 Bill”，没有直接批准/付款/删除工具 |
| 人工 Review Gate | Agent 先准备，人查看金额、供应商、科目、税码和来源后点击确认 | QuickBooks 已实现；批准按钮在 Agent 工具之外 |
| 防重复与未知结果恢复 | 网络超时时不能重试出两张账；必须先查询原请求结果 | QuickBooks 已使用稳定 `requestid`、payload hash 和 `WRITE_RESULT_UNKNOWN` 状态 |
| 写后精确回读 | 只有重新读取同一个 QBO Bill/Xero Invoice 并核对字段后，才能说“已录入” | QuickBooks 已实现代码与测试，真实 Sandbox 待验收 |
| 审计和运维 | 记录谁、哪家公司、哪份材料、何时准备/批准/回读，不记录 Token | QuickBooks 已有数据库记录和安全日志；线上监控待部署 |

## QuickBooks 当前已经开发好的最小产品

### Agent 可调用的 9 个工具

1. `quickbooks_connection_status`：确认连接哪家公司；未连接时给一次性连接链接。
2. `quickbooks_get_company`：读取公司和本位币。
3. `quickbooks_list_accounts`：读取有效科目。
4. `quickbooks_list_tax_codes`：读取税码。
5. `quickbooks_search_vendors`：查供应商。
6. `quickbooks_list_bills`：按受限条件读取历史 Bill。
7. `quickbooks_get_bill`：按精确 ID 回读一张 Bill。
8. `quickbooks_prepare_supplier_bill`：只生成本地 Review 请求，不写 QuickBooks。
9. `quickbooks_get_trial_balance`：读取 Trial Balance，解释账本影响。

### 人工批准后发生什么

`PREPARED` → 人工网页审核 → 写入开关与允许 Realm 校验 → 使用稳定 `requestid` 创建一次 QBO Bill → 按同一 Bill ID 回读 → 核对供应商、日期、行金额、科目和来源标记 → `POSTED_READBACK_VERIFIED`

任何一步不确定，都不能提前告诉用户“已经录入”。

### 安全默认值

- `QUICKBOOKS_WRITE_ENABLED=false`；
- 即使临时打开写入，也必须精确匹配 `QUICKBOOKS_ALLOWED_REALM_ID`；
- Agent 只有 `quickbooks.read` 和 `quickbooks.bill.prepare`；
- 没有给 Agent 直接 create、approve、payment、delete、void 或 journal 工具；
- QBO Access/Refresh Token 加密保存，刷新时用版本号防并发覆盖；
- 连接票据、OAuth state、Review session 和 CSRF 都是一次性或短期凭证。

## 现在能否支撑用户设想的案例

| 用户步骤 | Xero | QuickBooks |
|---|---|---|
| 在 Work/Agent2 与会计 Agent 对话 | 平台能力可用 | 平台能力可用 |
| 用户连接自己的账套 | 单一 Trial 核心已验证；多用户自助化待完成 | 代码已完成，真实 Intuit App/Sandbox 尚未连通 |
| 读取客户历史数据 | 已有一组受控读取工具，但不是全对象覆盖 | 公司、供应商、科目、税码、Bill、Trial Balance 已实现 |
| Agent 分析历史与用户材料 | 对话分析可做；完整多材料自动证据链仍需补 | 同样；当前缺 Work 材料注册/解析到 QBO Proposal 的桥 |
| 帮用户录入 | Xero 可先建 DRAFT，再人工批准 | 本地 PREPARED，人工批准后才创建 QBO Bill |
| 写入后验证 | Xero 单账套已真实跑通 | 已有代码和自动化测试，待 Sandbox + Agent2 真实 UAT |

所以答案不是“已经全部可以”，而是：**核心架构和最小受控记账路径已经成立；QuickBooks 本地开发完成，差开发者账号、Sandbox、Agent2 部署、材料桥和真实线上证据。**

## 下一步与阻塞项

1. 已完成：Intuit Developer 账号、`zcloak` Workspace、QuickBooks Development App 和免费 Sandbox Company。
2. 已完成：Sandbox `9341457658718743`（US Plus，Accounting + Payments）和 Development credentials 生成；真实 secret 不进入文档或聊天。
3. 待保存：`https://mcp.jiayuanwang.xyz/oauth/quickbooks/callback`。
4. 在测试数据库运行 QuickBooks 两个 migration，部署独立 `quickbooks-mcp` 到 loopback `18003`；写入保持关闭。
5. 在 `agent2.zcloak.ai` 新建/配置 QuickBooks MCP，先验收连接和只读历史查询。
6. 只对 Sandbox Realm 临时开启 Bill 写入，完成“准备 → 人审 → 一次写入 → 精确回读”的真实证据。
7. 接 Work 材料引用、解析结果和 Source Bundle，再跑多材料会计案例。

在第 6 步通过前，不能对外说 QuickBooks 已经线上可录入；在第 7 步通过前，不能说“用户上传多份材料后可全自动入账”。
