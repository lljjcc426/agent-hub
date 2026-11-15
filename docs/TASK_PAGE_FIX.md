# 任务页面修复验证

## 问题与原因

1. “进行中”页签调用工作区首页导航，因此从任务记录切换时进入“当前工作区”。
2. 正式实例截图中的 5 条本机助手空白记录均属于历史清理计划；清理回执为 completed / verified，标题、原始请求、摘要及结果正文均已清空。任务投影没有排除这些保留的记录外壳。

## 修复

- 新增 `#tasks/active`，保留 `#tasks` 为工作区首页，`#tasks/history` 为任务记录。
- 同步任务页标题、侧栏选中状态、首次加载和轮询刷新；浏览器刷新和后退可恢复“进行中”。
- 复用现有历史清理判定，从任务列表、计数、Worker 当前任务、执行记录和请求理解状态中排除已清理内容。
- 已清理任务的详情返回不存在；正常本机助手任务仍展示原始请求、摘要和实际回复。
- 修复只改变展示和读取，不恢复或修改正式实例的历史数据。

## 验证

- 4 个测试文件、38 项测试通过：operator-workspace、ui-navigation、frontend-contract、workspace-view。
- 新增回归覆盖本机助手内容显示、清理后的列表/计数/详情、保留任务不受影响、独立任务路由与 URL 恢复。
- 类型检查（服务端、Chat、视图插件）、前端构建、`git diff --check` 通过。
- 浏览器验证：页签切换、页面刷新、刷新按钮、浏览器后退、任务详情、历史搜索、工作区首页入口、桌面侧栏选中状态。控制台无 error / warn。
- 隔离预览使用测试任务，不调用模型或外部应用；正式实例保持原发布版本。

## 证据

- 预览：`http://127.0.0.1:55429/configure#tasks/active`
- 页面截图：`.local/prompt-rules/task-active-final.jpg`
- 详情截图：`.local/prompt-rules/task-detail.jpg`
- 浏览器记录：`.local/prompt-rules/task-browser-checks.json`
- 自动化及构建日志：`.local/prompt-rules/task-tests.log`、`task-typecheck.log`、`task-build.log`
