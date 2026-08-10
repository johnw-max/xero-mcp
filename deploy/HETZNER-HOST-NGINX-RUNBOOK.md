# Xero MCP 0.3.0 — Hetzner / Agent2 Green 发布、回滚与验收

状态：`0.3.0 RELEASE CANDIDATE RUNBOOK / NOT DEPLOYED`  
目标 Host：`Agent2`  
目标 MCP slot：`accounting-mcp`；`quickbooks-accounting-mcp` 只做连续性检查  
Xero canonical MCP：`https://mcp.jiayuanwang.xyz/mcp`  
QuickBooks canonical MCP：`https://mcp.jiayuanwang.xyz/quickbooks/mcp`  
Xero Agent2 精确回调：`https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback`  
QuickBooks Agent2 精确回调：`https://agent2.zcloak.ai/api/mcp/quickbooks-accounting-mcp/oauth/callback`

> 本文只覆盖 Xero 0.3.0 发布。QuickBooks、stock-mcp 和 trade 是连续性保护对象，不在本次构建、迁移或重启范围。只有完成第 7 节线上验收后，才能表述为“Agent2 已连接 Xero 0.3.0”。目前仍应区分本地通过、已部署和线上真人通过。

## 1. 固定拓扑与运维边界

```text
Agent2 / Browser
      |
      v
https://mcp.jiayuanwang.xyz:443
      |
existing host Nginx
      |------------------------------|
127.0.0.1:18002  blue       127.0.0.1:18004  green       127.0.0.1:18003
      |                              |                          |
existing Xero rollback          Xero 0.3.0 candidate        QuickBooks unchanged
      |                              |
Xero OAuth / Accounting API    Intuit OAuth / QuickBooks API
      |------------------------------|
             PostgreSQL internal Docker network
```

硬边界：

- 现有 blue Xero 继续保留在 `127.0.0.1:18002`；0.3.0 green 只使用 `deploy/docker-compose/compose.host-nginx.green.vps.yaml` 并绑定 `127.0.0.1:18004`。
- QuickBooks App 继续只绑定 `127.0.0.1:18003`，stock-mcp 继续使用 `127.0.0.1:18001`，PostgreSQL 不发布端口。
- green Compose 只定义 `accounting-mcp-green`，通过 external network 复用现有 PostgreSQL；它不得定义、重建或停止 PostgreSQL、QuickBooks、Nginx、stock 或 trade。
- Xero 与 QuickBooks 使用独立镜像变量；重启 QuickBooks 时不得隐式复用 `APP_IMAGE` 或回退到本地默认 tag。
- 不停止、重启、重建或修改现有 stock-mcp、trade 服务。
- 临时 SSH `22222` 及精确临时 UFW 规则保持关闭。本轮使用用户已授权的标准 SSH / `codex-cli`；不得改动标准 22、80、443 或云防火墙。
- Xero 是账本；PostgreSQL 只保存授权、绑定、Token 状态和审计，不复制总账。

## 2. 本版本对外行为

OAuth Broker 开启后：

- `/mcp` 不再接受旧 shared bearer，只接受 Broker 签发的短期 opaque access token。
- Agent2 通过 Authorization Code + S256 PKCE 连接。
- 浏览器在 Xero 授权完成后必须明确选择一个 Organisation；即使只有一个也不自动选择。
- Agent2 只持有 zCloak access/refresh token；Xero token 加密保存在服务端。
- Xero access token 的典型有效期约 30 分钟；到期不是整条连接自动登出，服务会在授权仍有效时用 Xero refresh token 自动续期。Agent2 侧 MCP access token 默认 15 分钟，使用旋转 refresh token 续期；`/revoke` 提供主动失效入口并立即撤销 installation、binding 与整条 refresh family。
- MCP token 固定到一个 installation、一个 binding 和一个 Xero connection；工具参数不能切换 Tenant。
- 当前是 `PERSONAL_POC_ONLY=true`：一个预配置测试用户、一个 Host client、一个 active installation；不宣称团队身份隔离。
- 0.3.0 当前固定公开 44 个工具：23 个会计读取、10 个准备、10 个受控执行，以及 1 个只生成短效确认链接的 Organisation 切换入口。会计读取覆盖 Organisation、Contact、Account、Tax、Invoice/Bill、Credit Note、Payment、Quote、Purchase Order、Manual Journal、Item、Bank Transaction 和有界 Trial Balance。
- `xero.draft.write` 只允许受控创建 Supplier Bill、Sales Invoice、Quote、Purchase Order、Credit Note、Manual Journal 的 DRAFT，以及明确确认后的基础 Contact/非库存 Item 创建或修改。AUTHORISE/SUBMIT/POST、Payment、Credit Note allocation、Bank 写入、最终 reconciliation、Void/Delete、Attachment 和 Account/Tax 写入不开放。
- Broker 的新 `xero.read` 授权必须包含 `accounting.payments.read`。OAuth-off 回滚中的旧连接若没有该 scope，原有连接/查询工具仍可工作，但 Payment 历史不可用并应提示重新授权；不能为了新增 Payment 读取让旧 Token 的全部工具整体断连。

