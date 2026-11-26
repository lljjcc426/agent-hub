# Roppo CLI

Run `roppo` from any directory to continue your personal conversation with the Router. `roppo -c` and `roppo -p "prompt"` use that same personal Chat by default. The current directory is used for attachments and terminal preferences; it does not create a project conversation. Page Up and Page Down scroll history. Paging back at the beginning loads earlier messages. Terminal and web sessions use the same account, messages, tasks and files. Workers run on the host and continue after the terminal exits.

## Install and connect

Use Node.js 22.19 or newer. The interactive screen uses OpenTUI and the Bun runtime installed with this project; no global Bun or Node upgrade is needed. The host and print commands stay on Node. From the checkout, run:

```sh
npm ci
npm link
roppo --version
```

For a new installation, run `roppo init`, finish personal account and model setup in the browser, and leave the host running. For an existing instance, run `roppo login`. To select a specific local instance, run `roppo login --host http://127.0.0.1:4337`. Match the code printed in the terminal with the browser and click **Connect terminal**. The CLI remembers the selected host. `roppo logout` revokes this terminal credential.

The CLI can read a launcher connection file through `ROPPO_CONNECTION_FILE`. It uses the URL in that file. `--host` and `ROPPO_HOST` take precedence. Credentials are stored per host in private files under `~/.roppo/terminal`. Set `ROPPO_CLI_HOME` to use a separate profile.

Choose `roppo lang zh` for Chinese or `roppo lang en` for English. This preference applies to future launches. Use `--lang zh` or `--lang en` for a single invocation. The setting controls the terminal interface. Replies follow the host’s existing language policy.

## Your personal conversation

```sh
roppo
roppo -c
roppo -p "Help me plan tomorrow"
roppo -r
```

The main transcript shows your messages and public Router replies. Internal Worker conversations and task logs stay out of the default view. Delivered files appear as file notices and remain available through `/files`. The welcome screen does not ask you to select a project or manage Workers.

Type `/` to browse commands and `@` to browse local files and directories. File names with spaces are quoted on insertion. Ctrl+P opens a searchable command palette. Arrow keys select, Enter confirms, and Esc closes a menu while preserving the draft and cursor. Shift+Enter (where supported), Alt+Enter or Ctrl+J inserts a newline. Bracketed paste stays in the draft until Enter, including pasted slash commands.

The screen uses OpenTUI's alternate screen, native text input, Markdown and scroll container. Empty conversations show a centered wordmark and compact filled input with no scrollable filler. Existing conversations open directly. Messages scroll above the fixed composer. Internal Workers stay out of the transcript; `/tasks` opens execution details on demand.

An eight-cell activity strip runs during real work and disappears on completion or when a response is needed. Replies update from host events without an artificial typing delay. Reading older messages pauses automatic following; Ctrl+End returns to the latest reply. `/settings` offers animation and theme controls. Esc or Ctrl+C interrupts the current run when no menu is open. Idle Ctrl+C clears a draft, or exits from an empty input. Ctrl+D on an empty prompt and `/exit` leave the host running.

Ctrl+Y and `/approvals` review pending permissions, Router choices, structured questions and file deliveries. `/files` previews delivered text and saves files to a chosen path without overwriting existing files. `/memory` reviews, edits or forgets personal memories. `/schedules` reads, pauses and resumes scheduled actions; describe new reminders and timing changes in the same chat. `/tools` searches capabilities, and `/open` opens this conversation in the browser.

`roppo -r`, `/resume` and `/clear` remain explicit compatibility controls. The default navigation has one continuous personal conversation and no project or Worker session tabs. `ROPPO_LEGACY_TUI=1 roppo` temporarily selects the previous renderer for troubleshooting; it uses the same host and conversation.

## Settings and session controls

Type a slash command to open a searchable picker. Arrow keys move, Enter selects, and Esc returns to your draft. The following commands work against the running host:

| Command | Behavior and scope |
| --- | --- |
| `/settings`, `/config` | Terminal preference picker; `/config key=value [user\|project\|local]` saves a value |
| `/theme` | System, dark, light or monochrome screen colors |
| `/model` | Choose a configured connection and model for the **shared Router** |
| `/model CONNECTION MODEL` | Select an explicit model ID; `--default` uses the connection default |
| `/effort` | Choose an effort advertised by the selected model, or `default` |
| `/permissions` | Select `ask` or `full` for the **shared account**; existing source sandbox limits still apply |
| `/status` | Connection, shared conversation, model, permissions and loaded preference files |
| `/context` | Recorded input-token/context measurements; unavailable measurements are shown as unavailable |
| `/clear` | Start a new conversation without deleting the old one or stopping its work |
| `/resume` | Search saved conversations in the current project, or personal Chat when outside a project session |
| `/rename TITLE` | Rename the current conversation |
| `/files` | Preview and save delivered files |
| `/memory` | Review, edit and forget shared personal memory |
| `/schedules` | Read, pause and resume scheduled actions |
| `/history` | Search this conversation and load older messages |
| `/approvals` | Review and answer pending permission requests without entering task IDs |

Model changes apply to subsequent Router turns, including those submitted from the web. They do not change Worker profiles or a turn's already captured model binding. Permission changes affect the account's web and terminal sessions. The permission picker spells out this scope; full access requires a confirmation in the new interface. Terminal credentials use narrow settings endpoints and cannot submit arbitrary host configuration patches.

