# 内置浏览器开源依赖

依据实际安装包及锁文件核对：

| 依赖 | 固定版本 | 许可 | 使用范围 |
| --- | --- | --- | --- |
| [Playwright](https://github.com/microsoft/playwright) | 1.65.1 | Apache-2.0 | Chromium 的运行、操作和录制。Chromium 发行包含其组件声明 |
| [FFmpeg Installer](https://github.com/kribblo/node-ffmpeg-installer) | 1.1.0 | LGPL-2.1 | 选择平台编码器。FFmpeg 二进制按对应构建的声明分发 |
| [Cua Driver](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.56.4) | 0.56.4 | MIT | 桌面控制和捕获。发行存档含 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | 0.27.0 | Apache-2.0 | 清理旧浏览器会话和兼容已显式指定的旧引擎命令 |
| [ws](https://github.com/websockets/ws) | 8.22.1 | MIT | 旧引擎画面流的兼容连接 |

兼容组件的许可副本见 [agent-browser](licenses/browser/agent-browser-Apache-2.0.txt) 和 [ws](licenses/browser/ws-MIT.txt)。Roppo 自行实现生命周期、任务归属、授权、控制权交接、账号库与前端。
