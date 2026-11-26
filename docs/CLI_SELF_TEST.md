# CLI 自测记录

日期：2026-11-26。首次自测的业务代码基于 `f18f883`。

## 后续远程失败修复

- Node 22 插件批处理：保留 6,000 条事件及对应的 6,000 次状态写入，将这一项集成测试的等待上限从默认 5 秒调整为 20 秒。它验证分批提交与确认机制，不作为吞吐量基准；其他测试的等待上限不变。本机单独运行约 1.7 秒，远程原失败为 5 秒超时。
- Docker 启动：新增失败日志后，定位到 `bwrap: Failed to make / slave: Permission denied`。Compose 为 Roppo 服务设置 `apparmor=unconfined`，允许内部 Bubblewrap 建立挂载空间。该容器的外层 AppArmor 限制被移除；非 root、只读根目录、无 capabilities、seccomp 和内部命令沙箱继续生效，宿主和其他容器的 AppArmor 配置不变。
- 诊断：验收失败时，在清理隔离容器前保存并输出容器日志与健康状态；沙箱探针报告截断后的具体错误。配置链接中的临时配对令牌继续脱敏。
- 启动修复后继续验收，发现旧模型夹具仍返回普通 JSON 和旧工具名，当前 OpenCode 接入需要 SSE 流及 `roppo_` 工具前缀。更新 `examples/container-provider-fixture.mjs` 并在 `tests/container-provider-fixture.spec.ts` 增加真实 API 解析器回归；独立本机宿主已完成 Router → Worker → 实际沙箱命令 → Router 结果投递。
- 备份后的恢复暴露了旧 Compose 不支持 `start --wait` 的兼容问题。`deployment/compose.sh` 改用已有容器的 `up --no-recreate --no-build --pull never --wait`；仍等待健康状态，保持容器 ID，禁止隐式构建、拉取或升级。容器验收增加备份前后 ID 不变的检查。
- 本机相关检查：插件包、容器部署和容器协议夹具共 57 项通过。远程完整结果以 [PR 检查](https://github.com/lljjcc426/agent-hub/pull/1/checks) 为准；下面保留修复前的失败证据。

本次修改文件：`tests/plugin-packages.spec.ts`（仅该压力用例的等待上限）、`compose.yaml`（容器 AppArmor 设置）、`src/sandbox.ts`（探针错误信息）、`examples/container-acceptance.py`（失败诊断）、`deployment/SECCOMP.md` 和 `docs/DOCKER.md`（策略说明），以及本记录。没有删除项目文件。

## 首次自测结论（修复前）

首次自测时，本机 Node 24 全量检查和当前 CLI 的实际交互检查通过，未发现新的 CLI 功能故障。远程 CI 当时有两处上游版本也能复现的失败。

## 本机检查

- 环境：macOS arm64，Node v24.21.0。
- `npm run check`：宿主、Chat、预览 UI 的类型检查通过，Chat 构建通过；190 个测试文件通过、1 个按条件跳过；2,907 项测试通过、4 项按条件跳过。
- 最后补充的后台任务断言通过 CLI 专项复测：4 个测试文件、21 项测试通过。完整命令如下。
- 本轮新增的检查扩展了现有集成测试，因此测试项总数保持不变。
- 尝试补跑本机 Node 22.19 专项测试，但运行时下载超时，未执行成功；未修改项目依赖。下面的 Node 22 结果来自已有远程 CI，不能视为本轮新增断言的 Node 22 验证。

```sh
npm run check
npx vitest run tests/terminal.spec.ts tests/terminal-editor.spec.ts tests/terminal-settings.spec.ts tests/terminal-presentation.spec.ts
git diff --check
```

## 已检查的行为

| 范围 | 检查结果 |
| --- | --- |
| 连接与隔离 | 实际 CLI 配对、凭据权限、退出登录后撤销；终端凭据不能读取完整宿主配置；跨项目会话和任务访问被拒绝 |
| 消息与任务 | 管道文本、文件附件、Router 分配 Worker 并等待结果；文本、JSON、NDJSON 输出；旧轮次结果保持独立 |
| 会话 | 新建、恢复、中文重命名；个人会话选择同步到网页接口；新建会话后旧会话的任务仍然完成 |
| 共享设置 | 模型目录、选择和恢复默认模型；只接受目录支持的思考强度；并发配置版本冲突；账号 ask/full 权限同步 |
| 终端偏好 | 用户、项目、本地和启动参数优先级；实际菜单搜索、主题保存；错误配置报告 |
| 退出码 | 成功 0；模型运行失败、连接失败、附件不存在 1；配置错误 2；真实待审批任务 3；超时 124；SIGINT 取消 130 |
| 取消和退出 | SIGINT 后服务端轮次为 cancelled；实际终端执行 `/exit` 后，进行中的服务端任务继续完成 |
| 终端操作 | 中文、emoji、多行括号粘贴；模型快捷键；Esc 恢复草稿；历史搜索；连续 Ctrl+C 退出并恢复终端模式 |
| 窗口与降级 | 宽度 100 缩至 45 列后继续操作；`TERM=dumb` 下菜单文本、切换会话和继续输入可用 |
| 服务停止 | CLI 返回结构化 `host_unavailable` 错误，退出码 1 |

终端检查使用操作系统 PTY 启动真正的 `bin/roppo.mjs`，同时读取独立宿主的 API 核对持久状态。网页同步通过网页使用的会话和权限接口核对，没有把它描述成完整浏览器验收。

本机原始日志保存在忽略目录 `.local/`：`cli-selftest-check.log`、`cli-final-terminal-tests.log`、`cli-pty-check.log`、`cli-background-check.log`、`cli-offline-check.log`。这些日志和测试账号凭据不提交到仓库。

## 修复前的远程 CI 失败记录

以下远程结果对应业务代码提交 `f18f883`，之后的修复见本文开头。

- Node 24：Ubuntu 和 macOS 检查通过，见 [分支 CI](https://github.com/lljjcc426/agent-hub/actions/runs/45766295517)。
- Node 22.19：2,906 项通过、4 项跳过，只有 `tests/plugin-packages.spec.ts:104` 的一万多次操作批处理测试超过 5 秒。未改动的上游同步分支出现相同失败，见 [基线 CI](https://github.com/lljjcc426/agent-hub/actions/runs/45762890723)。目前未改超时时间，也未认定具体性能原因。
- Docker：镜像构建完成，`compose.sh up` 阶段容器变为 unhealthy。[CLI 分支](https://github.com/lljjcc426/agent-hub/actions/runs/45766295518)与[上游同步基线](https://github.com/lljjcc426/agent-hub/actions/runs/45766718632)均复现；现有失败日志不足以定位容器内部原因。本机没有 Docker，未宣称本机容器验收通过。

## 验证边界

使用独立测试账号和确定性模型实现，覆盖真实宿主、HTTP、任务调度、文件和终端流程。未使用个人模型凭据，未调用付费模型或外部业务平台；实际供应商登录、模型质量与外部工具执行不在本次通过结论内。Claude Code 尚未对齐的功能仍以 [CLI 兼容范围](CLI_COMPATIBILITY.md) 为准。

## 本轮文件说明

- `tests/terminal.spec.ts`：补充真实宿主上的模型、强度、权限、会话、后台任务、取消、审批、失败退出码和输出格式回归断言。
- `docs/CLI_SELF_TEST.md`：新增本记录，说明结果、失败项和验证范围。

没有删除已有项目文件，没有修改依赖或业务逻辑。测试服务已停止；清理了本轮下载失败生成的 `.local/node22.tgz`，临时脚本和日志保留在 `.local/` 便于复查。
