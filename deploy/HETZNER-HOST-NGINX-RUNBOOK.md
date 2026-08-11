# Xero MCP — Hetzner Host-Nginx 发布手册

适用服务：`mcp.jiayuanwang.xyz`
适用仓库：`johnw-max/xero-mcp`
边界：本仓库和本文只负责 Xero MCP。

## 1. 运行结构

```text
Work / Agent Host
    │ HTTPS + OAuth
    ▼
Host Nginx :443
    ├─ blue  127.0.0.1:18002
    └─ green 127.0.0.1:18004
             │
             ├─ PostgreSQL: OAuth installation、token、binding、proposal、audit
             └─ Xero Accounting API: formal accounting system of record
```

PostgreSQL 不复制 Xero 总账。正式客户、发票、账单、付款、科目和报表仍以 Xero 为准。

## 2. OAuth 与多人测试模式

外层 OAuth 是 Work 到 MCP；内层 OAuth 是用户到 Xero。当前早期 UAT 允许多人共享一组 Work Client ID、Client Secret 和 Redirect URI：

```dotenv
MCP_OAUTH_BROKER_ENABLED=true
PERSONAL_POC_ONLY=true
SHARED_TEST_USERS=true
```

共享凭证只标识 Work 中的 MCP 应用。每次 OAuth 流程创建独立的 installation、access/refresh token family 和 Organisation binding；后一个测试用户不得覆盖前一个用户。

当前 Work 没有提供可验证的签名 user/workspace identity，因此共享测试模式使用服务端生成的临时 subject。它适用于 5–10 人早期验收，不等于生产级真实用户审计身份。正式上线必须接入可信 Host identity，并关闭测试模式。

## 3. Secret 位置与交接

真实值只保存在服务器 `deploy/.env.vps` 或公司 Secret Manager，文件权限必须为 `0600`。关键变量：

```text
HOST_OAUTH_CLIENTS_JSON   Work -> MCP 的 Client ID / Client Secret / Redirect URI
XERO_CLIENT_ID            MCP -> Xero Developer App Client ID
XERO_CLIENT_SECRET        MCP -> Xero Developer App Client Secret
OAUTH_TOKEN_HASH_KEY_B64  MCP OAuth token 哈希密钥
OAUTH_COOKIE_STATE_KEY_B64 OAuth 浏览器 state/cookie 密钥
TOKEN_ENCRYPTION_KEY_B64  Xero token 加密密钥
```

Work 编辑页不会回显现有 Client Secret；Xero Developer Portal 也不会显示已经创建的旧 Client Secret。旧值只能从服务器 Secret 注入源读取。若源中不可读，应生成新 Secret、先更新服务器、再更新 Work/Xero 配置，并立即执行 OAuth 和 refresh 回归；不得猜测旧值。

## 4. 发布前只读检查

```sh
cd /opt/xero-accounting-mcp-demo

test "$(stat -c '%a' deploy/.env.vps)" = "600"
sudo systemctl is-active nginx
sudo nginx -t
sudo ss -ltnp | grep -E ':(80|443|18002|18004)\b'

docker compose --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml config --quiet
docker compose --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.green.vps.yaml config --quiet

./deploy/scripts/verify-static.sh
npm ci
npm run typecheck
npm test
npm run test:http:required
npm run build
```

若使用 PostgreSQL required gate，`TEST_DATABASE_URL` 必须指向独立、可丢弃的测试库，不能指向 `xero_mcp`、`postgres`、`template0` 或 `template1`。

## 5. 启动 green

镜像必须使用固定 tag 或 digest：

```sh
docker build --pull \
  -f deploy/Dockerfile \
  -t xero-accounting-mcp-demo:REPLACE_WITH_RELEASE .

APP_IMAGE=xero-accounting-mcp-demo:REPLACE_WITH_RELEASE \
XERO_WRITE_ENABLED=false \
docker compose --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.green.vps.yaml \
  up -d --no-build accounting-mcp-green
```

启动后确认：

```sh
curl -fsS -H 'Host: mcp.jiayuanwang.xyz' http://127.0.0.1:18004/healthz
curl -fsS -H 'Host: mcp.jiayuanwang.xyz' http://127.0.0.1:18004/readyz
```

在任何 OAuth 或写入验收前，`XERO_WRITE_ENABLED` 必须为 `false`。

## 6. 切流

切流脚本只修改 `xero_accounting_mcp_demo` upstream，并保留 root-only Nginx 备份：

```sh
sudo deploy/scripts/switch-xero-upstream.sh status
sudo deploy/scripts/switch-xero-upstream.sh green
```

脚本执行：目标 loopback 检查、站点原子替换、`nginx -t`、graceful reload、公网 settle；失败时恢复原配置并返回非零状态。

切流后执行：

```sh
curl -fsS https://mcp.jiayuanwang.xyz/healthz
curl -fsS https://mcp.jiayuanwang.xyz/readyz
curl -fsS https://mcp.jiayuanwang.xyz/.well-known/oauth-authorization-server
curl -fsS https://mcp.jiayuanwang.xyz/.well-known/oauth-protected-resource/mcp
curl -i https://mcp.jiayuanwang.xyz/mcp
```

无 token 的 `/mcp` 应返回认证错误，不能返回工具结果。

## 7. 共享 Client 多人 UAT

至少使用两名测试者验证同一 Work Client：

1. 两人分别点击 Connect，并各自完成 Xero OAuth。
2. 两人分别明确选择 Organisation。
3. 两条授权都能读取各自 Organisation 名称和本位币。
4. 数据库同时存在两条 ACTIVE installation、两条独立 refresh family 和各自 current binding。
5. 第一名测试者的 refresh 不影响第二名测试者；第二名重新连接也不能使第一名失效。
6. 任一 access token 只能解析到自身 installation/binding/connection；不能通过工具参数切换 tenant。
7. 全程保持 `XERO_WRITE_ENABLED=false`。

通过后只能表述为“共享应用凭证下的 installation 隔离已通过早期 UAT”；不能表述为“Work 真实用户身份已接入”。

## 8. 受控写入

写入只允许在独立测试 Organisation、明确人工确认和自动关闭窗口下进行。必须保存：

- 目标 Organisation 与 binding revision；
- 幂等依据；
- Xero 记录 ID；
- Provider 回执；
- 同一记录的精确 read-back。

OAuth 成功、`PREPARED` 或“接口返回 200”都不等于正式写入完成。没有记录 ID 和 read-back 时必须标记为未验证。

## 9. 回滚

```sh
sudo deploy/scripts/switch-xero-upstream.sh blue
```

回滚后复核公网 health/readiness，并保持写闸关闭。数据库 migration 成功后不做逆迁移；旧 binary 若不能读取 forward schema，停止服务并按维护流程处理，禁止删表、删列或删除持久卷来恢复。

## 10. 仓库边界

每个会计 Provider 使用独立仓库，至少独立拥有：

- Provider OAuth 应用和 scopes；
- Provider client、mapping 和业务能力边界；
- 数据库迁移与幂等约束；
- 部署配置、域名/路由和 Secret；
- 测试、UAT 证据与发布节奏。

可复用的 OAuth/审计/会计能力模型应抽成版本化公共包；Provider 仓库通过依赖引用，不把另一 Provider 的源码、迁移或部署路由复制进来。
