# Xero Accounting MCP Demo — Hetzner 部署与安全回滚

> **当前 VPS 不使用本文件中的容器 Nginx 拓扑。** 现有宿主机 Nginx 已占用 80/443，stock-mcp 已使用 `127.0.0.1:18001`。0.3.0 发布必须遵循 [HETZNER-HOST-NGINX-RUNBOOK.md](./HETZNER-HOST-NGINX-RUNBOOK.md)：保留现有 blue `127.0.0.1:18002`，用 `compose.host-nginx.green.vps.yaml` 把候选 Xero 单独绑定到 `127.0.0.1:18004`，验收后再原子切换 upstream。本文件只保留为全新独立 VPS 的备选方案，不能与当前模式同时启动。

## 1. 状态与边界

本文件描述的“容器 Nginx”备选拓扑尚未在真实 Hetzner 主机验证。当前实际采用的宿主机 Nginx 拓扑及 zCloak 只读 MCP 链路已现场验证，证据见 `docs/LIVE-DEPLOYMENT-EVIDENCE-2026-08-03.md`；真实 Xero OAuth 与写入 E2E 仍为 `NOT_RUN`，并受账户持有人条款授权阻塞。

部署后的边界是：

```text
zCloak AI / LibreChat
        |
        | HTTPS + MCP Bearer (only /mcp)
        v
Nginx (80/443 only)
        |
        | private Docker network
        v
Accounting MCP (3000, not published)
        |
        +---- Xero OAuth / Accounting API
        |
        +---- PostgreSQL (5432, not published)
```

这是受控 Demo 部署，不是多租户生产身份系统。共享 MCP Bearer 只适用于封闭测试且只在 `/mcp` 被接受；它不能启动浏览器 OAuth 或换取 reviewer session。Xero OAuth Token 与 Agent 入站 Bearer 必须保持完全独立。

## 2. 部署资产

| 文件 | 用途 |
|---|---|
| `Dockerfile` | 构建 TypeScript 服务；运行时 UID/GID `10001:10001` |
| `docker-compose/compose.vps.yaml` | App、PostgreSQL、Nginx 及资源/权限限制 |
| `nginx/default.conf.template` | HTTPS、Host 拒绝、MCP 流式代理、路径级限流 |
| `nginx/00-security.conf` | 不记录查询参数的访问日志、连接/请求限流 |
| `nginx/proxy_params` | 项目自带的代理头配置，不依赖镜像内置文件 |
| `env.vps.example` | VPS 环境变量契约，不包含可用密钥 |
| `scripts/install-renewed-cert.sh` | 将 Certbot 证书安全复制给 non-root Nginx 并热加载 |
| `scripts/verify-static.sh` | 本地静态检查及 Compose 渲染验证 |

## 3. 健康与就绪约定

- `GET /healthz`：进程存活，不检查外部依赖；可匿名，但不能返回配置、租户或账务内容。
- `GET /readyz`：必需配置有效、PostgreSQL 可达且 schema 已完成；不要求用户已经完成 Xero OAuth。
- Xero 是否已连接由 MCP 工具 `xero_connection_status` 表达，不能混入 `/readyz`。
- Docker 对 App 使用 `/readyz`；Nginx 只有在 App 就绪后启动。
- Nginx 自身使用容器内部的 `/nginx-healthz`，不经过外部 Host 规则。

## 4. 主机与网络前置条件

建议的 Demo 主机基线为 Ubuntu LTS、2 vCPU、至少 4 GiB RAM，并安装受支持的 Docker Engine 与 Compose v2。

上线前完成：

1. 给域名配置唯一的 A 记录；若发布 AAAA 记录，也必须同步配置 IPv6 防火墙。
2. SSH 只允许管理来源或 Hetzner Console；禁用密码登录，使用密钥。
3. 永远不开放 `3000` 和 `5432`。
4. `443/tcp` 对测试用户开放。
5. 使用 HTTP-01 时开放 `80/tcp` 供首次签发和续期；使用 DNS-01 时可在主机防火墙关闭 80。Compose 即使监听 80，最终公网可达性仍由主机/云防火墙决定。
6. 在 Xero Developer App 中登记完全一致的回调地址：

   `https://<MCP_PUBLIC_HOST>/oauth/xero/callback`

不要在 Demo 中连接银行，也不要使用真实客户凭证或账务数据。

## 5. 主机目录

以下命令在真实 VPS 上执行；路径必须与 `.env.vps` 一致：

```sh
sudo install -d -o root -g root -m 0750 /opt/xero-accounting-mcp-demo
sudo install -d -o 70 -g 70 -m 0700 /srv/xero-accounting-mcp/postgres
sudo install -d -o root -g 101 -m 0750 /srv/xero-accounting-mcp/tls
sudo install -d -o root -g 101 -m 0755 /srv/xero-accounting-mcp/certbot
sudo install -d -o root -g root -m 0700 /srv/xero-accounting-mcp/backups
```

