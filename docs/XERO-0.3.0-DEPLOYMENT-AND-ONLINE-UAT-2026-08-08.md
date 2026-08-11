# Xero MCP 0.3.0 部署与线上业务验收记录

核对日期：2026-08-08  
结论：`20260808.4 DEPLOYED / RUNTIME_AND_FAILSAFE_PASS / CORE .3 UAT RETAINED / ORGANISATION-SWITCH UAT PARTIAL / FRESH-CONNECT DEMO NOT READY`

## 1. 最终固定版本

| 项目 | 固定值 |
|---|---|
| 应用版本 | `0.3.0` |
| 最终构建 | `20260808.4` |
| 工具数量 | `43` |
| 工具集 SHA-256 | `a76bf853dc4bc71bf33e5b42f936fbcc9d6593d67d23e40dedccc4d1e2ae5d65` |
| 镜像 | `xero-accounting-mcp-demo:0.3.0-xero-pilot-20260808.4` |
| 镜像 ID | `sha256:318a9915ad10f0dcfdb51d1436492e058161af5b0c817517a4687a8d470bbcde` |
| Release 目录 | `/opt/xero-accounting-mcp-demo-0.3.0-20260808.4` |
| Green project | `xero-accounting-mcp-green-030` |
| 公网资源 | `https://mcp.jiayuanwang.xyz/mcp` |
| Agent2 Agent | `Xero 会计助理（UAT）` |
| Agent2 MCP | `Accounting MCP` / `accounting-mcp` |
| 源码包 | `artifacts/release/xero-accounting-mcp-0.3.0-source.tar.gz` |
| 源码包 SHA-256 | `004f2fc7defa2c9419fd9c3a275f8c8602ba59b0aee9b623b1add9e6f1d7439b` |
| Manifest SHA-256 | `cf32fb91415622ea5b47732ca57acd56dab96de0c303679fa37d7f1c7345dfb2` |

源码包为 147 个运行必需白名单文件；Secret、旧个人域名、禁止路径扫描均为 0。最终归档经独立临时目录重新解包，`npm ci`、typecheck、build、静态部署验证全部通过；VPS 上四个关键部署文件与本地最终源码哈希逐字一致。

## 2. 部署结果

- 公网 Xero 已从 blue 0.2.13 切到 green 0.3.0 build `20260808.4`；blue 保留在 `127.0.0.1:18002` 作为读侧回滚位。
- green 只占用 `127.0.0.1:18004`，Nginx 公网继续使用 `mcp.jiayuanwang.xyz`。
- 最终 public health：`status=ok`、`version=0.3.0`、`toolCount=43`、工具指纹精确匹配；ready 为 `status=ready`。
- OAuth Authorization Server metadata、Protected Resource metadata、401 challenge 和 legacy bearer 拒绝均通过。
- migration 001–020 已应用；020 同时保持 0.3.0 与旧 Xero runtime 所需索引兼容。
- PostgreSQL 与 stock 均未重建或重启，RestartCount 为 0。

## 3. Xero 重新授权修复

现场发现：Xero 对“重新授权已连接的唯一组织”会返回可用 token，但 `/connections` 不一定把旧连接标记为本次 `authentication_event_id`。旧实现因此把唯一组织过滤掉，Agent2 回跳显示连接错误。

最终规则：

1. 优先只接受本次 authentication event 明确标记的 connection；
2. 若本次没有 event-tagged connection，但 token 只返回 1 个可访问组织，则接受这唯一且无歧义的组织；
3. 若返回多个组织且都不属于本次 event，继续 fail closed，禁止猜测。

新增 3 个专门测试覆盖：current-event 优先、唯一组织 re-authorisation、多组织拒绝。Broker 与 legacy OAuth 回归均通过。

重新授权后还精确清理了 1 条“旧 Agent 安装已撤销，但 provider authorization 仍 ACTIVE”的孤儿授权。清理事务要求当前新绑定完整且唯一，否则整体回滚。最终数据库只剩：1 active installation、1 active binding、1 active provider connection、1 active provider authorization、1 active refresh family。

## 4. Agent2 核心会计业务验收（`.3` 历史证据）

通过会话：<https://agent2.zcloak.ai/c/dd147c46-a72d-471f-9721-abc535dbd69b>

| Flow | 结果 |
|---|---|
| 只读账套调查 | 10 个工具；组织 `zcloak`、HKD；Invoice/Bill/Payment/Credit Note/Quote/PO/Manual Journal/Bank Transaction/Trial Balance 均现场读取；零写入 |
| 草稿准备 | 5 个工具；Reference 预查为 0；联系人、科目、税码匹配；返回逐项预览与一次性确认句；零 Provider 写入 |
| 唯一受控写入 | 用户复制完整确认句后只调用 1 次 create，创建 Supplier Bill DRAFT 8.88 HKD |
| 同 ID 回读 | `readbackVerified=true`；Xero ID、Reference、日期、币种、Supplier、行项目与金额一致 |
| 重复证明 | 写闸关闭后按 Reference 再查，精确 1 笔、DRAFT、同一 Xero ID |
| 越权拒绝 | 对审批、付款、删除请求明确拒绝；无工具调用 |

### 唯一真实草稿回执

