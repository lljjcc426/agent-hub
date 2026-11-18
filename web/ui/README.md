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

在仓库根目录运行 `npm run dev:ui` 打开交互展示页，`npm run build:ui` 生成独立静态预览。