旧 `/connect/xero?ticket=...` 流程在 Broker 模式下不挂载。

## 3. 必需配置与 Secret

本候选版本固定放在 `/opt/xero-accounting-mcp-demo-0.3.0-20260810.1`；以下命令均从该目录执行。从 `deploy/env.vps.example` 复制为只在 VPS 存在的 `deploy/.env.vps`，权限设为 `0600`。真实 Secret 不进入 Git、聊天、截图或模型上下文。

必须替换：

- PostgreSQL 密码及 URL 编码后的 `DATABASE_URL` 密码；
- 旧 `MCP_BEARER_TOKEN`（仅供 OAuth-off 回滚启动）；
- Agent2 预注册 `client_id` 与至少 32 随机字节的 `client_secret`；
- Xero Developer App 的 client ID / secret；
- Intuit Development App 的 client ID / secret；
- 三把互不相同的 32-byte base64 key：Xero token encryption、OAuth token hash、browser state encryption。

必须保持：

```text
APP_IMAGE=xero-accounting-mcp-demo:0.3.0-xero-pilot-20260810.1
QUICKBOOKS_APP_IMAGE=xero-accounting-mcp-demo:0.2.12-quickbooks-20260806
GREEN_APP_LOOPBACK_PORT=18004
EXISTING_EGRESS_NETWORK=xero-accounting-mcp-demo_egress
EXISTING_DATA_NETWORK=xero-accounting-mcp-demo_data
MCP_OAUTH_BROKER_ENABLED=true
PERSONAL_POC_ONLY=true
PUBLIC_BASE_URL=https://mcp.jiayuanwang.xyz
MCP_ALLOWED_HOSTS=mcp.jiayuanwang.xyz
MCP_ALLOWED_ORIGINS=https://agent2.zcloak.ai,https://mcp.jiayuanwang.xyz
QUICKBOOKS_PUBLIC_BASE_URL=https://mcp.jiayuanwang.xyz
QUICKBOOKS_MCP_ALLOWED_HOSTS=mcp.jiayuanwang.xyz
QUICKBOOKS_MCP_ALLOWED_ORIGINS=https://agent2.zcloak.ai,https://mcp.jiayuanwang.xyz
XERO_WRITE_ENABLED=false
XERO_ALLOWED_TENANT_ID=7c3cc738-eef0-4d4e-83f8-d528390e1e61
```

`HOST_OAUTH_CLIENTS_JSON` 中 Agent2 callback 必须逐字匹配：

```text
https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback
```

Broker 模式实际 Tenant 由已选择的服务端 binding 固定，工具参数不能切换；临时写闸仍要求 `XERO_ALLOWED_TENANT_ID` 精确等于测试 Tenant，作为额外部署防线。Legacy shared-bearer 模式若开启写入，也必须配置同一 allowlist。

## 4. 部署前只读盘点

通过已授权的 SSH terminal 确认；本流程不依赖 Web Console：

```sh
sudo systemctl is-active nginx
sudo nginx -t
sudo ss -ltnp | grep -E ':(22|80|443|18001|18002|18003|18004)\b'
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}'
curl -sS -o /dev/null -w 'stock-mcp 18001: %{http_code}\n' http://127.0.0.1:18001/healthz
sudo ss -ltnp | grep ':22222\b' || true
sudo ufw status numbered | grep -E '22222|51\.79\.130\.16' || true
```

预期 `22222` 和只允许 `51.79.130.16` 的临时 UFW 规则均无输出；不得重新引入。`18004` 在启动 green 前必须空闲。若 18002/18003 的现有监听不属于本项目，或 `nginx -t` 失败，停止部署并先查清所有权。保存当前 Nginx 配置快照，且不要覆盖已有同名站点。

