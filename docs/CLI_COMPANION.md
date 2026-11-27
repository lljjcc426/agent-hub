# CLI 顶部角色动效

顶部居中显示网页版的 R 形角色：3 行点阵和 1 行状态文字。它占用独立布局空间，不覆盖对话和输入框。角色本身约 6 列 × 3 行；交接动作在 16 列范围内移动。

`/animation` 每次调用切换显示开关，默认开启，立即生效并保存到终端用户设置。关闭后停止角色动画计时器并收起四行空间，不弹确认窗口。现有 `motion=reduced` 设置保留静态角色；窗口少于 18 行时临时隐藏角色，放大后恢复，不改保存的偏好。

## 网页复用与终端重构

- 直接复用 `web/chat/companion-state.ts` 的真实活动状态和状态文字。
- 轮廓取自原有 `src/ui/assets/agents/roppo-body.webp` 的透明度采样。终端以 Unicode Braille 点阵重绘，无新增图片依赖，也不要求终端支持图片协议。
- 参考 `roppo-character.tsx`、`companion.css` 和 `companion-scene.tsx`：4.8 秒呼吸、5.8 秒眨眼周期、思考探头、敲键盘、查阅、完成摆动和 6 秒交接。因终端点阵分辨率有限，曲线、渐变和亚像素位移做了离散化近似。
- 活跃状态切换沿用 1.4 秒稳定时间。首次载入不重放历史交接；关闭时的新交接不会在重新开启后补播。
- 网页代码和原贴图没有修改。

## 文件变更说明

| 文件 | 说明 |
| --- | --- |
| `src/terminal/companion.ts`（新增） | 原贴图点阵轮廓、动作绘制、真实状态与交接播放 |
| `src/terminal/tui-screen.ts` | 顶部居中区域、主题颜色、计时器与窄屏布局 |
| `src/terminal/settings.ts` | 默认开启的 `animation` 持久化设置 |
| `src/terminal/controls.ts` | `/animation` 开关及保存 |
| `src/terminal/tui-actions.ts` | 命令补全、设置入口和即时提示 |
| `src/terminal/commands.ts` | 命令说明 |
| `tests/terminal-companion.spec.ts`（新增） | 交接不重放、关闭后不补播、完成状态与减少动效 |
| `tests/terminal-settings.spec.ts` | 连续开关、重启读取及其他设置保留 |
| `tests/terminal-tui.ts` | 原生渲染的显示/隐藏、空屏滚动、窄屏输入框 |
| `docs/TERMINAL.md`、本文（新增） | 使用方法、复现范围和逐文件说明 |

没有删除项目文件。验证包括宿主 TypeScript 检查、38 项 CLI 测试、OpenTUI 原生渲染测试和已安装 CLI 的真实终端显示检查。

## 启动过场与网页入口更新

每次重新打开交互 CLI，首次读到会话后播放 2 秒全屏像素潮汐，角色从左往右走过、不招手；接着在顶部播放 1.4 秒探头、眨眼和挥手。按键、粘贴、点击或打开菜单可以跳过，输入不会丢失。关闭 `/animation`、减少动效或短窗口时跳过；刷新、调整窗口和重新启用开关不补播。

顶部移除 `/ personal`。底栏左侧 `Open web ↗` 打开同一段网页版对话，右侧 `Commands · ctrl+p` 打开可搜索的命令面板；中间空白不响应点击。预览的滑杆按钮属于预览工具，实际 CLI 没有该按钮。

网页与 CLI 共用同一本机服务和账号的数据。配置修改增加独立事件通知，保证网页修改模型后，空闲 CLI 也会更新；聊天事件编号保持原协议。测试使用两个入口验证模型和消息一致，没有修改用户现有模型或消息。

本次文件变更：

- `src/terminal/startup.ts`：新增终端全屏潮汐、行走和顶部探头动作绘制。
- `src/terminal/companion.ts`：复用角色轮廓，将启动招手移交给完整启动序列。
- `src/terminal/tui-screen.ts`：启动生命周期、跳过与清理，精简标题，拆分底栏点击区域。
- `src/terminal/tui-actions.ts`：网页版入口打开当前对话，成功后只给轻提示。
- `src/server.ts`、`src/terminal/client.ts`：配置变更通知与终端刷新。
- `tests/terminal-tui.ts`：原生渲染验证两段动画、每次启动、输入/鼠标跳过、窗口变化和底栏点击区域。
- `tests/terminal.spec.ts`：验证浏览器与 CLI 共享消息和配置，以及空闲时接收模型更新。
- `tests/terminal-tui-actions.spec.ts`：验证网页版入口使用当前对话地址。
- `docs/TERMINAL.md`、本文：更新使用方法与文件变更说明。

没有删除项目文件。

## 点阵漏点修正

保留原来的 12×12 点阵轮廓、Braille 字符、大小和布局。角色倾斜时改用目标像素反向采样，避免相邻源像素取整到同一位置、留下内部空洞；眼睛先在原轮廓中绘制，再一起变换。已复现并修复完成动画 1600ms、思考动画 1900ms 的身体漏点。

macOS Terminal 截图中每四排点之间的整行间隙属于终端盲文字形与行高的组合效果，本次算法修正不消除该间隙，也没有修改用户终端字体或替换为实心像素。

本次只修改 `src/terminal/companion.ts`（采样绘制）、`tests/terminal-companion.spec.ts`（漏点回归与原轮廓检查）和本文。没有删除文件。类型检查、点阵测试和原生 TUI 测试通过。