Terminal preferences load from these sources, from lowest to highest priority:

1. Built-in defaults.
2. `~/.roppo/terminal/settings.json` (or `$ROPPO_CLI_HOME/settings.json`).
3. `.roppo/settings.json` in the selected `--cwd` directory, or launch directory.
4. `.roppo/settings.local.json` in that directory.
5. `--settings '{"theme":"mono"}'` or `--settings path/to/settings.json`.
6. Dedicated launch flags such as `--theme`, `--verbose`, `--lang` and `--timeout`.

Supported keys are `theme` (`system`, `dark`, `light`, `mono`), `language` (`en`, `zh`), `verbose` (boolean), `motion` (`full` or `reduced`), `outputFormat` (`text`, `json`, `stream-json`) and `timeout` (seconds, greater than zero and at most 86400). Unknown keys and invalid JSON produce an error with the source path. `--help` and `--version` work independently of these settings files. Project preferences cannot grant permissions, change the host or inject credentials. Add `.roppo/settings.local.json` to your project's `.gitignore` when using local preferences.

```sh
roppo --theme dark --verbose
roppo --settings '{"language":"zh","theme":"mono"}'
# Inside a session:
/config verbose=true
/config theme=light local
```

A `/config` edit takes effect immediately in the current session, and saves to `user` scope unless another scope is specified. On the next launch, normal file/flag precedence applies again. `roppo lang zh|en` writes the user language preference and retains the legacy language file for older clients.

| Shortcut | Action |
| --- | --- |
| Ctrl+P | Search commands |
| F2 | Choose model |
| Ctrl+K | Search this conversation |
| Ctrl+Y | Review pending requests |
| Ctrl+C / Esc | Close menu or interrupt work |
| Ctrl+D | Exit from an empty prompt |
| Shift+Enter / Alt+Enter / Ctrl+J | New line |
| Page Up / Page Down | Scroll history; Page Up at the beginning loads older messages |
| Ctrl+End | Return to the latest reply |
| Ctrl+Shift+C | Copy selected text |
| Mouse wheel | Scroll messages or document previews |

The interface restores terminal modes on exit. Keep mouse reporting enabled in your terminal for in-app scrolling and selection. Apple Terminal may send Enter and Shift+Enter identically; Alt+Enter or Ctrl+J works there without changing terminal settings.

## Use in scripts

```sh
cat notes.txt | roppo -p "Summarize these notes"
roppo -p "Summarize the supplied file" --file notes.md --json
roppo -c -p "Report the results" --timeout 120
roppo -p "Summarize progress" --output-format stream-json
```

Only explicit project mode needs folder registration: use `--cwd DIRECTORY --trust-project` for a new project. A print invocation waits for its own run and associated Worker tasks. Plain output contains the reply. With `--json`, stdout contains one object with `conversationId`, `runId`, `status`, `text`, `tasks` and `deliveries`. Startup and transport errors return an error object. Use the conversation ID with `-r` to continue.

| Exit code | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Failed, unavailable, or sign-in required |
| 2 | Invalid command or input |
| 3 | Waiting for a decision or clarification |
| 124 | Wait timed out. The host continues the run |
| 130 | Cancelled or interrupted |

### Streaming output

`--output-format text|json|stream-json` selects print mode. `--json` is the existing JSON alias. A stored `outputFormat` preference only changes print output; it does not turn an interactive launch into a script.

`stream-json` emits newline-delimited JSON with no terminal decoration:

- `system` with `subtype: "init"`, `conversationId`, `runId`, and the web URL after the host accepts the message.
- `assistant` with a `message` containing its stable `id`, text, status and speaker. Each changed record **replaces** that message; it is not a token delta. Private Router-to-Worker messages are excluded.
- `task` with the latest changed Worker task.
- Exactly one final `result` with the normal result fields. Startup or transport failure uses `status: "error"`, `code` and `error`.

The client polls run snapshots, so a fast reply may appear only once. This is Roppo's event schema, not Claude's wire protocol. Ctrl+C requests cancellation and exits with 130. Reaching `--timeout` exits with 124 while the host continues working.

## Optional project compatibility

```sh
cd ~/work/my-project
roppo --cwd . "Review the change and run the relevant tests"
roppo --cwd . -c
roppo --cwd . -r
roppo --cwd . -r <conversation-id>
```

On first use of a new folder, Roppo shows its resolved project path and requested access. Subdirectories use the nearest Git root or a more specific registered workspace. Git projects with an existing commit use per-task worktrees. Empty repositories and other new directories use read-only access. Existing sources keep their configured workspace and permissions. Registering a new source uses the host's configuration update and requires an idle host. A subscription restricted to a specific source uses that registered source.


## Interface reference

The interactive screen follows OpenCode's input, searchable overlays, Markdown and activity feedback. Roppo retains one personal Router conversation, its local service and internal Worker collaboration. The host continues to own authorization, memory, schedules and file delivery.

- [OpenCode TUI documentation](https://opencode.ai/docs/cli/tui/)
- [OpenTUI runtime support](https://opentui.com/docs/getting-started/runtime-support/)

The interactive renderer runs on the bundled Bun because current OpenTUI requires Bun 1.3.14+ or Node 26.4+ with experimental FFI. Print mode and the service continue to support Node 22.19+.