发布前先创建独立、可丢弃的 PostgreSQL 测试库。`TEST_DATABASE_URL` 的数据库名必须为 `xero_mcp_test` 或以 `xero_mcp_test_` 开头；完整测试会执行 migration 并写入/清理测试数据，绝不能指向服务数据库、`xero_mcp`、`postgres`、`template0` 或 `template1`。

然后在项目根目录运行全部发布硬门槛：

```sh
npm run typecheck
npm test
npm run test:http:required
TEST_DATABASE_URL='postgresql://.../xero_mcp_test_release_20260807' npm run test:postgres:required
npm run build
sh deploy/scripts/verify-static.sh
```

`test:http:required` 强制开启本地 HTTP loopback 并执行 OAuth discovery/challenge edge；`test:postgres:required` 缺少 URL、URL 不是 PostgreSQL，或数据库名不符合安全测试库规则时必须阻断发布。默认 `npm test` 中的条件跳过不能替代这两个结果。

`deploy/.env.vps` 的占位检查必须无输出：

```sh
grep -nE 'REPLACE_WITH|example\.com' deploy/.env.vps
```

发布前必须确认两个镜像变量均存在、互不相同，并记录现有 blue Xero、QuickBooks、PostgreSQL 的 container ID、image ID 与 startedAt。发布后这些值用于证明后两者没有被重建或重启。以下命令不输出 Secret：

```sh
XERO_IMAGE_REF=$(sed -n 's/^APP_IMAGE=//p' deploy/.env.vps)
QUICKBOOKS_IMAGE_REF=$(sed -n 's/^QUICKBOOKS_APP_IMAGE=//p' deploy/.env.vps)
test -n "$XERO_IMAGE_REF"
test -n "$QUICKBOOKS_IMAGE_REF"
test "$XERO_IMAGE_REF" != "$QUICKBOOKS_IMAGE_REF"
printf 'candidate Xero image: %s\n' "$XERO_IMAGE_REF"
docker image inspect "$QUICKBOOKS_IMAGE_REF" --format 'QuickBooks image: {{.Id}}'
QB_ID_BEFORE=$(docker compose --project-directory . --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml ps -q quickbooks-mcp)
PG_ID_BEFORE=$(docker compose --project-directory . --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml ps -q postgres)
QB_STARTED_BEFORE=$(docker inspect "$QB_ID_BEFORE" --format '{{.State.StartedAt}}')
PG_STARTED_BEFORE=$(docker inspect "$PG_ID_BEFORE" --format '{{.State.StartedAt}}')
test -n "$QB_ID_BEFORE" && test -n "$PG_ID_BEFORE"
docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml \
  config --images
```

本次不得 build、运行 migration、`up`、restart 或 recreate QuickBooks/PostgreSQL；stock/trade 同理。QuickBooks 的旧镜像值仅用于完整渲染主 Compose 和连续性核对，不代表本次要发布它。

## 5. 构建、迁移与启动

### 5.1 只构建 Xero 0.3.0

主 Compose 只用于构建新 Xero 镜像和访问已经运行的 PostgreSQL；不得对其中的常驻服务执行 `up`：

```sh
docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml \
  config --quiet

docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml \
  build --pull accounting-mcp
docker image inspect \
  xero-accounting-mcp-demo:0.3.0-xero-pilot-20260810.1 \
  --format 'Xero 0.3.0 image: {{.Id}}'
```

### 5.2 迁移：有界锁等待，但不是严格零中断

先执行只读防重检查，再只用 0.3.0 Xero 镜像运行一次 migration job；`--no-deps` 保证 Compose 不启动或重建 PostgreSQL/QuickBooks：

```sh

# 必须先通过只读 Xero 历史防重检查。退出码 3 表示发现冲突组；
# 此时立即停止，禁止自动删除、合并或继续迁移。
docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml \
  exec -T postgres sh -eu -c \
  'psql -v ON_ERROR_STOP=1 -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < scripts/preflight_xero_duplicate_guards.sql

docker compose \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml \
  run --rm --no-deps accounting-mcp npm run migrate
```

