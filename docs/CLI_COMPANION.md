# CLI 顶部角色动效

顶部居中显示网页版的 R 形角色：3 行点阵和 1 行状态文字。它占用独立布局空间，不覆盖对话和输入框。角色本身约 6 列 × 3 行；交接动作在 16 列范围内移动。

`/animation` 每次调用切换显示开关，默认开启，立即生效并保存到终端用户设置。关闭后停止角色动画计时器并收起四行空间，不弹确认窗口。现有 `motion=reduced` 设置保留静态角色；窗口少于 18 行时临时隐藏角色，放大后恢复，不改保存的偏好。

## 网页复用与终端重构

- 直接复用 `web/chat/companion-state.ts` 的真实活动状态和状态文字。
- 轮廓取自原有 `src/ui/assets/agents/roppo-body.webp` 的透明度采样。终端以 Unicode Braille 点阵重绘，无新增图片依赖，也不要求终端支持图片协议。
- 参考 `roppo-character.tsx`、`companion.css` 和 `companion-scene.tsx`：1.18 秒入场招手、4.8 秒呼吸、5.8 秒眨眼周期、思考探头、敲键盘、查阅、完成摆动和 6 秒交接。因终端点阵分辨率有限，曲线、渐变和亚像素位移做了离散化近似。
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
