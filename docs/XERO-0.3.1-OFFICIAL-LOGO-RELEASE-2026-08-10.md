# Xero 官方 Logo 上线记录

日期：2026-08-10  
结论：`DEPLOYED / DESKTOP PASS / MOBILE PASS / ZERO XERO WRITES`

## 变更

- 使用 Xero 官方 media downloads 提供的 `xero-logo-hires-RGB.png`，透明 PNG，1000×1000。
- 原文件不裁切、不改色、不拉伸；桌面显示 76×76，移动端显示 70×70。
- 移除旧的横向截图式 Logo 外框；授权卡片结构、文案、组织列表和按钮未改变。
- 资源来源、使用约束和哈希记录在 `src/oauth/assets/README.md`。

## 验证

| 检查 | 结果 |
|---|---|
| TypeScript 类型检查 | PASS |
| 默认完整回归 | 819/819 PASS；52 条条件跳过 |
| OAuth 页面聚焦回归 | 17/17 PASS |
| 构建 | PASS |
| 公网健康检查 | 0.3.1 / 44 tools / ready |
| 桌面原图 / 显示尺寸 | 1000×1000 / 76×76 |
| 390px 移动端原图 / 显示尺寸 | 1000×1000 / 70×70 |
| 移动端页面宽度 | `scrollWidth=390`、`clientWidth=390`，无横向溢出 |
| Xero 写入 | 0 |

线上镜像：`xero-accounting-mcp-demo:0.3.1-xero-pilot-20260810.2`  
线上 Release：`/opt/xero-accounting-mcp-demo-0.3.1-20260810.2`

## 视觉一致性核对

1. zCloak AI 品牌、卡片位置和页面背景保持不变。
2. `XERO CONNECTION`、标题、说明和底部安全文案保持不变。
3. 组织列表、当前连接状态、主按钮结构保持不变。
4. Xero 标识替换为官方圆形透明资产，视觉中心和留白更准确。
5. 桌面卡片宽度、分区和排版节奏未变化。
6. 390×844 下文案自然换行，列表和按钮完整可见，无横向溢出。

Above-fold 文案差异：无。唯一可见变化是 Xero Logo 资产与显示容器。

## 通用化建议

后续建立 provider brand registry：每个 Provider 固定记录官方资产、来源、版本、哈希、alt、适用背景和留白规则。OAuth 页面只读取本地缓存并通过 CSP 允许的静态资源加载；favicon 仅作为无官方资产时的降级方案，不在运行时直接请求第三方网站，避免低清、错域名标识、跟踪和加载失败。