`70:70` 是 Alpine PostgreSQL 容器用户；`101:101` 是选定 Nginx unprivileged Alpine 镜像的运行用户。若更换镜像，必须先重新确认其 UID/GID，不能直接沿用。

## 6. 密钥与环境文件

复制模板并在 VPS 上编辑：

```sh
cp deploy/env.vps.example deploy/.env.vps
chmod 0600 deploy/.env.vps
```

至少单独生成：

```sh
openssl rand -hex 32
openssl rand -base64 32
openssl rand -hex 32
```

分别用于 PostgreSQL 密码、`TOKEN_ENCRYPTION_KEY_B64` 和 MCP Bearer。不要重复使用，不要放进工单、聊天、Git、Dockerfile 或 Nginx 配置。

注意：

- PostgreSQL 密码包含 URI 保留字符时，`DATABASE_URL` 中必须使用 URL 编码后的同一密码。
- `TOKEN_ENCRYPTION_KEY_B64` 必须是 **32个原始随机字节的 Base64**，并与数据库中的 Token 密文作为一个恢复单元保存。
- `MCP_ALLOWED_HOSTS` 只填真实 MCP 域名。
- `MCP_ALLOWED_ORIGINS` 填 zCloak AI/LibreChat 的确切 Origin和MCP自身HTTPS Origin，禁止使用 `*`。
- `PUBLIC_BASE_URL` 必须是 HTTPS 且不能带额外路径。
- 初始和默认必须保持 `XERO_WRITE_ENABLED=false`；此时先完成 OAuth 和只读 Tenant 核对。
- `XERO_WRITE_ENABLED=true` 时必须同时配置 OAuth 后只读取得并人工核对的精确 `XERO_ALLOWED_TENANT_ID`；不得为空、使用通配值、名称或预估 ID。
- 环境文件仍会被 Docker 管理权限持有者看到；这只满足封闭 Demo。生产版应迁移到受控 Secret Manager 和逐用户身份。

部署前确认模板占位符已经全部移除：

```sh
grep -nE 'REPLACE_WITH|YOUR_ZCLOAK|example\.com' deploy/.env.vps
```

命令应没有输出。

## 7. TLS 引导与续期策略

### 7.1 一次性引导证书

Nginx 必须先读到一组证书文件才能启动，而 HTTP-01 的 webroot 签发又需要 Nginx 监听80端口。首次部署先创建一个24小时自签名引导证书；它只负责让 Nginx 启动，不能作为验收证书：

```sh
MCP_HOST=xero-mcp-demo.example.com
sudo openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -subj "/CN=${MCP_HOST}" \
  -addext "subjectAltName=DNS:${MCP_HOST}" \
  -keyout /srv/xero-accounting-mcp/tls/privkey.pem \
  -out /srv/xero-accounting-mcp/tls/fullchain.pem
sudo chown root:101 /srv/xero-accounting-mcp/tls/privkey.pem /srv/xero-accounting-mcp/tls/fullchain.pem
sudo chmod 0640 /srv/xero-accounting-mcp/tls/privkey.pem /srv/xero-accounting-mcp/tls/fullchain.pem
```

把 `MCP_HOST` 的示例值替换成真实域名。随后按第8节启动服务，再用 webroot 签发正式证书。

### 7.2 自动续期

首次正式证书就使用 `--webroot`，让 Certbot 的 renewal 配置继续使用 webroot，而不是占用80端口的 standalone 模式。将 `install-renewed-cert.sh` 配置为该证书的 deploy hook，并固定传入 `MCP_PUBLIC_HOST`、TLS目录与项目目录。脚本会检查有效期、SAN、私钥和证书公钥匹配，再替换副本并reload Nginx。

使用 HTTP-01 时，续期期间必须保持公网80端口可达。若安全策略要求永久关闭80，应改用受支持的 DNS-01 插件，并单独保护 DNS API 凭证。

续期验收至少包括：

```sh
sudo certbot renew --dry-run
MCP_HOST=xero-mcp-demo.example.com
openssl s_client -connect "${MCP_HOST}:443" -servername "${MCP_HOST}" </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

## 8. 首次部署

在项目根目录执行：

```sh
docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.vps.yaml \
  config --quiet

docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.vps.yaml \
  build --pull accounting-mcp

docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.vps.yaml \
  up -d postgres

# 必须先通过只读 Xero 历史防重检查。退出码 3 表示发现冲突组；
# 此时立即停止，禁止自动删除、合并或继续迁移。
docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.vps.yaml \
  exec -T postgres sh -eu -c \
  'psql -v ON_ERROR_STOP=1 -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < scripts/preflight_xero_duplicate_guards.sql

docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.vps.yaml \
  run --rm accounting-mcp npm run migrate

# 该命令实际以镜像内 non-root Nginx 用户检查私钥读取、项目自带
# proxy_params、模板渲染结果和完整 Nginx 语法；失败时不要启动公网边缘。
docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.vps.yaml \
  run --rm --no-deps nginx sh -ec \
  'test -r /etc/nginx/tls/privkey.pem && test -r /opt/xero-nginx/proxy_params && nginx -t -c /opt/xero-nginx/nginx.conf'

docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.vps.yaml \
  up -d accounting-mcp nginx
```

迁移是显式步骤：App 启动不会偷偷建表。升级时同样先审查迁移兼容性，再执行 `npm run migrate`。

本发布的 `020_xero_runtime_readiness_compatibility.sql` 在保留五项 0.3 `v030` 强索引的同时，恢复旧 Xero 0.2.13 与 QuickBooks 0.2.12 shared repository 精确要求的五个原名索引。只读 preflight 必须确认 `actor + tenant + request_id + create_operation`、旧 active states 下的 `tenant + source`、旧 active states 下的 `tenant + contact + reference` 三类冲突均为 `0`，包括跨 `document_type` 与 ACCREC；后两类 tenant 检查也覆盖 actor-scoped 旧索引，否则停止发布。旧 supplier-reference 定义没有 `document_type`，因此这是会临时收紧 ACCREC reference 复用的**临时兼容约束**。若不能接受，只能先升级旧 Xero readiness 或停止并行旧 Xero，不能靠数据库伪影绕过 exact unique/valid/ready 检查；QuickBooks runtime 不需要修改。

确认 Nginx 已通过引导证书启动后，签发并安装正式证书：

```sh
MCP_HOST=xero-mcp-demo.example.com
sudo certbot certonly --webroot \
  -w /srv/xero-accounting-mcp/certbot \
  -d "${MCP_HOST}"

sudo env \
  RENEWED_LINEAGE="/etc/letsencrypt/live/${MCP_HOST}" \
  MCP_PUBLIC_HOST="${MCP_HOST}" \
  TLS_CERT_DIR=/srv/xero-accounting-mcp/tls \
  DEPLOY_PROJECT_DIR=/opt/xero-accounting-mcp-demo \
  /opt/xero-accounting-mcp-demo/deploy/scripts/install-renewed-cert.sh
```

将相同环境参数配置进该证书的 Certbot deploy hook。然后执行第7.2节的 `renew --dry-run`；只有公网证书主题、SAN、签发者和有效期均正确后，引导证书才算退出使用。

首次构建后记录实际基础镜像 digest，并将 `NGINX_IMAGE`、`POSTGRES_IMAGE` 和发布的 `APP_IMAGE` 固定为 digest/tag 组合；不要把可漂移的 tag 当成可审计发布记录。

## 9. 部署验收

### 9.1 容器与网络

```sh
docker compose --env-file deploy/.env.vps -f deploy/docker-compose/compose.vps.yaml ps
docker compose --env-file deploy/.env.vps -f deploy/docker-compose/compose.vps.yaml config
```

必须确认：

- 只有 Nginx 发布 80/443。
- App `3000` 和 PostgreSQL `5432` 没有 Host 端口映射。
- 三个容器均为 `read_only`、`cap_drop: ALL`、`no-new-privileges`。
- PostgreSQL 只在 `data` internal network；Nginx 不在数据库网络。
- 容器资源、PID和日志大小限制实际生效。

### 9.2 HTTPS 与负向边界

```sh
MCP_HOST=xero-mcp-demo.example.com
VPS_ADDRESS=203.0.113.10
curl -fsS "https://${MCP_HOST}/healthz"
curl -fsS "https://${MCP_HOST}/readyz"
curl -sS -o /dev/null -w '%{http_code}\n' "https://${MCP_HOST}/mcp"
curl -sk -o /dev/null -w '%{http_code}\n' \
  --resolve "invalid.example:443:${VPS_ADDRESS}" \
  https://invalid.example/healthz