`016_xero_document_type_duplicate_guards.sql` 对 `posting_requests` 执行 `ALTER TABLE`、替换约束和重建非 concurrent 索引。它设置 `SET LOCAL lock_timeout = '5s'`（即 `lock_timeout = 5s`）：5 秒内拿不到锁就失败并停止发布，不会无限等待；拿到锁时，访问该表的 Xero 请求仍可能短暂停顿。因此 blue/green 可以让应用切流接近零中断，但数据库 migration lock **不能承诺严格零中断**。本流程能保证不重启 QuickBooks、stock、trade；若业务要求 Xero 也严格零停顿，必须先把 016 改造成 expand/contract 在线迁移或安排维护窗口，不能直接执行本节。

`020_xero_runtime_readiness_compatibility.sql` 会把 0.3 的五项强索引保留为 `v030` 专用名称，并以五个原名恢复 Xero 0.2.13 与 QuickBooks 0.2.12 shared repository 分别会精确核验的旧定义。上面的只读 preflight 必须同时确认以下三类冲突组均为 `0`：`actor + tenant + request_id + create_operation`（包括跨 `document_type`）、旧 active states 下的 `tenant + source_sha256`、以及旧 active states 下的 `tenant + contact + reference`（包括 ACCREC 和跨类型）。后两项 tenant 全局检查同时覆盖 QuickBooks shared repository 所需 actor-scoped 旧索引的冲突集合。020 在首个 rename 前还会精确核验五个源索引的 btree/unique/valid/ready、key 顺序及 016 predicate；任何 catalog drift 都以 `55000` 停止，不能把漂移状态记成已迁移。任何一组非零都停止发布；migration 本身仍会在事务内 fail-closed，失败时索引 rename 与 migration 记录一起回滚。

这是滚动部署期的**临时兼容约束**：旧 supplier-reference 索引没有 `document_type`，所以会临时把 ACCREC 的 contact/reference 也视为唯一，收紧 016 原本允许的 ACCREC reference 复用。若必须保留该复用语义，唯一干净路径是先升级/修补旧 Xero 0.2.13 readiness 或停止并行运行旧 Xero；不能在不改旧 runtime 的前提下伪造一个既通过其 exact unique/valid/ready 检查、又不产生该约束的索引。QuickBooks runtime 不需要也不得因此修改。

migration 成功后不得对旧 blue 做 schema rollback。保持其 `XERO_WRITE_ENABLED=false`，它仅作为读侧入口回滚；失败时保留完整日志并停止，不启动 green。

### 5.3 启动隔离的 18004 green

确认现有网络后，只用 green Compose 启动 Xero。该文件不拥有 PostgreSQL、QuickBooks、Nginx、stock 或 trade：

```sh
docker network inspect xero-accounting-mcp-demo_egress >/dev/null
docker network inspect xero-accounting-mcp-demo_data >/dev/null

XERO_WRITE_ENABLED=false docker compose \
  --project-name xero-accounting-mcp-green-030 \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.green.vps.yaml \
  config --quiet

XERO_WRITE_ENABLED=false docker compose \
  --project-name xero-accounting-mcp-green-030 \
  --project-directory . \
  --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.green.vps.yaml \
  up -d --no-deps --no-build --wait --wait-timeout 120 accounting-mcp-green
```

公网此时仍指向 18002 blue。切流前先从 loopback 验证版本、工具契约和依赖连续性：

```sh
docker compose --project-name xero-accounting-mcp-green-030 \
  --project-directory . --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.green.vps.yaml \
  ps accounting-mcp-green
GREEN_CONTAINER_ID=$(docker compose --project-name xero-accounting-mcp-green-030 \
  --project-directory . --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.green.vps.yaml \
  ps -q accounting-mcp-green)
test -n "$GREEN_CONTAINER_ID"
test "$(docker inspect "$GREEN_CONTAINER_ID" --format '{{json .Config.Cmd}}')" = \
  '["npm","run","start"]'
sudo ss -ltnp | grep -E ':(18002|18003|18004)\b'

GREEN_HEALTH=$(curl -fsS -H 'Host: mcp.jiayuanwang.xyz' \
  http://127.0.0.1:18004/healthz)
printf '%s' "$GREEN_HEALTH" | grep -F '"status":"ok"'
printf '%s' "$GREEN_HEALTH" | grep -F '"version":"0.3.0"'
printf '%s' "$GREEN_HEALTH" | grep -F '"toolCount":44'
printf '%s' "$GREEN_HEALTH" | grep -F \
  '"toolsetHash":"d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224"'
curl -fsS -H 'Host: mcp.jiayuanwang.xyz' http://127.0.0.1:18004/readyz

QUICKBOOKS_IMAGE_REF=$(sed -n 's/^QUICKBOOKS_APP_IMAGE=//p' deploy/.env.vps)
QUICKBOOKS_CONTAINER_ID=$(docker compose --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml ps -q quickbooks-mcp)
test -n "$QUICKBOOKS_CONTAINER_ID"
test "$(docker inspect "$QUICKBOOKS_CONTAINER_ID" --format '{{.Image}}')" = \
  "$(docker image inspect "$QUICKBOOKS_IMAGE_REF" --format '{{.Id}}')"
test "$(docker compose --project-directory . --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml ps -q quickbooks-mcp)" = "$QB_ID_BEFORE"
test "$(docker inspect "$QB_ID_BEFORE" --format '{{.State.StartedAt}}')" = "$QB_STARTED_BEFORE"
test "$(docker compose --project-directory . --env-file deploy/.env.vps \
  -f deploy/docker-compose/compose.host-nginx.vps.yaml ps -q postgres)" = "$PG_ID_BEFORE"
test "$(docker inspect "$PG_ID_BEFORE" --format '{{.State.StartedAt}}')" = "$PG_STARTED_BEFORE"

curl -fsS -H 'Host: mcp.jiayuanwang.xyz' http://127.0.0.1:18003/healthz
curl -fsS -H 'Host: mcp.jiayuanwang.xyz' http://127.0.0.1:18003/readyz
```

