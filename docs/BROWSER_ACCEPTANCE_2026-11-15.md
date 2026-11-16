# 内置浏览器改造验收 · 2026-11-15

## 版本与环境

- 基线：`c464aef9fd5ad8e421d446927dc2fb01ac94e329`。
- 分支：`codex/browser-experience-20261115`，独立 worktree。
- macOS、本机 Chromium、固定版本 agent-browser 0.27；Router 使用原生 Codex `gpt-6.1-terra`，Worker 使用 `gpt-6.1-sol`。
- 隔离预览：`http://127.0.0.1:47731/chat`；本地登录/输入测试站：端口 47732。未修改 4337 正式部署，也未替换它的配置、登录信息或运行数据。
- 核心改造为 `aba6009`，附件显示/资料选择为 `aa82d45`；后续提交包含全选回归修复及本记录。

## 真实任务 A：阅读公开网站并交付文件

只给出一句自然语言任务，通过 Chat API 提交，未指定 Worker 或分工：

> 用内置浏览器读一下 https://agent-browser.dev/streaming ，整理一份简短中文要点，附来源链接和实际页面截图，保存成 browser-research.md 和 browser-research.png，自己检查结果后告诉我。

Router 自主选择一个 Research Worker。Worker 访问实际网站，阅读页面、截图、生成中文文档，通过工作区工具保存指定文件名，并目视检查 PNG。Router 收到结果后回复。期间没有补充指令或人工修改产物。

- 任务：`edf329d1f12e12937b11434a7591f9a5`。
- 唯一 assignment：`65136f83b58091ff33a9830a06252523`。
- 结果：completed。
- `browser-research.md`：2717 字节，6 条要点及来源、截图引用。
- `browser-research.png`：1280 × 633，103772 字节；实际网站首屏，并非整页截图。
- PNG SHA-256：`be932530f38c4ca4951408ec2b5668f6a15cea062b1a015e5a82184376d8ea79`。
- 在真实 Chat 页面确认缩略图可见；点击附件下载后，下载文件与工作区 PNG 的 SHA-256 相同。

## 真实任务 B：接管登录后继续原任务

通过 Edge 中的 Chat 输入框发送：

> 帮我打开 http://127.0.0.1:47732/dashboard，把 Workspace note 改成「接管后继续成功 😀」，再点一次 Add one，自己核实保存结果后告诉我。

1. Router 自主选择一个 Research Worker，打开测试站；网站跳转登录页。
2. Worker 检查可用登录资料后请求人工接管，保持 waiting。
3. 验收者在 Roppo 内点击接管，仅完成测试账号登录，然后点击“继续任务”。没有再发任务指令。
4. 原 Worker 读取新快照，修改中文及 emoji，点击 Add one 一次，刷新并复查页面。
5. Worker 和 Router 都正确报告：备注已保存，计数由 0 变为 1，刷新后不变。

- 任务：`1f9dace9263d3278388ecb6dc3d4ff9f`。
- 接管前后唯一 assignment：`c12da0fe989f3d3278721548142e93f7`。
- 结果：completed；没有新建替代任务或交给另一个 Worker。
- 登录站是可控的本地测试站，模型和浏览器执行均为真实调用；这不等于任意第三方 SSO/验证码流程已通过。

## 页面与输入验证

| 项目 | 结果 |
| --- | --- |
| 任务完成后保留页面，人工接管、导航、新建标签页 | 通过 |
| 两个窗口转移控制 | 通过；另一窗口需显式接管 |
| 设置中新建 Personal / Work，聊天下拉打开第二份资料 | 通过；未授予额外 Worker 登录权限 |
| 鼠标拖动滑块 | 通过，10 → 74 |
| 页面滚动、页面自定义右键事件 | 通过 |
| 中文、emoji、Tab/Enter、全选后替换、F6 返回地址栏 | 通过 |
| 标准文件输入上传 | 通过；页面读取并显示上传的 Markdown 内容 |
| 浏览器下载 | 通过；下载文本与预期中文/emoji 字节一致 |
| Chat 截图缩略图、点击下载 | 通过；下载哈希一致 |
| 深色桌面、390 × 844 窄屏 | 通过；窄屏 body 宽度为 390，无外层横向溢出；测试后恢复默认视口和主题 |
| 复制/剪切/粘贴快捷键 | 11 月 16 日补验通过，见下节的原生系统剪贴板闭环 |
| 操作系统中文输入法的组合输入 | 11 月 16 日补验通过，使用 macOS 拼音逐键输入、候选提交和取消 |
| 减少动态效果 | 沿用现有样式规则，未进行系统偏好切换验收 |

文件上传目前覆盖主文档标准文件输入，单次一个文件、最多 25 MB；不覆盖任意跨域 iframe、自定义上传管理器或系统 Passkey。Windows/Linux 未做本轮真实浏览器验收。33 ms 是画面推送检查间隔，没有宣称实测恒定 30 FPS。

## 回归与复核

- 完整 `npm test`：101 个测试文件通过；1510 项通过、1 项跳过。
- 最后全选修复后的浏览器定向测试：3 个文件、39 项通过。
- 最终 `npm run typecheck`、`npm run build:chat`、`git diff --check` 通过。
- 手工复核覆盖：接管/交还排队、过期 lease、旧 Worker 权限、任务截图归属、文件路径和上传生命周期、最终页面保留、设置入口。
- Codex Security 完成三个不可变补丁扫描：`fe7efcee-6956-47ef-b3ee-ae06d3973b9d`（19 个源文件）、`fdb35e18-93ea-40d6-8a2a-c100ebe09fd7`（2 个源文件）、`dbacafc9-84f6-40fe-973c-f58dabd1e8c1`（2 个源文件）。在当前可信本机单用户模型下均未确认新增漏洞；不是 Chromium/OS 沙箱审计，也不是全仓安全保证。扫描工具没有提供可用 token 用量。
- 第二轮扫描的能力检查实际通过，但将检查投影到已离开的 preflight 阶段被工具拒绝；真实 helper JSON 已保存到该扫描的 supplemental artifact，未伪造进度。

