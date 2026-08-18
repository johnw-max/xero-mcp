# 部署收据：051-gateway

日期：2026-08-18。主机 `178.156.234.230`。

## 部署的候选

| 字段 | 值 |
|---|---|
| build identity hash | `5bccb0e9063d6783d139211ac00760943eaa4e37f842aed96d3e8fdb755d7c65` |
| acceptance source | `010e2aa2f08cedcb2e6432f83715a8a670ee7f7f84e830351330831f36648b7f` |
| source archive | `fc27fde79d98b7749ff5f18a416cddbb4576245f11ee406713aa07b617f52258` |
| OCI manifest digest | `sha256:11b3c8c7bcc49e6bb55a3299fc40621926510ee1fa8d344c761be6fe7a1e33b8` |
| requiredMigration | `041_accounting_case_source_case_binding.sql` |
| toolsetHash / 工具数 | `a43155ca…b730e87` / 28 |
| policy | `v1`（declared-ledger，非 SG 专用） |
| publicToolProfile | `xero-accounting-case-business-intake-v4` |

发布物构建：bundle PASS，197 文件，**secretFindings 0**；OCI 冒烟 PASS，
容器内真实跑通 migration 041、28 工具、匿名 401、畸形 400。

## 身份核验（开写闸前的硬门槛）

部署后逐字段比对 `/healthz` 与冻结候选：

```
MATCH  acceptanceSourceSha256
MATCH  sourceArchiveSha256
MATCH  approvedControlCatalogSha256
MATCH  toolsetHash
MATCH  buildIdentityHash
```

**本轮第一次做到线上跑的就是冻结候选。** 早先的预检查出来的是完全不同的
build（要求 migration 039，缺本轮的 P0 修复），且 `toolsetHash` 相同——
公开工具面一模一样，只看工具面永远发现不了。

## 配置

| 键 | 值 | 理由 |
|---|---|---|
| `XERO_WRITE_ENABLED` | `false` | 身份核验通过前不开 |
| `XERO_STANDING_DELEGATIONS_JSON` | `[]` | 重新授权后再配 |
| `XERO_ALLOWED_TENANT_ID` | `0f4c99fe-…6197f`（`Demo Company (Global)`） | Agent2 实际连接的租户 |
| `XERO_TENANT_COA_PROFILES_JSON` | `[]` | 账套实时科目表已成为权威，此项不再是启动前提 |

**租户白名单能指向 Demo Company，是辖区解耦的直接结果。** 改造前这个租户
不可能作为写入目标（SG 税种解析必然失败），当时只能在"用公司自己的正式账套"
和"放弃线上写入验证"之间选。现在这个两难消失了。

env 是从 042 的文件复制后**只覆盖上述策略键**，全程没有读取任何密钥。

## 网络与切换

两处与既有部署不同的坑：

1. 数据库网络 `xero-accounting-mcp-demo_data` 是 `internal: true`，Docker 对
   只连内部网络的容器**静默不发布端口**——`HostConfig.PortBindings` 里有记录，
   但 `docker ps` 的 PORTS 列和 `ss` 都看不到监听。解法是默认 bridge 上发布
   端口、再 `docker network connect` 接入内部网络取数据库。
2. nginx 备份文件不能放在 `sites-enabled/` 下，那个目录是通配加载的，备份会被
   当成第二份配置载入并触发 `duplicate log_format`。已改放 `/etc/nginx/backups/`。

切换：`upstream 127.0.0.1:18013 → 18014`，`nginx -t` 通过后 reload。
公开端点 `https://mcp.jiayuanwang.xyz/healthz` 已确认服务候选身份。

## 回滚

042 容器**原样在 18013 运行未受影响**。回滚 = 把 upstream 改回 18013 并
reload，单一动作。备份配置在 `/etc/nginx/backups/mcp.jiayuanwang.xyz.pre-051-gateway-*`。

数据库是共用的：迁移 040/041 是新增表与列，老版本容器对它们无感知，
因此回滚不需要回退数据库。

## 下一步

写闸仍关闭。开启前还需要：Agent2 重新授权（并捕获实际授予的 scope，这也是
scope 收窄的收口证据）→ 读取该租户实时科目表与税率表 → 按实际 installation
配 standing delegation → 才开写闸，且只对该 installation 与该租户。