## 6. Nginx、Xero 与 Agent2 配置

### 6.1 Nginx

首次建站时，先安装 `deploy/host-nginx/mcp.jiayuanwang.xyz.bootstrap` 完成 ACME HTTP-01，再原子替换为 `deploy/host-nginx/mcp.jiayuanwang.xyz`。已上线站点不得在本次发布中整体覆盖。每次只在 `sudo nginx -t` 成功后执行 graceful reload。最终只启用一个包含共享 `log_format`、限流 zone 和 upstream 的完整 MCP 站点，不能同时启用新旧完整站点。该站点必须代理：

- `/mcp`；
- `/.well-known/oauth-authorization-server`；
- `/.well-known/oauth-protected-resource` 与 `/mcp` path-specific 版本；
- `/authorize`、`/token`、`/revoke`；
- `/oauth/xero/callback`、`/oauth/xero/select`；
- `/xero/organisation-switch`，只接受短效一次性票据和同页 CSRF 确认。
- `/quickbooks/mcp`、QuickBooks OAuth metadata 与 `/quickbooks/oauth/*`；
- `/oauth/quickbooks/callback`、`/quickbooks/review/*`。

访问日志只记录 `$uri`；`/authorize` 与 Xero callback 的边缘错误日志被抑制，避免 query 中的 state/code 泄漏。

green 在 18004 完成 loopback 验证后，安装切流工具并进行原子切换：

```sh
sudo install -o root -g root -m 0700 \
  deploy/scripts/switch-xero-upstream.sh \
  /usr/local/sbin/switch-xero-upstream.sh
sudo /usr/local/sbin/switch-xero-upstream.sh status
sudo /usr/local/sbin/switch-xero-upstream.sh green
```

工具只允许把 `xero_accounting_mcp_demo` 在 18002/18004 之间切换；它先验证目标 health/ready。green 必须严格返回 ready，并精确匹配 0.3.0、44 个工具和工具集指纹。migration 020 成功后的常规 blue 回滚只允许目标 `18002`，其 health 必须为 HTTP 200、`status=ok`、`version=0.2.13`，ready 必须为 HTTP 200 的精确 `{"status":"ready","version":"0.2.13"}`。

只有 migration 020 尚未恢复 legacy readiness、且确认必须应急恢复读侧入口时，才允许显式执行 `sudo ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true /usr/local/sbin/switch-xero-upstream.sh blue`。此 break-glass 仅额外接受 HTTP 503 的精确 `{"status":"not_ready","version":"0.2.13"}`；脚本还必须通过 Docker 找到唯一同时匹配 Compose service `accounting-mcp` 和发布端口 18002 的运行中容器，精确核验绑定为 `3000/tcp|127.0.0.1|18002`，且唯一 `XERO_WRITE_ENABLED` 配置为 `false`。Docker 不可用、容器数量不唯一、绑定或环境无法精确证明时全部 fail-closed。loopback 预检与公网切换后检查执行相同规则，成功时输出 `WARNING=BLUE_FORWARD_SCHEMA_NOT_READY_BREAK_GLASS` 和 `BLUE_BREAK_GLASS_READ_ONLY_VERIFIED=true`。任何其他状态码、字段、版本或 body 都 fail-closed。