复核修复了输入未排完即切换/交还、无选择时剪切误删、assistant 附件未渲染、多资料无法打开、macOS 原生流全选失效等问题。

## 11 月 16 日：原生输入法与剪贴板补验

本轮在 macOS Edge 前台使用原生按键，输入法测试没有用直接注入 Unicode 或合成 composition 事件代替。确认并修复了三处实际缺陷：

- 长中文词组和多行粘贴被上游 WebSocket `char` 输入丢弃。改用固定版本 agent-browser 的 `keyboard inserttext`，通过 batch 标准输入传递，保留换行且不把正文放入进程参数。单字符仍走原有流。
- 中文候选输入中按 Esc 会触发 Chat 全局关闭面板。全局快捷键现在尊重 `isComposing`，取消候选后浏览器保持打开，未提交拼音不进入远端文本。
- 全选、剪切后立即继续输入时，选择读取可能落在后续输入之后。选择读取、剪贴板写入和剪切删除纳入同一个输入队列；切换控制时取消未执行操作，使用捕获的原会话和 lease。

实机结果：

| 场景 | 实际结果 |
| --- | --- |
| 拼音逐键 `nihao`、空格提交 | `你好` 只插入一次 |
| 拼音逐键 `zhongwenshurufa`、空格提交 | `中文输入法` 完整插入一次 |
| 拼音 `ni` 后按 Esc | 候选取消、面板不关闭、远端文字不变 |
| textarea 多行粘贴 | 中文、emoji、`café`、组合 emoji `👩‍💻` 和换行均保留；页面 JSON 回读一致 |
| contenteditable 多段粘贴 | 中文、emoji 和段落保留；页面回读一致 |
| 本机 → 远端粘贴 | 从普通 Chat 草稿复制已知测试文字，经原生 Cmd+V 粘贴到远端编辑区 |
| 远端 → 系统剪贴板 → 本机 | 远端改为不同的两行文字，Cmd+C 后在普通 Chat 草稿 Cmd+V，回读为 `远端复制成功 😀\n第二行 café` |
| 剪切后立即输入 `1` | 系统剪贴板回读为原文 `剪切原文 👩‍💻\n多行保留`，远端编辑区只剩 `1` |

最后两项使用未绑定自动化标签页的新原生窗口，只经系统按键操作，避免把自动化标签页的独立剪贴板当作系统剪贴板。所有 Chat 测试草稿均已清空，没有发送；专用窗口已关闭。范围限于 macOS Edge，不代表 Windows/Linux 原生输入法已验收。

最终 `npm run check` 通过：103 个测试文件，1514 项通过、1 项跳过；涵盖类型检查、构建及完整测试。新增回归覆盖 batch 标准输入、不泄露到参数、剪切顺序、剪贴板失败取消后续输入、控制切换取消队列。

最终增量 Codex Security 扫描 `586ef8e2-9b3b-411a-b00c-27858e98649d` 已完成并封存：5 个源文件全部复核，另检查两份回归测试、验收 harness 和本记录；未确认新增漏洞。覆盖输入边界、标准输入传递、剪贴板顺序、会话/lease 捕获和 IME 快捷键。没有放宽 Worker 工具或浏览器授权，也没有修改持久化格式。扫描未提供可用 token 用量。

## 早期失败记录

- 第一轮原生研究任务遇到 180 秒验收模型超时和未确认执行状态；没有绕过未确认动作重放保护，也不计为通过。
- 第二轮登录接管能够继续，但紧凑页面快照省略计数文字；模型如实报告无法核验。改为完整快照后，最终任务正确核验 0 → 1。
- 第三轮已生成文档和截图，但验收配置禁用了工作区命令，不能重命名截图；改用现有 Codex 工作区沙箱后再跑，最终完整交付。该改动仅作用于原生验收 harness，没有放宽正式部署。
- 文件选择最初在 Edge 扩展中受本机 file URL 权限限制，改用 IAB 完成；未修改浏览器扩展权限。

## 本地证据

产物位于 `.local/browser-experience-v4/workspace/`；数据库与回执位于同轮私有目录，不进入 Git。完整测试日志与截图在 `.local/browser-experience/`：

- `final-tests.log`、`final-input-tests.log`、`final-input-typecheck.log`。
- `evidence/05-final-login.jpg`：登录后等待继续。
- `evidence/06-final-same-worker-completed.jpg`：Router 完成回复及实际计数 1。
- `evidence/07-browser-download.jpg`、`evidence/08-browser-upload.jpg`：文件流。
- `evidence/09-input-shortcuts.jpg`、`evidence/10-dark-desktop.jpg`、`evidence/11-dark-narrow.jpg`：输入与布局。
- `evidence/12-final-preview.jpg`：最终截图附件显示。
- `final-20261116-check.log`：输入法和剪贴板修复后的完整检查。
- `ime-events-20261116.json`：原生 composition 提交和取消的事件记录（仅事件、按键及长度）。
- `evidence/13-ime-multiline-20261116.png`：中文词组与多行内容。
- `evidence/14-native-clipboard-20261116.png`：原生系统剪贴板回读及剪切后立即输入 `1`。
