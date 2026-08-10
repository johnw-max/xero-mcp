# Xero Trial Balance Provider 资源边界

状态：本地实现与真实 socket 回归通过；未部署。

## 为什么边界必须放在 Provider 下载层

MCP 返回层已有 128 KiB 和递归元素上限，但该边界发生在 Xero 响应已经下载、解压、JSON 解析并由 SDK 反序列化之后。若上游返回无限 chunked body、伪造超大 body、gzip 高膨胀内容或长期不结束的响应，进入 MCP 边界器前就可能耗尽连接、内存或 CPU。

安全不变量是：Trial Balance 响应必须先在网络流上满足 deadline、压缩前字节数和解压后字节数上限，才允许执行 `JSON.parse` 和 Xero 模型映射。

## xero-node 19.0.0 结论

`AccountingApi.getReportTrialBalance(..., options)` 的生成代码只合入 `options.headers`，随后直接调用模块级 axios。它没有把逐请求的 `signal`、`timeout`、`maxContentLength`、`decompress` 等配置向下传递。

因此未采用以下方案：

- `Promise.race`：只会提前返回，不能停止后台 socket、下载、解压或解析；
- 修改全局 axios defaults/interceptor：并发请求会共享可变状态，存在跨请求竞态；
- 先让 SDK 下载再检查对象大小：边界位置太晚。

当前只为 Trial Balance 使用专门的 Node 流式 transport；其他 Xero SDK 调用保持不变。transport 在有界 JSON 解析后继续调用 xero-node 公开导出的 `ObjectSerializer.deserialize(..., "ReportWithRows")`，保持原 SDK 的字段和日期映射。

## 固定边界

| 边界 | 当前值 | 执行动作 |
|---|---:|---|
| 请求 deadline | 15 秒 | AbortController 取消真实 HTTP(S) 请求并销毁流 |
| 压缩前/raw body | 2 MiB | Content-Length 预检及流式逐 chunk 计数，超限销毁连接 |
| 解压后 body | 8 MiB | gzip/deflate/br 解压后的独立流式计数，超限销毁连接 |
| Content-Encoding | identity/gzip/x-gzip/deflate/br | 其他编码拒绝且销毁连接 |
| JSON/模型映射 | 仅在以上边界全部通过后 | 解析失败返回安全 Provider 错误，不回显 body 或凭证 |

deadline、raw 限额与解压限额均为每次请求独立状态，不修改全局 HTTP/axios 配置。调用方传入 AbortSignal 时，也会传播到真实 socket。

## 错误与凭证边界

失败只返回稳定 reason，例如：

- `UPSTREAM_DEADLINE_EXCEEDED`
- `UPSTREAM_REQUEST_CANCELLED`
- `RAW_RESPONSE_TOO_LARGE`
- `DECOMPRESSED_RESPONSE_TOO_LARGE`
- `UNSUPPORTED_CONTENT_ENCODING`
- `INVALID_JSON_RESPONSE`

错误不包含 Authorization header、access token、Xero response body 或完整请求对象。Provider 从 `XeroClientManager.withAccessToken` 取得刷新后的 request-scoped token，Tenant 仍来自服务端绑定的 connection。

## 回归证据

专门测试通过真实本地 HTTP socket 覆盖：

1. 正常 chunked Xero JSON 保留官方 SDK 字段映射；
2. 无 Content-Length 的持续 chunked body 在 raw 超限时中止，服务端观察到未正常结束的连接被销毁；
3. 超大 Content-Length 在下载 body 前中止；
4. 小体积 gzip 在解压膨胀超过上限时中止；
5. 上游不响应时由 deadline 中止 socket；
6. 调用方主动取消时立即中止 socket；
7. Provider 只在 manager 完成 refresh/binding 后把 token 与固定 Tenant 交给有界 transport。

这些测试不调用线上 Xero，也不修改 MCP Trial Balance transform、MCP 工具定义或 QuickBooks。