上述 blue 兼容例外不放宽 QuickBooks：工具仍在 Xero 切换前后检查 QuickBooks 公网 health/ready，upstream 必须始终为 18003。工具保留 root-only Nginx 备份，以同目录临时文件加原子 `mv` 替换站点，再执行 `nginx -t`、graceful reload 和公网验证。

只有实际发生 graceful reload 的切换才进入短时公网 settle：最多 3 次、相邻尝试 sleep 1 秒，每个公网请求 `curl --max-time 1`，因此 3 轮完整 Xero health/ready 与 QuickBooks health/ready 加 2 次 sleep 的配置等待上限为 14 秒；实际墙钟耗时还会有少量进程调度与解析开销。每一轮都先按目标端口对应的原有精确 Xero status/body/version/toolCount/toolsetHash 规则验证，再完整验证 QuickBooks health、provider 与 ready；两者必须在同一轮全部通过才算切流成功。首次仍命中旧 Nginx worker 只会进入下一轮，不会立即误恢复；3 轮仍失败时，继续按原有 Xero 或 QuickBooks `...UPSTREAM_RESTORED` / `...UPSTREAM_RESTORE_FAILED` 路径处理，不放宽任何门槛。目标已经 active 时不发生 reload，仍保持一次公网检查、`CHANGED=false`，不执行 settle sleep。

所有切流后恢复路径都必须从本次 root-only 备份原子恢复站点文件，精确确认 Xero 已回到原端口、QuickBooks upstream 仍为 18003，再对恢复配置执行 `nginx -t` 和 `systemctl reload nginx`。只有以上步骤全部成功，才能输出 `...UPSTREAM_RESTORED`；例如首次 reload 失败但恢复成功时输出 `ERROR=NGINX_RELOAD_FAILED_AND_UPSTREAM_RESTORED`。该状态只证明配置与 reload 已恢复，命令仍为非零退出；操作员随后必须按上文普通 200 或显式 break-glass 规则人工复核旧公网 health/ready，不能把 `RESTORED` 直接等同于业务恢复。首次 reload、目标公网检查或 QuickBooks 公网检查失败后，如果恢复本身失败，必须分别输出 `ERROR=NGINX_RELOAD_FAILED_AND_UPSTREAM_RESTORE_FAILED`、`ERROR=PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORE_FAILED` 或 `ERROR=QUICKBOOKS_PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORE_FAILED`；首次 `nginx -t` 与恢复配置都失败时输出 `ERROR=NGINX_CONFIG_REJECTED_AND_UPSTREAM_RESTORE_FAILED`。任何 `...RESTORE_FAILED` 都停止后续发布并由运维从 `/var/backups/xero-mcp-nginx` 核对恢复，禁止继续触发其他 Nginx reload。切绿成功后保留 18002 blue 运行，直到全部 UAT 通过。

### 6.2 Xero Developer App

Xero App 只注册以下 callback：

```text
https://mcp.jiayuanwang.xyz/oauth/xero/callback
```

最小能力包含身份、offline refresh、settings read、contacts read、invoices 以及 trial balance read。不要连接银行；测试 Organisation 的非必要 onboarding 可跳过。

### 6.3 Intuit Development App

QuickBooks Sandbox App 注册以下 callback：

```text
https://mcp.jiayuanwang.xyz/oauth/quickbooks/callback
```

迁移期间可以暂留旧 callback 作为短时回滚入口；新域名完成 OAuth 重连与回读后再移除。不能把 Agent2 callback 配进 Intuit App。

### 6.4 Agent2

只修改现有 MCP slots，不创建同名或相似的第二份配置：

- `accounting-mcp` URL：`https://mcp.jiayuanwang.xyz/mcp`；
- `quickbooks-accounting-mcp` URL：`https://mcp.jiayuanwang.xyz/quickbooks/mcp`；
- 认证方式：OAuth；
- 使用与 VPS `HOST_OAUTH_CLIENTS_JSON` 完全相同的 client ID / secret；
- callback 保持系统给出的精确值，不创建第二个相似 slot；
- `accountingv2-2` 不改动。

Work/LibreChat 只作为兼容性参考，不承担本次线上验收。

## 7. 分层验收

### 7.1 协议与边缘

