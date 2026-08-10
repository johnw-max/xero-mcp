# Xero MCP 0.3.0 最终发布门槛记录

最终核对：2026-08-08  
结论：`ALL_RELEASE_GATES_PASS / ONLINE_DEMO_READY`

## 固定发布物

| 项目 | 结果 |
|---|---|
| 版本/构建 | `0.3.0 / 20260808.3` |
| 工具合同 | 43 tools；SHA-256 `a76bf853dc4bc71bf33e5b42f936fbcc9d6593d67d23e40dedccc4d1e2ae5d65` |
| 源码包 | 147 个 allowlist 文件；双构建逐字节一致 |
| Archive SHA-256 | `8b143c3ea331b25154d73a7255f487bad588ac728737f809f6292ea0c969470f` |
| Manifest SHA-256 | `e5a26c9bd88737568de0edc5d06a779b72545df6e777246a9ef9d292f4593f47` |
| 发布扫描 | Secret 0、旧域名 0、禁止路径 0 |

## 代码与发布检查

| 门槛 | 最终结果 |
|---|---|
| TypeScript typecheck | PASS |
| Production build | PASS |
| 完整单 worker 回归 | 80 files PASS、7 条件 files skipped；788 tests PASS、44 条件 skipped |
| HTTP/OAuth 强制测试 | 2/2 PASS |
| 静态部署检查 | PASS；包含 upstream switch public settle tests |
| Xero re-authorisation 修复 | 3/3 专门测试 PASS；Broker 31/31；legacy OAuth 7/7 |
| Fresh PostgreSQL 强制测试 | migration 001–020；6 files、42/42 PASS（部署前现场记录） |
| 发布包 verifier | PASS；双包 byte-identical；VPS source diff clean |

第一次在受限沙箱重跑全量/HTTP 时，所有失败均为 `listen EPERM 127.0.0.1`。在允许 loopback 的相同源码上重跑后，全量 788/788 和 HTTP 2/2 通过；因此不把沙箱权限错误算作产品缺陷。

## 业务合同

- P0 只读业务合同、受控写入合同和多角色合成合同均已通过。
- 本地真实 Agent 已覆盖 AR/AP 历史调查、查重、prepare 与零写入边界。
- Agent2 线上真实 Xero 已完成完整 signature flow：读账 → 分析 → prepare → 用户明确确认 → 仅 1 次 DRAFT create → Provider receipt → 同 ID read-back → 同 Reference 精确 1 笔 → 越权拒绝。
- 最终写闸 CLOSED，boot-close active/success，QuickBooks/PostgreSQL/stock 连续性通过。

## 上线边界

本轮批准范围是可稳定演示的单用户 Personal POC。正式生产仍需补齐多人身份与租户隔离、Host 签名确认/审批凭证、集中 Secret/DB 运维、监控告警和灾备。Payment、正式审批/入账、银行写入、删除/作废、报税与关账继续 fail closed。

## 主要证据

- `artifacts/release/xero-accounting-mcp-0.3.0-source.tar.gz`
- `artifacts/release/xero-accounting-mcp-0.3.0-source.manifest.json`
- `artifacts/harness-runs/xero-0.3.0-release-final-20260808/`
- `artifacts/test-runs/2026-08-08-agent2-xero-0.3.0-final-uat/`
- `docs/XERO-0.3.0-DEPLOYMENT-AND-ONLINE-UAT-2026-08-08.md`
