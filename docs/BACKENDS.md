# 执行后端

AgentHub 的客户端入口、任务来源和执行后端独立。MCP 客户端调用操作员工具；执行后端承担路由、主代理和子代理的模型推理。接入 Cursor、Codex 桌面或 Claude 客户端，并不会自动取得其订阅对应的 API 凭据。

0.6.0 提供四种执行后端：

| kind | HTTP 路径 / 接入方式 | 会话保存 | 原生桌面接管 |
|---|---|---|---|
| `openai-responses` | `POST <baseUrl>/responses` | 宿主保存 input、output、reasoning 和工具回执，`store=false` | 无 |
| `openai-chat` | `POST <baseUrl>/chat/completions` | 宿主保存 messages、reasoning_content 和工具回执 | 无 |
| `anthropic` | `POST <baseUrl>/messages` | 宿主保存 content、tool_use/tool_result 和推理块 | 无 |
| `codex` | 本机 Codex App Server | 原生 Codex thread | 有 |

三个 API 后端直接发 HTTP，不调用 Codex CLI。内置 Chat 请求增量回复时，宿主设置 `stream: true` 并解析对应协议的 SSE。普通 API 端点返回完整 JSON 时，Chat 会在请求完成后一次显示回复。

没有自动压缩上下文、后端自动切换或跨供应商迁移。兼容服务必须实际支持所选协议、模型工具调用和所选输出格式。具体能力取决于所选模型与端点。[验收范围](BACKEND_ACCEPTANCE.md) 单独记录。

## 配置

完整模板见 [config.backends.json](../examples/config.backends.json)。使用前替换模型名，设置密钥环境变量，再启动一个独立实例：

```sh
./start.sh backends list
./start.sh backends list examples/config.backends.json
./start.sh check examples/config.backends.json
./start.sh serve examples/config.backends.json
```

模板使用独立状态目录 `.agenthub-api`、端口 4330，默认选择 Responses，并关闭 shell。密钥值仅由宿主进程环境读取；配置文件只保存 `apiKeyEnv` 名称。常驻服务必须在其进程环境中注入对应变量，终端中已设置不意味着 LaunchAgent 已获得它。不要把密钥写进 URL、`parameters`、配置或聊天。

```json
{
  "execution": {
    "backend": "responses",
    "roles": {"router": "chat", "worker": "responses", "subagent": "anthropic"}
  },
  "backends": {
    "responses": {"kind": "openai-responses", "baseUrl": "https://api.openai.com/v1", "model": "YOUR_OPENAI_MODEL", "apiKeyEnv": "OPENAI_API_KEY"},
    "chat": {"kind": "openai-chat", "baseUrl": "https://api.openai.com/v1", "model": "YOUR_CHAT_MODEL", "apiKeyEnv": "OPENAI_API_KEY"},
    "anthropic": {"kind": "anthropic", "baseUrl": "https://api.anthropic.com/v1", "model": "YOUR_ANTHROPIC_MODEL", "apiKeyEnv": "ANTHROPIC_API_KEY"}
  },
  "work": {"sandboxDriver": "disabled"}
}
```

这个片段应合并到包含 `sources` 的完整模板。按角色分配会把该角色所需的提示词和任务数据发送给相应服务；只有需要时才选择不同供应商。也可以定义多个同协议后端，使用不同地址、模型或凭据变量。HTTPS 可指向兼容服务；仅回环地址允许 HTTP。认证使用 OpenAI Bearer 或 Anthropic `x-api-key`，不跟随重定向。

`codex` 是兼容旧配置的隐式默认后端，该 ID 不能重定义为 API 协议。纯 API 实例应显式选择 API 后端，并把命令沙箱改为独立驱动或 disabled；仅改 `execution` 而保留默认 Codex 命令沙箱，执行 shell 时仍需要 Codex。需要时可显式定义 `{"kind":"codex","command":"/absolute/path/to/codex"}`。

## 模型、参数和会话

- 后端 `model` 是 API 新会话默认值；`models.router/worker/subagent` 可以覆盖相应角色的新会话模型。顶层 `model` 和 `effort` 保留给 Codex。混用供应商时不要把某供应商模型名作为其他角色的全局覆盖。

