# Roppo 的 Mac 桌面更新

Roppo 直接打开本机的 AgentHub。网页随 AgentHub 部署更新。桌面窗口、Electron 或 Sparkle 有改动时，发布桌面应用的新版本。

Roppo 运行期间，Sparkle 每 6 小时自动检查一次。也可以随时打开「Roppo → 检查更新…」。用户可在提示中选择安装并重新启动，或稍后处理。更新源位于 `~/Library/Application Support/Roppo Updates/releases`。应用只在回环地址的随机端口提供当前清单及版本包，退出后端口关闭。

## 桌面通知

「Roppo → 桌面通知」可以开关任务提醒，也可以发送一条测试通知。首次使用时，请在 macOS 提示中允许 Roppo 发送通知。

任务完成、失败或停止，或需要回答问题、批准操作、审阅文件及核对执行结果时，桌面会显示提醒。点击可回到对应对话，来自其他入口的工作会打开待处理或运行记录。通知默认开启。首次启用以当前状态为起点，应用重启会继续检查上次记录后的变化。

关掉窗口后仍可收到通知。使用「退出 Roppo」或让 Mac 睡眠会暂停检查。

## 本机发布

在本目录运行以下命令。需要 Apple 芯片 Mac、Command Line Tools、Node.js 24 以及包含同版本 Node 头文件的安装。首次安装构建依赖可运行 `npm ci`。

1. 将官方 Sparkle 2.10.1 SDK 解包到仓库的 `.local/sparkle-2.10.1/`，或用环境变量 `ROPPO_SPARKLE_SDK` 指定已解包的绝对路径。其目录内应有 `bin/sign_update` 和 `Sparkle.framework`。可从 [Sparkle 2.10.1 发布页](https://github.com/sparkle-project/Sparkle/releases/tag/2.10.1) 获取 `Sparkle-2.10.1.tar.xz`，SHA-256 为 `1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27`。
2. 用 `npm version 0.2.1 --no-git-tag-version` 将包和依赖锁的版本提高到目标版本号。发布时换成实际的新版本。
3. 运行下列命令构建、签名并发布。已有构建也可单独运行 `python3 update/publish.py /path/to/Roppo.app`。

```sh
npm run release:local
```

更新私钥位于本机登录钥匙串，账户名为 `com.roppo.studio.desktop.updates`。应用里仅嵌入公钥。发布工具会核对应用标识、架构、版本和签名，先写完整安装包，再原子替换已签名的清单。相同或更低版本无法覆盖已发布版本。修复已发布版本时应提高版本号。

这个渠道供当前 Mac 使用。安装包采用本机临时签名，更新清单和压缩包另用 Ed25519 签名。现有登录及客户端数据保存在独立的 `~/Library/Application Support/Roppo` 目录。
