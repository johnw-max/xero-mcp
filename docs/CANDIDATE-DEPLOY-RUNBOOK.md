# 候选版本部署手册

记录 2026-08-19 部署候选 072 时实际踩到的坑,以及避开它们的顺序。手工部署路径不经过
`production-deployment-admission.mjs`,所以那里的守卫在这里不生效,顺序必须自己守。

## 前置

- 主机 `178.156.234.230`,SSH 端口 **2222**(不是 22),仅从 VPN 出口 IP 可达。
  怀疑主机不可达时先 `hcloud firewall describe`,不要先怀疑主机。
- 候选目录 `/srv/xero-accounting-mcp/releases/<NNN>-<slug>-<shortid>/`
- 容器端口从 18031 起递增;**先查占用**,`docker ps` 与 `lsof -nP -iTCP -sTCP:LISTEN`
  都要看——失败容器会留下端口分配。
- nginx 上游在 `/etc/nginx/sites-enabled/mcp.jiayuanwang.xyz`

## 顺序(每一步都有踩过的坑)

### 1. 先 `npm run build`

**坑**:发布包的构建身份从工作区读,不是从 `dist/` 重新编译。dist 陈旧会让身份里的
工具数与镜像里的不一致,冒烟测试才报错,那时已经浪费一整轮构建。

### 2. 构建发布包

```bash
node scripts/release/build-xero-release-bundle.mjs \
  --output-dir <OUT> \
  --approved-control-catalog-sha256 e488e6ed4cdbe665f214a65ce9d55d42ce1ac3adf54e77317078bb0ec7209fbe
```

记下输出的 `semanticBuildIdentityHash`,前 12 位就是候选目录名里的 shortid。

### 3. 构建 OCI 镜像

```bash
node scripts/release/build-accepted-oci-image.mjs \
  --context <OUT>/accepted-build-context \
  --output <OUT>/candidate.oci.tar \
  --metadata <OUT>/oci-metadata.json \
  --receipt <OUT>/oci-receipt.json \
  --approved-control-catalog-sha256 e488e6ed4cdbe665f214a65ce9d55d42ce1ac3adf54e77317078bb0ec7209fbe
```

需要本地 docker。仓库里**没有 Dockerfile**,镜像布局由这个脚本自己构造。

### 4. 传输并载入

`scp` 上传 `candidate.oci.tar` 与 `oci-receipt.json`,然后
`docker load -i candidate.oci.tar`,再 `docker tag` 成本候选的名字。

### 5. **重新生成 `XERO_BUILD_IDENTITY_JSON`,不要复制上一版的**

**这是最贵的坑。** 从上一个候选复制 `candidate.env` 会连带复制它的构建身份,
于是服务器**正常启动,并在公网 `/readyz` 上把上一版的身份当作事实公布**。
镜像其实烘焙了自己正确的身份,但运行时环境变量会静默覆盖它,进程无从分辨。

正确做法:从本候选的 `oci-receipt.json` 生成**恰好 10 个键**的投影
(`acceptanceSourceSha256`、`approvedControlCatalogSha256`、`releaseAttestationHash`、
`releaseSourceManifestSha256`、`releaseVersion`、`requiredMigration`、`schemaVersion`、
`sourceArchiveSha256`、`sourceBundleManifestSha256`、`toolsetHash`),
`schemaVersion` 固定为 `xero-oci-build-identity:v2`。多一个键或少一个键都会
`XERO_BUILD_IDENTITY_FIELDS_INVALID`。

更简单也更安全的做法:**candidate.env 里干脆不要这一行**,让镜像自己烘焙的值生效。

### 6. 起容器并核对

```bash
docker run -d --name xero-accounting-mcp-<NNN> --restart unless-stopped \
  --env-file candidate.env -p 127.0.0.1:<PORT>:3000 <IMAGE>
docker network connect xero-accounting-mcp-demo_data xero-accounting-mcp-<NNN>
curl -s http://127.0.0.1:<PORT>/readyz
```

**必须核对 `buildIdentityHash` 前 12 位等于第 2 步记下的值。** 不等就是踩了第 5 个坑。

同时确认 `writeMode: WRITE_ENABLED` 与 `requiredMigrationStatus: APPLIED`。

### 7. 切 nginx

改上游端口 → `nginx -t` → `systemctl reload nginx` → 再查一次公网 `/readyz`,
确认公网返回的构建身份就是新候选。

## 授权修订版本(改了常设委派才需要)

改动委派内容会改变授权快照。**不要为此提升 revision**——那会让所有旧构建的
授权钉子失效、静默降级为 READ_ONLY,形成回滚死锁。`contentHash` 与
`snapshotHash` 已分离正是为此。详见 `AUTHORITY-PIN-OPERATIONS.md`。

## 部署后必做

在真实 Xero 上跑一遍验收脚本,以 `xero_mutation_requests` 与 Xero 端直查为准,
**不采信 agent 自述**。本轮改了什么,就必须有一条脚本直接命中它。