独立 Worker 池可通过配置页的 **执行 / Execution** 设置，或使用以下可选字段：

```json
{
  "execution": {
    "backend": "codex",
    "roles": {"router": "chat"},
    "workers": [
      {"id": "worker-1", "backend": "responses", "model": "worker-model-a"},
      {"id": "worker-2", "backend": "anthropic", "model": "worker-model-b"}
    ]
  },
  "models": {"router": "router-model"}
}
```

`backend` 引用 `backends` 中已有的服务（或内置 `codex`），`workers` 必须为 1–10 项且 ID 唯一。每项的 `model` 可省略，此时使用该服务默认模型。显式 Worker 池的长度决定并发数；没有此字段的旧配置继续使用原来的 `concurrency` 与 Worker 角色/模型。调度轮换使用可用 Worker，已有会话续办始终保留原后端与模型。服务定义可加 `label`（1–100 字符）用于界面名称。

参见 [配置台与 Worker 验收](CONTROL_CENTER_2026-11-05.md)，其中包含缩容、后台槽位、真实 Codex 接入与回滚边界。
- `execution` 可在设置页按版本保存。已有工作固定原后端、原模型、原目录；新设置用于新会话。更改默认后端不能迁移已有工作。
- 后端定义属于启动配置，修改后受控重启。删除仍有会话的后端，或改变其协议/地址，会拒绝继续该会话，避免静默把历史发送给另一服务。修改模型默认值不改变原会话模型。尚无自动迁移命令。
- 已保存的动态设置优先于启动文件中的同名字段。现有实例要更改 `execution` 或 `work`，应通过版本化设置保存；全新模板使用独立状态目录避免继承旧设置。
- `parameters` 传递供应商的其他 JSON 参数，例如 `temperature`、`reasoning`、`thinking`。不能覆盖受管理的 model、history、tools、stream、store、输出格式或 token 上限。宿主不保证每个兼容模型支持这些参数。
- `maxOutputTokens` 默认 8192。Chat 默认使用 `max_completion_tokens`；仅支持旧字段的兼容服务设置 `chatTokenField: "max_tokens"`。Responses 使用 `max_output_tokens`，Anthropic 使用 `max_tokens`。
- `outputFormat` 默认 `prompt`：提示模型输出 JSON，并用本地 schema 校验；失败最多修正两次。`json-schema` 额外启用供应商结构化输出；`json-object` 启用 OpenAI JSON 模式。Anthropic 的 `json-object` 与 prompt 模式相同，使用本地校验。模板的 json-schema 要求所选模型支持该功能，否则改用 prompt。
- `images` 默认 false。启用前确认模型支持图片。图片保持协议要求的工具结果顺序；未启用时不向模型发送图片字节。纯文本工具仍可使用。
- `maxSteps` 和 `maxToolCalls` 分别限制每轮模型请求和工具调用次数，`maxContextBytes` 限制单次传输大小。每次 HTTP 请求受后端的 `requestTimeoutMs` 限制，整个 turn 受 `turnTimeoutMs` 限制。超限时保留历史和模型绑定。
- 启用自动恢复的私聊托管目标使用内置 OpenCode 执行时，若单轮时限将到、近期有实际工具进展且回执齐全，宿主会在下一次请求模型前交接。旧会话停止后，调度器再次核对原任务、权限、执行记录和剩余轮数，再由同一执行者接续。后台命令有可核验的宿主进程时可按原作业 ID 接管。缺少回执、存在未确认操作或预算已耗尽时保留阻塞状态。

`models` 资源同时列出后端和角色分配。API 返回 `configuredOnly=true`；它是配置清单，不是远端模型发现或凭据验证。setup 只检查环境变量存在和本地依赖，也会明确返回 `remoteVerified=false`。

## 工具和生命周期

三个 API agent loop 将同一组宿主工具转换为各自协议：Responses 的 function_call/function_call_output、Chat 的 tool_calls/tool 消息，以及 Anthropic 的 tool_use/tool_result。模型不能直接执行本机 shell、调用未注册工具或绕过工作作用域。工具输入经过 JSON schema 和宿主权限双重校验。

