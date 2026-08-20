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
OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS  仅允许省略 MCP resource 的精确 Host client ID
OAUTH_MANUAL_RETURN_CLIENT_IDS  仅需要手动返回页的精确 Host client ID；不得与上一项隐式绑定
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

镜像必须是本地 acceptance Gate **已经构建并验证的 OCI artifact**；VPS/发布机禁止再次 `docker build`。发布工具只能把 Gate 的 OCI archive 做 digest-preserving copy 到 registry，registry 返回的 manifest digest 必须与 Gate receipt 完全一致。下面文件都来自同一个 PASS Gate 目录，不允许单独手填哈希：

```sh
GATE_DIR=artifacts/local-acceptance/REPLACE_WITH_GATE_RUN
node scripts/verify-accepted-oci-release.mjs \
  --gate-result "$GATE_DIR/gate-result.json" \
  --gate-receipt "$GATE_DIR/accepted-build-context-receipt.json" \
  --oci-receipt "$GATE_DIR/release/xero-accounting-mcp-0.4.0-rc.1.oci-receipt.json" \
  --oci-artifact "$GATE_DIR/release/xero-accounting-mcp-0.4.0-rc.1.oci.tar"

# 使用支持 oci-archive transport 的发布工具（例如 skopeo）复制同一 artifact；
# 不得重建。复制后再次拉取/inspect，并验证 registry manifest digest 与
# oci-receipt.json 的 ociManifestDigest 一致，才可填写 APP_IMAGE。
skopeo copy \
  "oci-archive:$GATE_DIR/release/xero-accounting-mcp-0.4.0-rc.1.oci.tar" \
  "docker://REPLACE_WITH_REGISTRY/xero-accounting-mcp:0.4.0-rc.1"
skopeo inspect --raw \
  "docker://REPLACE_WITH_REGISTRY/xero-accounting-mcp:0.4.0-rc.1" \
  | sha256sum

# 将 APP_IMAGE 与四个 XERO_ACCEPTANCE_*/XERO_ACCEPTED_* 绝对路径写入
# deploy/.env.vps；四个证据路径必须是下面固定 root trust root 内的目标。
sudo install -d -o root -g root -m 0750 /srv/xero-accounting-mcp/release
sudo install -d -o root -g root -m 0750 /etc/xero-accounting-mcp
sudo install -o root -g root -m 0400 "$GATE_DIR/gate-result.json" \
  /srv/xero-accounting-mcp/release/gate-result.json
sudo install -o root -g root -m 0400 "$GATE_DIR/accepted-build-context-receipt.json" \
  /srv/xero-accounting-mcp/release/accepted-build-context-receipt.json
sudo install -o root -g root -m 0400 \
  "$GATE_DIR/release/xero-accounting-mcp-0.4.0-rc.1.oci-receipt.json" \
  /srv/xero-accounting-mcp/release/xero-accounting-mcp-0.4.0-rc.1.oci-receipt.json
sudo install -o root -g root -m 0400 \
  "$GATE_DIR/release/xero-accounting-mcp-0.4.0-rc.1.oci.tar" \
  /srv/xero-accounting-mcp/release/xero-accounting-mcp-0.4.0-rc.1.oci.tar

# 当前发布不使用 Firm Governance、签名 trust bundle、Standing Delegation、
# authority revision 或其 hash 作为账本写入前提。准入只绑定不可变镜像、migration、
# accepted Gate/OCI identity、Capability Manifest 与 `XERO_WRITE_ENABLED`。
# 正常账本写入由运行时的当前 OAuth binding、已 pin Organisation、typed Accounting
# Case、确定性校验、幂等、Provider 回执和 exact read-back 共同约束；不要把聊天文本、
# 浏览器 Review 或外部签名文件当作第二授权层。

sudo install -o root -g root -m 0600 deploy/.env.vps \
  /etc/xero-accounting-mcp/release.env

# 该 wrapper 在任何 green container create/start 前，一次捕获并验证密封
# env+证据，绑定 APP_IMAGE 与 accepted manifest，再 pull/inspect labels/config。
sudo deploy/scripts/admit-and-compose.sh host-green-up
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

写入只允许在独立测试 Organisation、已 pin target、已开启的 `XERO_WRITE_ENABLED` 与当前 Capability Manifest 路由下进行。必须保存：

- 目标 Organisation 与 binding revision；
- 幂等依据；
- Xero 记录 ID；
- Provider 回执；
- 同一记录的精确 read-back。

OAuth 成功、`PREPARED` 或“接口返回 200”都不等于正式写入完成。没有记录 ID 和 read-back 时必须标记为未验证。

用户唯一的浏览器交互是 `xero_start_organisation_switch` 返回的一次性 Organisation selection URL；它只允许选择已授权账套。正常 typed Case 写入不使用逐笔确认、签名、Standing Delegation 或 Review 页面。

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
