# Xero MCP — 发布判定与遗留事项（2026-08-19）

判定对象：分支 `codex/xero-org-switch-governance-20260810`，
构建标识 `10497b46862ed94dd6702e0e400ea62388f8abe6dc46ee5d997339b49e11b08f`
（候选 067，已部署于 `mcp.jiayuanwang.xyz`）。

## 结论

**可以推送到 GitHub。** 在既有业务边界内（把 agent 的记账意图安全、可审计地
写进 Xero 账本），主链已经端到端跑通并有真实证据；已知阻塞项都不在这个边界内，
或不需要改代码。

## 主链证据（真实 Xero，非测试替身）

线上产品 agent（agent2）对 `Demo Company (Global)` 的一次完整落账：

| 项 | 值 |
|---|---|
| Xero 对象 | `2190a20f-e634-48fa-9559-b1c53317cc54` |
| 单据 | 供应商账单 `INV-2026-0819C`，ACCPAY |
| 变更状态 | `READBACK_VERIFIED` |
| 账本状态 | `DRAFT` |
| provider 写入次数 | 1 |

紧接着换措辞再问同一张单，agent 先读账本确认已存在，**没有第二次写入**——
`xero_mutation_requests` 里对该坐标始终只有一行。

## 防串帐（本次重点验证）

| 防线 | 验证方式 | 结果 |
|---|---|---|
| 上游 case 不跨组织 | 对 067 实测三次绑定 | 首次绑定 / 跨租户 `TENANT_CONFLICT` / 同租户幂等 |
| 冲突不泄露对方租户 | 读返回值与错误信封 | 只有 reason code，无 id、无名称 |
| 账套核对 | 本地挂 skill 的验收会话 | agent 发现账套名对不上，**拒绝写入**并说明原因 |
| 单号坐标预留 | Postgres 主键 + 原子 upsert | 无应用层竞态窗口 |

第三条是这轮最有说服力的一条：它不是我写测试断言出来的，是扮演线上 agent 的
子agent 在冷上下文里自己停下来的。

## 本轮修掉的缺陷

四个缺陷各自都足以让供应商账单**永远**写不进去，且都因为测试替身给出了真实
API 不会给的形状而长期未被发现：

1. 组织账期锁定日期以 Xero SDK 的 `Date` 对象直接进入 case target，schema 拒收；
   同时账期防线在拿 `Date` 做字符串比较，判断本身是错的。
2. `listInvoices` 传 `summaryOnly=true`，Xero 在该模式下完全不返回分页信封，
   查重历史永远无法证明扫完。实测同查询设为 `false` 即返回精确 pageCount/itemCount。
3. 某供应商的第一张单，Xero 返回 `pageCount 0 / itemCount 0`——精确答案，
   却被判为无效。
4. 治理层已按 ADR-003 拆除，但期望解析器仍对所有非唯一单号要求签名授权，
   **封存与未封存两条路径都有**。

另外两处是从 agent 行为反推出来的可用性缺陷：错误正确但无法据以纠正。

5. schema 失败不指出出错字段，agent 只能盲试。现在回 `invalid_fields`
   字段路径（不回值），且 `REQUEST_SCHEMA_INVALID` 不再被信封白名单静默丢弃。
   —— 这个修复本身立刻定位了第 1 条。
6. 坐标预留冲突不说谁占着、何时释放。现在回 `holding_case_id` /
   `holding_case_version` / `hold_releases_at`。

以及一处架构性脆弱：

7. 常驻委托钉死在 OAuth installation 上，用户每次重连 Xero 授权即失效，
   只能靠运维改 env 恢复。现改为可选钉子，默认按 workspace + agent + 租户
   这个稳定身份匹配。配套 `scripts/release/compute-authority-pins.mjs`
   与 `docs/AUTHORITY-PIN-OPERATIONS.md`（含 revision 单调、回滚需以更高
   revision 重发旧内容的规则）。

以及一处会直接坑到部署方的文档漂移：

8. 挂载给 agent 的指令仍在教改造前的契约（`accounting_category` /
   `tax_class` / `SG_STANDARD_RATED`），并要求"第一次就照 schema 原样提交"。
   任何照此部署的 agent 都会自信地提交错结构再开始猜。已改写为实际契约
   （每行 `account_code` + `tax_type`，从该组织自己的科目表与税率表取）。

## 测试状态

全量 1563 项：**1427 通过，112 跳过，24 失败**。

24 项失败全部集中在两个文件，且与本轮改动无关（改动前后逐项一致）：

- `tests/independent-review-evidence.test.ts`（23 项）——需要仓库外的
  Codex 可执行体与签名主体，环境不具备。
- `tests/traceability-validator.test.ts`（1 项）——追溯工件需按当前需求集
  重新生成。

## 遗留事项

| 事项 | 性质 | 处理建议 |
|---|---|---|
| Gate L 独立评审 | 结构性不可达：`independent-review-live` 拒绝自证，需仓库外签名主体 | 发布前由人指定评审方，非代码问题 |
| 追溯工件 18/90 断言 | 工件待重生成 | 一次性重跑生成脚本 |
| Drive（accountingv2）联动 | UAT agent 未挂 Drive MCP，agent 自述无该工具 | 需把 Drive MCP 挂到同一 agent 才能端到端测；本 MCP 侧的边界（上游 case 绑定）已单独验证通过 |
| 本地 harness 无 OAuth broker | 保真度差异，非缺陷 | `xero_start_organisation_switch` 本地返回 `CONFIGURATION_ERROR`，线上可用；已写入剧本备注 |
| 公开远程仓库已含真实 Xero client id | 未决 | 轮换或接受，需人决策 |

## 部署与回滚

- 线上：容器 `xero-accounting-mcp-067`（18022），nginx 指向该端口。
- 授权快照 revision 单调递增，**旧构建直接重启会静默变成 READ_ONLY**。
  回滚 = 以更高 revision 重新发布旧内容，步骤见
  `docs/AUTHORITY-PIN-OPERATIONS.md`。
