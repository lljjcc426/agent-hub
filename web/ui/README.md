# Roppo UI

组件入口是 `web/ui/index.ts`。宿主为组件包一层 `className="roppo-ui"`，通过 `data-theme="light"` 或 `data-theme="dark"` 切换主题。传入消息、时间、任务和操作回调即可复用。

```tsx
import { Button, FileCard } from '../ui'

<div className="roppo-ui" data-theme={theme}>
  <Button tone="primary" onClick={openFile}>预览文件</Button>
  <FileCard name={name} detail={fileType} onOpen={openFile}
    download={{ href: url, label: '下载文件' }} />
</div>
```

- 基础控件包括按钮、输入、选择、分段选择、复选框和开关。
- 导航与布局提供品牌标识、侧栏、导航项、面包屑和三段式上栏。
- 对话提供 Agent 身份、消息、复制和受控输入框。发送回调由宿主提供。
- 任务与文件提供状态、任务行、时间线、定时任务和文件卡。任务行底色表示当前项，状态独立传入。
- 浮层与反馈提供锚定气泡、侧面板、对话框、可折叠内容、空态和操作提示。弹窗使用浏览器原生焦点管理和 Escape。

对话页的 `ChatComposer` 复用正式 Chat 的加号、斜杠菜单、推理强度滑杆、审批策略和上下文圆环。宿主提供发送、附件及设置回调，预览使用内存中的模型连接。`MessageActions` 与 `Reactions` 通过 `InteractionProvider` 获取对应消息。`PendingRequests` 与对话内的决策卡共用答复状态，并可定位原消息。任务页复用会话面板的 `TaskActivityRow`，展开后可查看步骤并进入对应 Worker 的协作记录。

在仓库根目录运行 `npm run dev:ui` 打开交互展示页，`npm run build:ui` 生成独立静态预览。

在「任务与文件」和「Agent 组件」中都能试用交付验收。`DeliveryReviewCard` 接收草稿读取和交付决定的回调。`DeliveryFileCard`、`DeliveryFileViewer` 使用宿主提供的预览和下载地址。正式 Chat 通过会话接口读取文件，组件库使用随预览发布的 Markdown 文件。两处都可以从草稿原文核对到最终下载的内容。

## Agent 组件

`#agents` 用一份本地发布清单演示以下组件。交互参考 Affect UI 的公开预览，组件使用 Roppo 的字体、头像、黑白主题和原生控件独立实现。

| 组件 | 在 Roppo 中的交互 | 参考 |
| --- | --- | --- |
| AgentCrew | 查看 Router 与 Worker 的关系、活动连线和所用工具 | [Agent Crew](https://www.affectui.com/components/agent-crew) |
| ToolAccessMap | 切换 Agent、检查工具及参数、重放调用 | [Tool Access Map](https://www.affectui.com/components/tool-access-map) |
| AgentHandoff | 切换派发与交付记录，查看随任务传递的内容 | [Agent Handoff](https://www.affectui.com/components/agent-handoff) |
| AgentPlan | 修改步骤、拖动或按 Alt 加方向键排序、运行 | [Agent Plan](https://www.affectui.com/components/agent-plan) |
| AgentMonitor | 查看各步骤用时与费用、暂停、继续、折叠 | [Agent Monitor](https://www.affectui.com/components/agent-monitor) |
| ToolCallCard | 展开参数与结果、复制、失败重试 | [Tool Call Card](https://www.affectui.com/components/tool-call-card) |
| AgentCheckpoints | 从选定检查点另开尝试，沿连线回看原有记录 | [Agent Checkpoints](https://www.affectui.com/components/agent-checkpoints) |
| ContextWindow | 查看各类 token 占用、移除附件、压缩对话 | [Context Window](https://www.affectui.com/components/context-window) |
| MemoryPanel | 按类别查看、修改和删除记忆 | [Memory Panel](https://www.affectui.com/components/memory-panel) |
| ApprovalCard | 查看目标和附件，用按钮或键盘批准、拒绝 | [Approval Card](https://www.affectui.com/components/approval-card) |
| DecisionCard | 用数字键、选项或文字作答，支持稍后处理 | [Decision Card](https://www.affectui.com/components/decision-card) |

业务数据、运行状态和动作回调由宿主传入。示例的计时和重放逻辑位于 `web/component-preview`。在需要淡出的内容区包一层 `SwitchView`，用 `switchView('panel', update)` 提交视图切换。输入文字和普通业务事件可以直接更新。

浏览器回归可在运行预览后执行 `python tests/browser/component-motion.py <预览地址>` 和 `python tests/browser/agent-components.py <预览地址>`。动效回归默认使用 Chromium，末尾加 `webkit` 可以在 WebKit 上运行同一组逐帧检查。

`ScheduleCard` 用于 Chat 侧栏与任务组件页。宿主提供排期版本、最近一次执行及可追溯的交付记录，并处理暂停、恢复、保存和结果跳转。日期编辑和下次执行预览与调度器共用时区计算。
