# CLI 设置缺项与本轮变更

更新：2026-11-26。以仓库现有网页配置和宿主接口为依据。此清单列出终端缺失的设置入口；未将清单中的功能标为已经实现。

## 已有入口

- `roppo init`：启动初始配置，在浏览器完成账号和模型连接设置。
- `roppo login/logout`：终端与本机服务配对及撤销凭据。
- `/model`、`/effort`：先选择 Router 或 Worker，再选具体 Worker，修改模型或思考强度。
- `/rename`：选 Worker 后修改显示名称，保留 Worker 身份和任务记录。
- `/settings`、`/config`：模型、思考强度、Worker 名称、权限、语言、主题、动效等已有设置。
- `/permissions`：共享账号的询问/完全访问设置，仍受来源沙箱限制。
- `/memory`：查看、编辑、忘记记忆内容。`/schedules`：查看和暂停/恢复提醒。
- `/tools`：查看已有工具、技能、MCP 等能力。

## 缺少的终端设置

| 优先级 | 缺项 | 目前可用方式 / 依据 |
| --- | --- | --- |
| 高 | 新增、编辑、删除模型连接；API 地址、密钥、OAuth 登录及连接检测 | 网页模型连接配置；`src/ui/configuration.ts`、`src/ui/structured-settings.js` |
| 高 | 新增、复制、启停、移除 Worker | 网页 Agent 团队；`web/chat/team-configuration.tsx` |
| 高 | Router/Worker 单轮超时，Worker 浏览器访问权限 | 网页运行配置；`web/chat/runtime-configuration.tsx` |
| 高 | Worker 数量上限、是否允许 Router 管理 Worker、Router 调度方式 | 网页团队调度；`web/chat/structured-settings.ts` |
| 高 | 插件、技能、MCP 的安装、更新、卸载、认证及连接配置 | 网页市场和连接器；`web/chat/plugin-marketplace.tsx`、`web/chat/connectors.tsx`；`/tools` 目前用于查询 |
| 中 | 外部消息来源、应用连接、凭据与路由配置 | 网页连接器与来源配置；`web/chat/connectors.tsx`、`src/ui/configuration.ts` |
| 中 | 浏览器设置、来源沙箱、运行限制与隔离、跟进规则、发布与合并策略 | 网页工作区设置；`web/chat/workspace-settings.tsx` |
| 中 | 个人记忆的自动学习策略、启用范围和管理策略 | 网页记忆管理及 `src/chat.ts` 的 memory/manage 接口；终端目前主要编辑记忆内容 |
| 中 | 受理决策器配置及测试、连接的高级参数 | 网页配置；`web/chat/structured-settings.ts` 和高级原始配置 |
| 中 | 主机维护、部署、原始配置、版本历史与恢复 | 网页维护；`web/chat/workspace-settings.tsx` |
| 中 | 全程在终端完成的首次设置向导 | `roppo init` 已有入口，具体设置仍转到浏览器 |

建议先补模型连接认证、Worker 管理和运行参数，再补插件与外部连接；这些直接影响首次使用和日常调整。

## 本轮命令行为

`/history` 保留，搜索当前对话中已加载的消息，可继续加载更早内容。`/resume`、`/new` 不再切换个人会话。

`/plan` 选择 Plan 后，Router 先反问澄清目标、约束、范围和验收标准，再给详细计划。服务端用独立的纯文本轮次处理，禁用工具和 Worker 派发。它能参考对话文本，不能读取附件内容或工作目录。模式适用于同一段共享对话，包括网页和脚本发来的新消息。已有任务和提醒照常运行。切回 Act 后需要新的执行指令。

`/clear` 先弹确认，默认取消。确认时清理消息和本轮工作上下文，保留长期记忆、计划事项、文件和任务审计记录。先完成或停止活动任务；确认期间若出现新消息，需要重新确认。它会清空网页共享对话的消息，不会新建第二段个人会话，也不承担执行档案的彻底擦除。

`/diff` 选择 Worker，再选择其具体任务。支持已有改动记录和受管 Git 工作区；普通非 Git 文件任务没有可用对比基线时，提示通过 `/files` 查看交付文件。共享工作区的对比可能包含多个 Worker 的共同改动。

## 文件变更说明

| 文件 | 修改说明 |
| --- | --- |
| `src/chat.ts` | 保存 Plan/Act 模式；清理消息并重置工作上下文；保留记忆和提醒访问；隔离清理前后的轮次和迟到消息 |
| `src/runtime.ts` | 为计划模式提供先澄清再规划的纯文本 Router 路径，禁用工具、派发和自动记忆写入 |
| `src/router-proactive.ts` | 计划消息独立进入 Router，避免混入普通执行消息批次 |
| `src/server.ts` | 增加有限的清理/模式接口；按选定 Worker 校验思考强度 |
| `src/personal-account.ts` | 允许已配对终端使用上述有限接口 |
| `src/terminal/host-settings.ts` | 暴露 Worker 设置并支持独立修改模型、思考强度和名称 |
| `src/terminal/tui-actions.ts` | Router/Worker 选择、Worker 重命名与改动选择、清理确认、计划模式菜单 |
| `src/terminal/tui-screen.ts` | 输入区域显示 Plan 状态 |
| `src/terminal/tui.ts` | 清理后丢弃客户端缓存的旧消息，避免旧记录重新出现 |
| `web/chat/main.tsx` | 同步清理网页缓存，避免旧消息分页在清理后重新出现 |
| `tests/terminal-editor.spec.ts` | 更新旧编辑器对无参数 `/diff` 命令补全的预期 |
| `src/terminal/tasks.ts` | 为个人对话中的 Worker Git 工作区提供改动查询，保留任务归属检查 |
| `src/terminal/commands.ts`、`src/terminal/controls.ts` | 更新命令说明并去除旧的交互会话切换、会话重命名语义 |
| `tests/chat.spec.ts` | 验证多轮澄清、计划无工具/派发，清理后保留记忆与可运行提醒 |
| `tests/terminal.spec.ts` | 验证真实宿主的 Worker 模型、思考强度、重命名、个人任务 diff 和接口边界 |
| `tests/terminal-tui-actions.spec.ts`（新增） | 验证菜单选项连接到正确操作、清理默认取消和确认时序、当前对话搜索保留 |
| `docs/TERMINAL.md`、`docs/CLI_PRODUCT.md`、`docs/CLI_COMPATIBILITY.md` | 更新使用说明、产品边界与兼容行为 |
| 本文（新增） | 设置缺项、命令限制和逐文件变更说明 |

未删除项目文件。清理测试使用隔离测试数据，没有清理用户的真实对话。

## 验证结果

- TypeScript：宿主、Chat 网页和组件预览均通过。
- 全量 Vitest：2,920 项通过，4 项按既有条件跳过。
- OpenTUI 原生渲染器：空屏滚动、Unicode 粘贴、多行、菜单草稿、滚动跟随、审批按键、窗口缩放与中断均通过。
- 新增菜单行为测试和实际宿主测试覆盖模型/思考强度目标选择、Worker 重命名、diff、清理确认和计划模式。