```sh
curl -fsS https://mcp.jiayuanwang.xyz/healthz
curl -fsS https://mcp.jiayuanwang.xyz/readyz
curl -fsS https://mcp.jiayuanwang.xyz/.well-known/oauth-authorization-server
curl -fsS https://mcp.jiayuanwang.xyz/.well-known/oauth-protected-resource/mcp
curl -i https://mcp.jiayuanwang.xyz/mcp
curl -fsS https://mcp.jiayuanwang.xyz/quickbooks/healthz
curl -fsS https://mcp.jiayuanwang.xyz/quickbooks/readyz
curl -fsS https://mcp.jiayuanwang.xyz/.well-known/oauth-protected-resource/quickbooks/mcp
curl -i https://mcp.jiayuanwang.xyz/quickbooks/mcp
```

预期：

- health/ready 200；Xero `/healthz` 必须精确包含 `version=0.3.0`、`toolCount=44` 和 `toolsetHash=d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224`；Agent2 连接后的 `tools/list` 必须恰好返回同一 44 个工具；
- metadata 只发布 Authorization Code、refresh、S256、`client_secret_basic` / `client_secret_post`、`xero.read` 与 `xero.draft.write`；
- Xero resource 精确为 `https://mcp.jiayuanwang.xyz/mcp`，QuickBooks resource 精确为 `https://mcp.jiayuanwang.xyz/quickbooks/mcp`，bearer method 只有 header；
- 无 Token 的 `/mcp` 返回 401，并带 path-specific `resource_metadata` challenge；
- health、错误、日志不含 Tenant、Token、client secret、数据库 URL、code 或 state。

### 7.2 真人连接

1. 在 Agent2 的 `accounting-mcp` 点击连接。
2. 浏览器进入 Xero，授权测试账号。
3. 回到 Broker 页面，明确选择测试 Organisation。
4. 浏览器回跳 Agent2；Agent2 自动用 code + verifier 换取并保存自己的 OAuth token。
5. 再次发起同一 callback/code、错误 verifier、错误 resource 均必须失败。
6. Personal POC 出现第二个 active installation 时必须 fail closed。

### 7.3 会计用户主流程

先保持 `XERO_WRITE_ENABLED=false`：

1. “告诉我当前连接的是哪个 Xero 公司、币种和组织信息。”
2. “把最近的客户发票、供应商账单和付款情况看一下，告诉我哪些逾期、哪些已经结清。”
3. “帮我找这个客户和供应商的历史单据，再跟我刚上传的材料对一下，有差异先问我。”
4. “把最近的 credit note、quote、purchase order、manual journal、bank transaction 和 trial balance 都看一下，指出需要会计复核的异常，不要写入。”
5. “读取联系人、科目、税率和非库存 item；分别为 Bill、Sales Invoice、Quote、Purchase Order、Credit Note、Manual Journal 准备草稿方案，只展示，不创建。”

以上步骤必须证明短问、长材料、多轮澄清和跨工具连续对话都能完成。Agent 不得把“准备完成”误报成“已写入”，也不得调用未开放的高风险动作。

只读与 prepare 通过后，才安装精确版本的临时写闸。脚本持久配置始终保留 `XERO_WRITE_ENABLED=false`，只允许 tenant `7c3cc738-eef0-4d4e-83f8-d528390e1e61`，每次 open 都创建独立自动关闭 timer，固定 `AUTOCLOSE_DELAY="15m"`：

```sh
sudo install -o root -g root -m 0700 \
  scripts/agent2_uat_write_gate_vps.sh \
  /usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1
sudo /usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1 install-failsafe
sudo systemctl start xero-write-gate-boot-close-030-20260810-1.service
sudo /usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1 preflight
sudo /usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1 open
sudo /usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1 status
```

open 之前脚本会精确校验 0.3.0 image、44-tool contract、单一 active installation/binding、目标 tenant、公开 resource，以及 QuickBooks/PostgreSQL container 连续性。open 的同一次 Compose create 已直接使用 `XERO_RESTART_POLICY=no`，不存在先以 `unless-stopped` 创建、随后再修改策略的窗口；close、15 分钟自动关闭和 boot-close 则从创建瞬间使用 `unless-stopped`。自动关闭与 boot-close 都是 `Restart=on-failure`，最多 4 次启动（首次加最多 3 次重试），间隔 15 秒，限制在 15 分钟窗口内。boot-close 继续只是 Nginx 的非阻断 Wants；Docker 持续故障不会把共享 443 变成 Requires 依赖。`status` 在写闸开启时必须同时输出并验证 timer 触发目标、oneshot service、实际 restart policy、重试上限和当前重试次数；缺少或漂移即失败。写入窗口内只用合成材料走代表性 DRAFT：