文件、资源、图片、shell、后台作业、子代理、停止、同讨论跟进和历史查看共用宿主实现。API 的 `api:<backend>:<uuid>` 是宿主会话 ID，不是客户端原生聊天 ID。控制台不会对 API 工作显示 Codex 深链接或接管按钮；`agent_takeover` 也会在改变状态前拒绝。使用 `agent_read` 读取 `ticket/<id>/transcript` 和 `ticket/<id>/message/<n>`。

steer 在下一次模型请求追加操作员说明，提示词刷新也在下一请求生效；中断会取消正在进行的 HTTP 请求。已经开始的工具可能已经产生副作用，仍应查看其作业/外部状态，不能把“停止模型请求”视为撤销外部动作。

工具调用开始前持久化意图，完成后持久化回执。进程中断后，保留的完成结果会补回协议消息；缺少完成回执的调用标记为不确定，不自动重放。同一个调用 ID 不允许重复执行。宿主的 requestId、投递和合并核对继续生效，无法因此证明外部系统提供了事务回滚。

## 不依赖 Codex 的命令沙箱

| sandboxDriver | 环境 | 验收 |
|---|---|---|
| `seatbelt` | macOS `/usr/bin/sandbox-exec` | 本机真实命令、权限、进程回收以及三种 API 工具接入均通过 |
| `bubblewrap` | Linux 已安装 `bwrap`，允许用户命名空间 | 真实 ARM64 Linux 内核以普通用户验收通过，见 LINUX.md；其他发行版未证明 |
| `codex` | 已安装 Codex CLI 的平台 | 兼容原有驱动；独立于模型后端选择 |
| `disabled` | 所有平台 | 不提供 managed shell，保留读取与子代理 |

驱动不可用时失败，不回退成无限制命令。只读/可写范围、附件、独立临时目录、宿主状态拒绝访问与环境变量白名单由宿主管理。Windows 尚无新增的独立沙箱驱动；可使用可用的 Codex 驱动或关闭 shell。单用户进程仍不能替代独立 OS 账号或多租户隔离。

## 升级和回退

当前 0.7.0 因新增企微收件箱恢复语义，将 schema 提升至 4。0.6.0 为 3；回退必须恢复对应升级前备份，见 [0.7.0 验收](ACCEPTANCE_0.7.md)。以下保留 0.6.0 引入 API 后端时的说明。

0.6.0 使用数据库 schema 3；0.5.0 为 2。升级前使用 `backup` 保存一致快照，并原样保留旧版启动 JSON 和 0.5.0 源码。备份中的 config.json 是运行该备份命令的版本解析后的配置；若用 0.6.0 备份旧库，其中也会包含新字段，不能直接给 0.5.0 使用。`restore` 替换数据库，不自动改写启动 JSON。

旧程序会拒绝新库。回退必须停止宿主/监督器，使用 `restore` 恢复**升级前**备份，再用旧源码和原始旧配置启动；不能让旧程序打开含 API 会话的新库。恢复会先保留当前库快照，但升级之后的新工作不会合并回旧备份。演练包含旧/新 Runtime 实际构造、读取保存的动态设置和关闭，未只检查 SQLite 版本。

可用两套源码重演：

```sh
node --import tsx examples/upgrade-backends-acceptance.ts /absolute/path/to/agent-hub-0.5.0
```

数据库备份包含 API 消息与工具回执。它不包含工作文件、Codex 用户目录、环境变量密钥，也不会撤销消息、推送或合并。历史与备份含任务内容，应与宿主状态一起妥善保管。

## 真实服务复验

设置服务的密钥环境变量、地址与支持工具的模型后，可逐个运行：

```sh
node --import tsx examples/backend-smoke.ts examples/config.backends.json responses
node --import tsx examples/backend-smoke.ts examples/config.backends.json chat
node --import tsx examples/backend-smoke.ts examples/config.backends.json anthropic
```

脚本会产生实际 API 费用。它使用独立合成文件和数据库，不启动配置中的外部来源；要求真实路由、文件工具、结果发送及第二轮同会话接续全部成功才通过。报告保留在 `.local/provider-smoke-*`，失败时保留状态供核查。

协议实现依据：[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[OpenAI Chat API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Anthropic tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)、[Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)。兼容服务可参考 [DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls/) 和 [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)，本机未安装 Ollama，未进行其模型实测。
