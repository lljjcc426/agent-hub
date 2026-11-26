# CLI 与 Claude Code 的对齐范围

本分支以 Claude Code 的公开终端文档为交互参考，保留 Roppo 本机服务。CLI 与网页共享账号、会话、任务和文件；退出终端后，后台任务继续运行。实现代码沿用 Roppo 自己的终端编辑器和运行协议。

参考日期：2026-11-26。产品取舍以 [Roppo CLI 产品边界](CLI_PRODUCT.md) 为准，默认入口围绕用户与 Router 的持续对话。

## 已实现

| 范围 | Roppo 行为 |
| --- | --- |
| 界面 | 个人对话欢迎卡、暖色强调、固定输入区、公开 Router 进度、文件交付提示；内部任务按需展开 |
| 动效 | 发送、命令加载和执行活动动画，真实流式回复，减少动效设置；不抢滚动位置 |
| 输入 | 多行、括号粘贴、`@` 文件补全、斜杠菜单、搜索历史、草稿暂存 |
| 会话 | `-c`、`-r`、`/resume`、`/rename`、`/clear`；旧会话和后台工作保留 |
| 配置 | 用户/项目/项目本地设置、`--settings` 文件或 JSON、启动参数覆盖、`/config`、`/theme` |
| 模型 | `/model` 读取已配置的连接与模型目录，也可手工指定模型 ID；`/effort` 只提供模型声明支持的强度 |
| 权限 | `/permissions ask\|full` 接入真实账号权限；Shift+Tab 打开明确标注作用范围的菜单 |
| 操作 | `/files`、`/stop`、`/approvals`、`/choose`；任务、diff 和底层答复命令保留为显式诊断入口 |
| 工具 | 现有 `/tools` 搜索宿主工具、技能、MCP 等能力 |
| 用量与状态 | `/status`、`/context`；缺失测量不显示伪造数值 |
| 脚本 | 管道输入、附件、单次运行、文本/JSON/NDJSON、超时与退出码、Ctrl+C 请求取消 |

## 保留的架构差异

- `roppo`、`-c`、`-p` 默认继续同一个人 Chat；`--cwd .` 保留为显式兼容入口。首次连接仍使用本机服务的浏览器配对。
- `/model`、`/effort` 修改共享 Router 的后续轮次默认值。Worker 配置独立管理，进行中的轮次保留已绑定模型。
- `/permissions` 是账号共享设置，仍受既有来源和沙箱约束。项目 JSON 设置只能改变终端偏好。
- `/plan` 查看 Roppo 发布的执行步骤；当前没有 Claude Code 的只读计划权限模式。
- `stream-json` 发送宿主快照中的消息替换和任务更新，不保证逐 token，也不兼容 Claude SDK 事件协议。
- 界面继续使用 Roppo 现有全屏终端布局和历史翻页；不承诺与 Claude Code 每一版本的渲染相同。

## 后续开发清单

这些能力尚未实现，CLI 不会把它们展示为已生效：

1. 会话级 `--model`、`--effort`、系统提示覆盖；需要在宿主中保存独立绑定并处理恢复与任务继承。
2. `default`、`acceptEdits`、`plan` 等权限模式和工具 allow/ask/deny 规则；需要完整的宿主执行约束。
3. `!` shell 模式、外部编辑器、图片剪贴板、Vim 模式、快捷键配置。
4. 会话内 `/compact`、文件检查点与 rewind、会话分叉、导出。
5. CLI 管理 MCP、插件和技能的安装/认证流程；现有 `/tools` 提供发现与查看。
6. hooks、结构化流式输入、JSON Schema 输出、预算/最大轮次控制，以及用量金额统计。

实施顺序以共享服务和已有执行能力为基础；新增参数必须接入真实后端行为，拒绝只保存一个没有执行效果的配置值。

## 修改说明

- `src/terminal/settings.ts`：本机终端偏好读取、合并和保存。
- `src/terminal/host-settings.ts`、`src/server.ts`、`src/personal-account.ts`：提供有限的终端模型/权限接口及相应认证路径。
- `src/terminal/controls.ts`、`src/chat.ts`：终端设置命令、会话选择与共享个人 Chat 同步。
- `src/terminal/main.ts`、`client.ts`、`output.ts`：接入新命令、启动参数、结构化输出与取消。
- `src/terminal/editor.ts`、`presentation.ts`、`session-display.ts`、`commands.ts`：菜单、快捷键、配色、欢迎卡与命令帮助。
- `tests/terminal*.spec.ts`：配置优先级、流式输出、会话选择、设置同步和终端交互回归。
- `docs/images/product/terminal-cli-preview.svg`：欢迎页和配置菜单的渲染预览。
- `.gitignore`、中英文 README 和终端文档：本地设置排除、使用入口和行为差异。

没有删除项目文件。原有皮肤分支保留，未混入 CLI 开发分支。

## 验证记录

- `npm run check` 通过：宿主、Chat 和预览 UI 类型检查通过；Chat 构建通过；2,907 项测试通过，4 项按现有条件跳过。
- 独立测试服务与真实伪终端已检查：欢迎页、配置搜索、主题保存、新建会话、发送和接收消息、恢复会话菜单。
- 增加切换会话后输入流恢复的回归测试。
- 早期界面预览 由实际 `TerminalLayout` 输出生成，并检查了渲染结果。使用确定性样例，没有调用真实模型或外部业务平台。

## 官方参考

- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Interactive mode](https://code.claude.com/docs/en/interactive-mode)
- [Settings files and precedence](https://code.claude.com/docs/en/settings)