6. Agent 先展示完整拟写入字段、目标 Organisation、业务类型、金额/税额和幂等依据；用户在当前对话明确确认。
7. 创建一张 DRAFT Bill 并按 Invoice ID 立即回读；重复相同请求不得产生第二张。
8. 创建一张 DRAFT Sales Invoice 并立即回读；确认 ACCREC/ACCPAY 不串型。
9. 从 Quote、Purchase Order、Credit Note、Manual Journal 中选择一个与演示材料匹配的类型，创建 DRAFT 并立即回读。
10. 在 Xero UI 核对每种类型都只有预期记录；保存 MCP receipt、Xero ID、状态和 read-back 对照。
11. 不等 15 分钟，验收结束立即主动关闭并复查：

```sh
sudo /usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1 close
sudo /usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1 status
```

即使操作员忘记 close，timer 也会在 15 分钟后只重建 18004 green 为写关闭状态，不重启 QuickBooks/PostgreSQL。AUTHORISE/SUBMIT/POST、Payment/Allocation、Bank 写入、最终 reconciliation、Void/Delete、Attachment、Account/Tax 写入均不验，也不能把分析表述为报税或关账完成。

### 7.4 撤销与重连

1. Agent2 提交 refresh token 到 `/revoke`。
2. 旧 refresh family、派生 access token、installation 和 binding 同时失效。
3. 旧 MCP token 立即返回 401。
4. 同一 Personal POC 可以重新走一次完整连接；旧记录不能阻塞。

## 8. 回滚

应用、OAuth 或公网验收失败时，先做无构建、无容器重启的入口回滚：

```sh
sudo /usr/local/sbin/switch-xero-upstream.sh blue
curl -fsS https://mcp.jiayuanwang.xyz/healthz
curl -sS -w '\nHTTP %{http_code}\n' https://mcp.jiayuanwang.xyz/readyz
```

切回 blue 后立即确认 QuickBooks 18003 和 stock 18001 仍健康；写闸保持/恢复关闭。green 可先留在 18004 便于排障，确认不再需要后只停止 `accounting-mcp-green`，不得对主 Compose 执行 `down`。

- `switch-xero-upstream.sh blue` 只替换 Xero upstream、执行 `nginx -t` 和 graceful reload；QuickBooks upstream 必须继续为 18003。
- migration 已成功时不做数据库逆迁移；`016_xero_document_type_duplicate_guards.sql` 的 schema 保留，旧 blue 只能在 `XERO_WRITE_ENABLED=false` 下作为读侧回滚。migration 020 成功后常规回滚必须拿到 200 ready，不得设置 `ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY`。只有 020 尚未成功且满足上文容器只读证明时，才可使用显式 break-glass 接受精确 503；除此以外的 schema 不兼容一律停止并进入维护处置，禁止用删列/删表恢复。
- 不修改 `QUICKBOOKS_APP_IMAGE`，不 build/restart/recreate QuickBooks、PostgreSQL、stock 或 trade。
- 不执行 `down -v`，不删除 PostgreSQL 目录，不暗中撤销 Xero 全局授权，也不重新开放临时 SSH 22222/UFW 规则。
- 只有明确决定回到 legacy 单人模式时，才可单独评审 `MCP_OAUTH_BROKER_ENABLED=false`；这不是常规 0.3.0 回滚动作。

## 9. 交付口径

必须分别记录：

| 层级 | 可用表述 |
|---|---|
| 本地测试通过 | “OAuth Broker 与绑定逻辑已在本地/测试数据库通过” |
| Hetzner green 部署通过 | “0.3.0 已在 18004 通过精确版本、44-tool contract、ready 与依赖连续性检查，尚未切流” |
| Hetzner 切流通过 | “公网已切至 0.3.0 green，blue 18002 保留可回滚，QuickBooks/stock/trade 未重启” |
| Agent2 真人连接通过 | “Agent2 单人 Xero Personal POC 已连通” |
| 会计主流程通过 | “Agent2 已完成存量读取、材料分析、受确认 DRAFT 写入、Xero 精确回读与写闸关闭” |

在稳定可信 Host workspace/user/agent assertion 上线前，不得表述为团队级身份隔离；在第 7.3 节未完成前，不得表述为完整会计自动化。