```

预期：health/readiness为200且无敏感字段；无Bearer的MCP请求为401；错误Host在边缘被拒绝。随后还要验证错误Origin为403、超过1 MiB的请求为413，以及OAuth callback的访问日志不含 `code`、`state` 或查询字符串。合法 MCP Bearer 也不得在 `/connect/xero`、OAuth callback、Review 路径或旧 `/operator/session`、`/oauth/xero/start` 路径建立身份或能力。

### 9.3 MCP 与 Xero

使用临时读取的Bearer执行 MCP `initialize`、`tools/list` 和 `ping`，不要把Bearer写进命令历史或证据截图。验收固定工具清单后，再按以下顺序测试：

1. 保持 `XERO_WRITE_ENABLED=false`，确认 `xero_connection_status` 显示尚未连接。
2. 使用 `/mcp` 返回的一次性 connect ticket；浏览器消费 ticket 后应直接进入 Xero OAuth，并选择唯一测试 Tenant，不经过 Bearer session/start 路由。
3. 只有成功 callback 的同一浏览器取得 reviewer session；取消、失败、错误 state、Token/Tenant 失败均不得取得。
4. `xero_connection_status` 和组织读取成功，但响应不包含 Token；只读记录并人工核对精确 Tenant ID。
5. 把该 ID 配置为唯一 `XERO_ALLOWED_TENANT_ID`，再显式设置 `XERO_WRITE_ENABLED=true` 并只重建 App；不符合这两个条件时写工具必须在 Provider 前拒绝。
6. 读取科目、税码和联系人。
7. 使用合成供应商发票创建 DRAFT Bill，按 Xero ID 精确回读。
8. 人工审批后才允许 DRAFT → AUTHORISED；精确回读后内部进入不可回退的 `AUTHORISED_READBACK_VERIFIED`。
9. 再次精确回读并验证 Xero UI/报表变化。
10. 对相同请求做顺序及并发复验，Provider 写入计数最多一次且不得创建第二张 Bill。

连接状态不是服务就绪状态；Xero临时不可用不应令健康端点泄露内部错误或凭证。

## 10. 日志与运行维护

- Nginx访问日志只记录 `$uri`，不记录 `$request`、`$args` 或OAuth查询参数。
- App日志不得记录 `Authorization`、Xero Client Secret、Access/Refresh Token、完整供应商凭证或数据库URL。
- Docker日志限制为每文件10 MiB、保留3个文件；重要审计事件应写入结构化审计表，而不是依赖容器日志。
- `/healthz`、`/readyz` 只返回状态、版本和工具清单摘要；不要返回 Tenant ID、数据库错误文本或配置值。
- 定期检查磁盘、证书续期、数据库备份可恢复性和异常401/403/429。

## 11. 安全发布与回滚

### 11.1 发布前

1. 记录当前 `APP_IMAGE` tag/digest、Compose配置摘要和数据库schema版本。
2. 使用 `pg_dump -Fc` 创建仅root可读的预发布备份并计算SHA-256。
3. 单独确认当前 `TOKEN_ENCRYPTION_KEY_B64` 可恢复；不要把明文密钥放进数据库备份。
4. 检查迁移是否向后兼容。不能确认时，安排维护窗口，不做滚动发布。
5. 保留上一版应用镜像和上一版环境文件的加密副本。

### 11.2 应用回滚

如果schema仍与上一版兼容：

1. 将 `.env.vps` 中 `APP_IMAGE` 恢复到上一版不可变digest。
2. 重新执行 `config --quiet`。
3. 只重建 `accounting-mcp`，等待 `/readyz` 成功后再reload Nginx。
4. 重跑 MCP 初始化、固定工具清单和只读 Xero 探针。

不要执行 `docker compose down -v`，不要删除 PostgreSQL 目录，也不要在无法确认写入结果时重试 Xero 写操作。

### 11.3 数据库回滚

只有迁移破坏兼容且应用回退不足时，才进入数据库恢复：停止 App 写入、保留故障现场备份、核对目标数据库和预发布备份SHA-256，再由负责人批准恢复。恢复后必须使用与该备份配套的 `TOKEN_ENCRYPTION_KEY_B64`；密钥不匹配会让OAuth Token永久不可解密。

数据库恢复是破坏性操作，本运行手册不提供可直接误执行的 `--clean` 命令。执行前需要独立复核目标主机、数据库名、备份时间和恢复点。

### 11.4 密钥事件

- MCP Bearer泄露：立即轮换Bearer，更新平台MCP配置，确认旧Bearer返回401。
- Xero Client Secret或Refresh Token泄露：在Xero撤销连接/轮换应用凭证，清除旧Token密文后重新OAuth。
- Token加密主密钥泄露：视同所有已保存Xero Token泄露，撤销全部连接并生成新主密钥；不能只替换数据库字段。
- TLS私钥泄露：吊销并重新签发证书，更新TLS副本，核验公网证书指纹。

## 12. 当前安全限制

- Demo使用共享 MCP Bearer，不提供逐用户撤销、配额或平台OIDC身份。
- 运行时密钥仍通过受限环境变量传入，Docker管理员可以读取。
- Nginx限流是单机、按来源IP的粗粒度控制，不等于业务租户配额。
- PostgreSQL只做单机持久化；正式版本需要加密备份、恢复演练和明确的RPO/RTO。
- 本文件的容器 Nginx 备选拓扑尚未现场验证；当前宿主机 Nginx、真实域名和 zCloak 只读链路已有证据。真实 Xero OAuth callback 与写入 E2E 仍未执行，不能由基础设施成功推定。
