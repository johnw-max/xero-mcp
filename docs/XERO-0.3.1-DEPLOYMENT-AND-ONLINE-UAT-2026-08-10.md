# Xero MCP 0.3.1 发布与线上 UAT

核对日期：2026-08-10  
结论：`DEPLOYED / 44 TOOLS / AGENT2 SWITCH PASS / WORK CORE PASS / OFFICIAL LOGO PASS / ZERO WRITES`

## 固定版本

| 项目 | 固定值 |
|---|---|
| 应用版本 | `0.3.1` |
| 构建 | `20260810.2` |
| 镜像 | `xero-accounting-mcp-demo:0.3.1-xero-pilot-20260810.2` |
| 镜像 ID | `sha256:2bc0ba493415a3e7e8b5c801d9466ce0b906eb992fd349d725434fd82058c7e9` |
| 工具数 | 44 |
| 工具集 SHA-256 | `d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224` |
| Release 目录 | `/opt/xero-accounting-mcp-demo-0.3.1-20260810.2` |
| MCP 地址 | `https://mcp.jiayuanwang.xyz/mcp` |

Secret、旧个人域名、禁止路径扫描均为 0。公网 `/healthz` 返回 `status=ok`、`version=0.3.1`、`toolCount=44` 和上述工具集指纹。

`20260810.2` 仅替换授权页 Xero 品牌资产和显示容器：使用 Xero 官方 1000×1000 透明 PNG；业务工具、OAuth 协议、Organisation 绑定和数据模型均未变化。样式修订通过完整回归 819/819、类型检查、17/17 OAuth 页面聚焦回归、构建和线上桌面/390px 移动端验证。详见 [Xero 官方 Logo 上线记录](XERO-0.3.1-OFFICIAL-LOGO-RELEASE-2026-08-10.md)。

## 发布前验证

| 检查 | 结果 |
|---|---|
| TypeScript 类型检查 | PASS |
| 构建 | PASS |
| 默认完整回归 | 819 PASS；52 条条件跳过 |
| 强制 HTTP/OAuth 回归 | 3/3 PASS |
| 全新 PostgreSQL 17 强制集成回归 | 49/49 PASS |
| 静态部署与发布包校验 | PASS |

条件跳过不被当作数据库或 HTTP 发布证据；对应强制套件已经单独执行通过。

## Agent2 验收

通过会话：<https://agent2.zcloak.ai/c/c96595b4-1084-4f9f-8640-3634c044e54f>

1. 普通会计话术要求确认账套和重点往来款；Agent 实际调用 Organisation、应收与应付工具，回读 `Demo Company (Global)`、USD，并给出真实单据结果。
2. 用户要求切到 zcloak；Agent 调用 `xero_start_organisation_switch`，返回短效一次性链接。
3. 用户在 MCP 页面明确选择 zcloak；页面成功确认后，Agent 重新调用 `xero_get_organisation`，回读 `zcloak`、HKD。
4. 同样流程切回 Demo Company；Agent 再次回读 `Demo Company (Global)`、USD。
5. build `20260810.1` 复验了新版授权页：zCloak AI 品牌独立位于卡片外，Xero 请求、当前公司、Organisation 选择和主操作位于单一卡片内；390×844 视口的 `scrollWidth=390`、`scrollHeight=844`，无水平或垂直溢出，浏览器 console 无 warning/error。

因此已证明：聊天文字不能静默切账套；用户必须在 MCP 页面确认；确认后 Agent 必须以新工具回执为准；最终演示状态已恢复。

## Work 验收

通过会话：<https://work.zcloak.ai/c/0168a366-773f-405b-b067-9ede601637d6>

1. 线上 Agent 已替换为 11 个无 UAT 后缀的复式记账 Skills，并合并部署专用 Agent instructions；9 个旧 UAT Skill 已删除。
2. 在全新会话中，Agent 先加载 `accounting-workflow-coordinator`，再调用 `xero_get_organisation`、应收与应付读取，回读 `Demo Company (Global)`、USD、Ridgeway University `INV-0025` 与 SMART Agency `SM0210`。
3. `xero_get_organisation` 工具回执已显示 0.3.1 read-evidence envelope，包括 `fact_origin=MCP_READ`、`capability_id=ledger.target.resolve`、安全 target/binding reference、查询边界与 hash；不再只返回裸 `{result: ...}`。
4. Trial Balance 与银行流水首轮出现过度推断后，已在 Agent instructions 中新增硬边界并重开会话复验。修复后只报告 Historical Adjustment、银行交易状态和银行科目余额为待复核事项，明确说明成因拿不准、需要总账明细或银行对账单，不再声称异常、已对账或无影响。
5. 用户说要换公司时，Agent 调用 `xero_start_organisation_switch` 并返回一次性安全链接；新版页面列出 Demo Company 与 zcloak，当前公司保持 Demo Company，未在 Work 验收中执行切换。

## 运行与安全状态

- `XERO_WRITE_ENABLED=false`；本轮没有调用 prepare、execute、create、update、approve、authorise、pay、post、reconcile、delete 或 void。
- build `20260810.2` 的开机 write-gate failsafe 已启用，状态为 active/success；上一 build 的冲突 unit 已停用，写入开关保持 false。
- QuickBooks、共享 PostgreSQL 和 Stock MCP 在本次部署中未重启，RestartCount 均为 0。
- Agent2 与 Work 使用独立 OAuth client / installation；一个 Host 的重新授权或 Organisation 切换不会覆盖另一个 Host 的 current binding。
- 治理事件保存版本化身份、范围、行为、处置、结果和 hash 链证据；不保存 Token、原始 Prompt、Chain of Thought 或完整用户材料。

## 产品结论

当前版本已经达到受控 Demo 的只读与多 Organisation 切换目标：会计可以在 Agent2 或 Work 连接自己的 Xero，读取当前公司的存量账务，并通过对话获得安全切换链接。它仍是 Personal POC，不等于多人生产写入系统。

进入公司生产前仍需：迁移到公司控制的域名、密钥和基础设施；完成 Host 级签名确认、多用户隔离、监控告警、备份恢复和滚动发布演练；对计划开放的每类写入逐一取得真实 Xero ID、Provider 回执与同 ID 回读。
