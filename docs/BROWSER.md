# Roppo 内置浏览器

[English](BROWSER.en.md) · [简体中文](BROWSER.md)

[本轮改造验收记录](BROWSER_ACCEPTANCE_2026-11-15.md)

浏览器位于会话右侧，与“文件”和“团队动态”共用标签面板。右上角按钮可以收起或打开面板；左侧不再提供独立的浏览器入口。Router 继续负责沟通和分派，Worker 通过宿主工具操作各自的浏览器；没有引入第二套模型规划循环。

## 使用

1. 直接向 Router 提交网页任务。Worker 自主打开隔离浏览器；对话里的“查看网页”直接打开对应页面。
2. 需要本人登录或验证时，任务保持等待，对话显示原因和“接管”。完成操作后点击“继续任务”，原 Worker 在同一任务中读取新快照并继续，无需重述任务。
3. 想自己浏览时，点击“打开浏览器”即可。默认资料自动建立；名称、已保存账号和 Worker 登录授权统一放在“设置 → 浏览器”，无需先配置才能浏览公开网页。
4. 任务结束后页面暂时保留，可接管、导航和打开标签页；旧 Worker 不能继续操作。另一个窗口可用“转移控制到此窗口”接管。

输入支持鼠标移动、按下/抬起、拖选、右键事件、滚轮、文字/粘贴/输入法和常用按键。复制/剪切将远端选中文字写入本地剪贴板，需要浏览器允许剪贴板写入。F6 返回地址栏；地址栏接受网址或搜索词。接管时网页视口随面板尺寸调整，观看模式保持 Worker 的视口。

“浏览器文件”支持向主文档的标准文件输入框上传单个不超过 100 MiB 的文件。Worker 可在触发下载的 Ego Lite 点击中传入 `download:true`，将结果保留在浏览器文件中。手动触发的 Ego Lite 下载可在客户端的下载面板查看。选中的上传文件和任务下载保留到浏览器关闭。

## 持久化与隔离

浏览器资料与已保存账号仍可在自己的会话中选择，但一个正在使用的个人 profile 只能绑定一个会话；要在另一会话使用，请另建资料，或先关闭原实例。Worker 登录复制仍按授权执行。

个人浏览器使用独立 Chrome Profile，保留网站 Cookie、站点存储和标签页。Worker 浏览器使用 Ego Lite，每个任务浏览器有自己的 Space、标签页和工作目录。使用同一份 Ego Lite 资料的 Space 会共享网站登录状态。

复用已授权登录时，Roppo 检查 Worker 权限，把目标站点的 Cookie 和站点存储复制到该资料绑定的 Ego Lite 资料。Worker 的后续修改留在 Ego Lite。可用 Roppo 现有的资料共享开关授权当前和以后的 Worker。

同一会话内的命令串行执行。人工接管先阻止后续 Worker 命令，再等待已开始命令结束；旧控制权代次、旧快照和旧标签页引用会被拒绝。人工控制租约失效后保持暂停，不自动恢复 Worker 写操作。任务结束后保留最终页面，供人工检查和操作。闲置实例按配置回收；达到数量上限时优先回收无人观看、无人控制的已结束实例。只有正在观看的浏览器开启画面流。

`superagent_browser` 是 API 后端和原生 Codex Worker 共用的实际工具，提供 profiles、open、navigate、snapshot、click、fill、press、scroll、标签页、login、request_takeover 和 close 操作。元素操作必须携带最近快照的 revision，标签页使用稳定 `t1` 等 ID。相同 requestId 不重复执行；超时或宿主中断后的未确认写操作不会自动重放。

## 密码和安装

保存账号由 Roppo 的本地账号库提供，不依赖 Chrome 的密码保存弹窗。密码使用 AES-256-GCM 加密，密钥文件仅宿主用户可读写；也可指定密钥环境变量。工具只传 credentialId，密码经标准输入送入浏览器，不进入命令行参数、普通记录表或工具回执；已知保存密码在返回模型的页面快照中被过滤。不会导入用户日常 Chrome 的密码库，也不提供云同步。

