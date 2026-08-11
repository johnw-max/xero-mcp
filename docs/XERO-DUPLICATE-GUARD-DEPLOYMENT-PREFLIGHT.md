# Xero 业务防重迁移前检查

`013_xero_rejected_duplicate_guard.sql` 把 `REJECTED` 纳入 Xero 业务单据防重。原因是被人工拒绝的请求可能已经在 Xero 里创建过 DRAFT；拒绝审批不等于撤销或删除 Xero 单据。`020_xero_runtime_readiness_compatibility.sql` 还需要恢复旧 Xero 0.2.13 readiness 会精确核验的三个索引定义，因此部署前必须检查其完整唯一键，而不只是跨 actor 冲突。

## 部署闸门

在任何环境执行迁移前，必须先用目标数据库运行：

```bash
psql "$DATABASE_URL" -X -f scripts/preflight_xero_duplicate_guards.sql
```

该脚本以 `READ ONLY` 事务运行，并分三段检查：

- migration 016：tenant 下跨 actor 的 source、规范化 contact/reference 冲突；
- migration 020：以下三个 exact legacy 唯一键的**全部**冲突，不能只筛跨 actor；
  - `actor_id + tenant_id + request_id + create_operation`，包括跨 `document_type`；
  - 旧 active states 下的 `tenant_id + source_sha256`；
  - 旧 active states 下的 `tenant_id + 规范化 contact_id + 规范化 reference`，包括 ACCREC、同一类型和跨类型；
- migration 019：同一个 OAuth installation 存在多条 `ACTIVE` refresh family。

输出只包含内部 ID、状态、document type 和身份指纹，不输出完整 `provider_payload`、Token 或 Secret。migration 020 的三类 conflict group 必须全部为 `0` 才是 `PASS`。

只有脚本以退出码 `0` 输出 `PASS` 时，自动部署才可继续。发现任何冲突时，脚本输出 `BLOCKED` 并以非零状态停止；migration 020 自身还会在首个 rename 前精确核验五个 016 源索引的 btree/unique/valid/ready、keys 与 predicates，catalog drift 会以 `55000` 阻断。创建旧 unique index 失败时，之前的 v030 rename 和 `schema_migrations` 写入均会回滚。

## 临时兼容约束

migration 020 会把 0.3 的五个 document-type/DRAFT 强索引改用 `v030` 专用名称，并用原名重建 Xero 0.2.13 会核验的五个 distinct exact definitions。三类 preflight 中的 tenant source/contact 检查是 actor-scoped 旧索引冲突检查的严格超集。旧 tenant supplier-reference index 没有 `document_type` 条件，所以在旧 active states 中也会对 ACCREC 强制 contact/reference 唯一；这会临时收紧 migration 016 原本允许的 ACCREC reference 复用。

在不修改旧 Xero 0.2.13 runtime 的条件下，没有数据库层的等价替代：旧 readiness 同时核对 public `posting_requests` 上的 exact keys/predicate 以及 unique/valid/ready。若业务必须保留 ACCREC reference 复用，应先升级/补丁旧 Xero readiness，或停止并行旧 Xero。

## BLOCKED 后怎么处理

不要自动删除、合并、改状态或选择一条“保留记录”。应逐组人工核对：

1. 对照 `posting_request_ids`、状态、审计记录及 Xero 精确回读；
2. 确认是否已经存在 Xero DRAFT 或后续状态的账务记录；
3. 记录人工处置理由和证据；
4. 经负责人批准后，采用单独的受控修复方案；
5. 重新运行只读 preflight，直到明确 `PASS`，再执行迁移。

`BLOCKED_VALIDATION` 不在活动状态集合内，因为它表示 Provider 写入前的本地校验失败，可以在修正材料后发起新请求。
