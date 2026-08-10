# 给录制 Agent 的启动指令

下面内容可以原样交给负责操作电脑和录屏的 Agent。

---

你负责录制 Xero MCP 老板演示视频。目标不是做技术测试，而是模拟一名真实会计在 Work 中连接 Xero、检查客户账务并切换客户公司。

开始前必须完整阅读：

1. `/Users/jiayuanwang/Documents/Workflow - accounting/xero-boss-demo-video-plan-2026-08-10/00-录制前检查.md`
2. `/Users/jiayuanwang/Documents/Workflow - accounting/xero-boss-demo-video-plan-2026-08-10/05-Agent录制执行手册.md`
3. 本次要录的视频脚本：`01-首次连接并选择公司.md`、`02-会计接手客户并快速体检.md` 或 `03-从对话切换客户公司.md`
4. `/Users/jiayuanwang/Documents/Workflow - accounting/xero-boss-demo-video-plan-2026-08-10/04-成片验收与重录门槛.md`

执行要求：

- 一次只录一条视频；先无录屏彩排，再恢复起始状态，再正式录制。
- 接管 Chrome 和录屏工具完成操作；录屏画面只能包含 Work/Xero 浏览器业务页面和普通箭头光标。
- 首选 OBS 单窗口捕获；没有 OBS 时使用 macOS `Shift–Command–5` 录制所选部分。
- 不显示 Agent 控制界面、AI 接管提示、自动化高亮、点击光圈、终端、通知或其他标签页。
- 严格使用脚本里的自然会计话术，不说 MCP 工具名、接口名、内部 ID 或测试术语。
- 长提示词一次粘贴，短句自然输入；发送前停 1 秒。
- 回答生成期间不滚动；完成后按 280–420px 一段缓慢滚动，每个重点停留 2–3 秒。
- 不展开工具 JSON 或调试信息。
- 不创建、修改、批准、付款、对账、删除或作废任何 Xero 记录。
- 只能使用预先批准的 Demo Company 和 zcloak。视频 03 结束后必须在录制外切回 Demo Company，并回读 USD。
- 出现错误、敏感信息、组织不一致、AI 接管提示或任何写入调用时，立即停止录制；不要在成片中修复，恢复状态后重录。

正式录制前先给出一条简短状态：

`预检完成；当前 Organisation：___；写入关闭；录屏范围测试通过；准备录制视频 __。`

录制完成后：

1. 按 `materials/Agent录制日志模板.md` 填写日志；
2. 回看成片并逐项核对《04-成片验收与重录门槛》；
3. 只有全部通过才报告 PASS；
4. 返回视频文件路径、Work 对话链接、起止 Organisation、是否零写入，以及视频 03 的 Demo Company / USD 恢复结果。

不要自行增加第四条视频，不要演示正式写入，不要改变 Xero Developer App、MCP 配置或服务器设置。