| 字段 | 值 |
|---|---|
| Reference | `ZC-AGENT2-UAT-0303-20260808-001` |
| Preparation ID | `xmp_37bac8b42bb0461ebf64f250ed90504f` |
| Posting Request ID | `pr_0e3945a4-b770-4aa6-a0aa-74babcf7f377` |
| Provider Request ID | `402757f4-8d34-4422-b02e-7bd0f7d6e4b0` |
| Xero Invoice ID | `8e3dea3c-57cc-4a0f-bacd-d77344512333` |
| Audit Call ID | `call_d5ba95e3-7f88-40c3-872c-873fd191cc42` |
| 状态 | `DRAFT` |
| 回读 | PASS |
| 同 Reference 数量 | 1 |

完整现场证据：`artifacts/test-runs/2026-08-08-agent2-xero-0.3.0-final-uat/`。

上述会计读、准备、一次受控草稿写入、同 ID 回读与越权拒绝均为 `.3` 的已通过历史证据。`.4` 未改变 43 个工具的业务契约，但本次专门新增的 Organisation 选择体验必须单独验收，不能用旧对话替代。

## 5. `.4` Organisation 切换验收

通过会话：<https://agent2.zcloak.ai/c/460bf061-5d22-4041-a1d9-8c4c34cc3191>

| 节点 | 结果 |
|---|---|
| Agent 自然语言“换公司”边界 | PASS；不静默切换，要求撤销、连接、新 OAuth、明确选择、回读 |
| Agent2 MCP 需授权状态 | PASS；旧 grant 已撤销 |
| Xero 官方 OAuth 入口 | PASS；进入 `Log in to Xero`，应用名 `zCloak Ledger MCP Demo` |
| Organisation 选择页 | BLOCKED；浏览器没有有效 Xero 登录态，未进入 consent/callback |
| 新 binding 与 Organisation/HKD 回读 | BLOCKED；没有伪造或复用旧回读作为新连接证据 |
| 会计写入 | PASS；本轮为 0，写闸全程关闭 |

数据库聚合确认：当前 ACTIVE installation、ACTIVE binding、ACTIVE MCP refresh family 都是 0；broker flow 当时停在 `AUTHORIZING_XERO`。所以这不是 MCP callback 故障，而是官方身份验证尚未完成。完整证据：`artifacts/test-runs/2026-08-08-agent2-xero-organisation-switch-uat/`。

## 6. 写闸与最终运行态

- 写入仅在上述确认轮短时打开，15 分钟自动关闭 timer 同时启用；创建完成后立即手动关闭。
- 最终 `XERO_WRITE_ENABLED=false`，restart policy 为 `unless-stopped`，green 为 healthy、RestartCount `0`。
- `.4` boot-close failsafe：installed/enabled、Nginx 非阻断 Wants、active/success；已真实执行一次并重新创建 `.4` green，输出 `BOOT_WRITE_GATE=CLOSED`、`XERO_IMAGE=PINNED`、PostgreSQL continuity PASS。
- timer 在手动关闭后为 inactive。
- 旧 `.3` boot-close unit 与已安装脚本在 `.4` 成功后已精确停用并删除；旧 `.3` release 仍保留审计副本。
- 因旧 grant 已撤销且新 OAuth 未完成，当前完整 `status/preflight` 的 binding 门槛按设计不能 PASS；这不会打开写入，反而阻止无绑定状态进入写 Demo。

## 7. 清理与回滚

- disposable 测试数据库已删除；远端临时测试镜像、上传包、SQL、build log 和 harness 目录已删除。
- 本轮临时 Hetzner Load Balancer `codex-xero-org-switch-ssh-20260808`（ID `7438287`）已删除；项目 LB 列表为空。
- 本轮临时 Hetzner API token `codex-xero-org-switch-20260808` 已删除，并以 CLI 返回 unauthorized 复核失效；既有长期 `Codex CLI` token 未改动。
- VPS 临时上传/暂存目录与本地临时 hcloud/token/独立构建目录均已精确删除。
- 无 22222 listener；无只允许 `51.79.130.16` 的 UFW 规则。
- `.4` boot-close unit/script 已精确替代 `.3`；旧 blue Xero 和历史 release/image 保留作审计与回滚，不做宽泛删除。
- 临时 LB 删除后，不再能通过 `5.161.32.19:443` SSH；后续运维使用既有标准通道或 Hetzner Console。

## 8. 当前可演示能力与不能承诺的事

代码与线上运行态已具备：连接 Xero、读历史账务、结合材料分析、查重和科目/税码匹配、准备常见会计草稿、逐项预览、明确确认、创建 DRAFT、回读和审计追踪；这些核心能力已有 `.3` 现场证据，`.4` 工具契约未变化。

但 Agent2 当前处于“需授权”，所以**现在不能把新用户从零连接的现场 Demo 说成 Ready**。要升级为 `.4` 完整 Demo Ready，必须在有效 Xero 登录态下完成：官方 consent → MCP 明确选择 Organisation → 返回 Agent → 只读回读同一 Organisation 与本位币 → 数据库出现唯一 ACTIVE installation/binding/family。

仍不开放：AUTHORISE/SUBMIT/POST、付款/收款/退款、Credit Note allocation、银行写入与最终 reconciliation、Void/Delete、报税、月结/关账。当前是单测试用户 Personal POC；会话确认不是生产级独立审批签名。正式多人上线仍需 Host 身份、租户隔离、签名审批收据、集中 Secret 管理、监控告警、备份恢复演练与技术团队接管。