删除保存账号只删除密码记录，不会让网站现有登录失效；需要退出网站时，应在对应浏览器里执行网站的退出登录。

在 Roppo 宿主安装 [Ego Lite](https://lite.ego.app/download)，完成初始化，并创建或命名一份专用的 Roppo 资料。可用 `browser.egoProfile` 指定其他资料名称或 ID。已有 Roppo 登录资料可以在 `browser.egoProfiles` 中按 Roppo 资料 ID 绑定到不同的 Ego Lite 资料。通用资料和各组登录授权使用各自的 Ego Lite 资料。

在登录的桌面会话中安装 [Cua Driver](https://cua.ai/docs/cua-driver/quickstart)，开启辅助功能和屏幕录制权限。Chat Worker 通过 `superagent_desktop` 使用它的原生 MCP。受管 OpenCode 通过现有 Roppo MCP 连接接收这两项工具。安装位置不在系统应用目录或 PATH 时，可以配置 `browser.egoCommand` 和 `browser.cuaCommand`。

Router 和个人浏览器使用 `agent-browser 0.27.0`。macOS 默认使用已安装的 Google Chrome，可配置 `browser.executablePath` 指定兼容浏览器：

```sh
npm ci
npx agent-browser install
npm run build:chat
```

顶层配置示例（其余配置沿用原文件）：

```json
{
  "browser": {
    "enabled": true,
    "maxSessions": 8,
    "timeoutMs": 20000,
    "idleMs": 900000
  }
}
```

`maxSessions` 包括个人和任务浏览器。`browser.command` 可指定兼容的引擎可执行文件；`browser.keyEnv` 可指定包含 64 位十六进制密钥的环境变量。不要在已有账号库上直接更换或丢弃密钥。

在 Worker 配置的工具页可以单独关闭浏览器访问、设置标签页上限；对应每个 `execution.workers[]` 的 `browser: {enabled, maxTabs}`。设置沿用现有任务配置生效规则，个人资料授权则每次调用都会重新检查。

浏览器数据位于 `<stateDir>/browser`。现有数据库备份命令不包含整个 Chrome profile：迁移或备份时应停止宿主，同时保存数据库、该目录及外置密钥。只恢复数据库不能恢复登录信息，丢失密钥无法还原保存密码。网站会话有效期、跨站 SSO、设备绑定及二次认证仍由网站决定；不会承诺永久登录或跨机器无条件迁移。

### 截屏和录屏

- Ego Lite 的 `screenshot` 输出 PNG，支持 `fullPage`。`record_start` 和 `record_stop` 录制选中的标签页，输出无声 MP4。宿主需安装 FFmpeg，或通过 `browser.ffmpegCommand` 指定路径。
- Cua Driver 的 `get_window_state` 可截指定窗口，`get_desktop_state` 可截主屏。录制工具输出主屏的无声 MP4，同一时间只能进行一条桌面录像。
- 文件作为任务附件返回，可在 Chat 下载。可写任务也会收到工作区路径。文本模型截图时使用 `inlineImage:false`。录制在达到设定时长或任务结束时停止。

当前验收覆盖 macOS + 本机 Chrome。Linux/Windows、任意外部网站、Chrome 扩展、系统 Passkey 和复杂跨站登录流程未计入通过项。见[验收记录](BROWSER_ACCEPTANCE_2026-11-07.md)及[开源许可](THIRD_PARTY_BROWSER.md)。

Chat 侧栏显示当前观看的网页。Worker 页面由 Ego Lite 提供页面画面和输入，个人浏览器使用 [agent-browser Streaming](https://agent-browser.dev/streaming)。

本地 Colima 部署使用 LinuxServer Chromium。创建容器时设置 `PIXELFLUX_WAYLAND=false` 可启用 X11/Xvfb。在 Selkies 查看器断开时的本地对照中，这一设置缩短了从点击到侧栏显示变化的时间。切换前让 Chromium 正常退出，新容器继续挂载原来的 `/config` 持久卷。
