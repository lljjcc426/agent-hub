# Roppo CLI

Run `roppo` from any directory to open your account’s personal Chat and load its recent messages. Page Up and Page Down scroll history. Paging back at the beginning loads earlier messages. Terminal and web sessions use the same account, messages, tasks and files. Workers run on the host and continue after the terminal exits.

## Install and connect

Use Node.js 22.19 or newer. From the Roppo checkout, run the following commands.

```sh
npm ci
npm link
roppo --version
```

For a new installation, run `roppo init`, finish personal account and model setup in the browser, and leave the host running. For an existing instance, run `roppo login`. To select a specific local instance, run `roppo login --host http://127.0.0.1:4337`. Match the code printed in the terminal with the browser and click **Connect terminal**. The CLI remembers the selected host. `roppo logout` revokes this terminal credential.

The CLI can read a launcher connection file through `ROPPO_CONNECTION_FILE`. It uses the URL in that file. `--host` and `ROPPO_HOST` take precedence. Credentials are stored per host in private files under `~/.roppo/terminal`. Set `ROPPO_CLI_HOME` to use a separate profile.

Choose `roppo lang zh` for Chinese or `roppo lang en` for English. This preference applies to future launches. Use `--lang zh` or `--lang en` for a single invocation. The setting controls the terminal interface. Replies follow the host’s existing language policy.

## Work in a project

```sh
cd ~/work/my-project
roppo --cwd . "Review the change and run the relevant tests"
roppo -c
roppo -r
roppo -r <conversation-id>
```

On first use of a new folder, Roppo shows its resolved project path and requested access. Subdirectories use the nearest Git root or a more specific registered workspace. Git projects with an existing commit use per-task worktrees. Empty repositories and other new directories use read-only access. Existing sources keep their configured workspace and permissions. Registering a new source uses the host's configuration update and requires an idle host. A subscription restricted to a specific source uses that registered source.

Type `/` to browse commands and `@` to search project files. Use ↑ and ↓ to select, Tab to complete and Esc to dismiss. Git projects include tracked files and non-ignored untracked files. File names with spaces are quoted on insertion. Alt+Enter inserts a newline. Pasting several lines in a terminal with bracketed paste keeps them together until you press Enter.

Run `roppo -r` to search this project's conversations by title. Press Enter to resume a match or use `roppo -c` for the most recent conversation.

Interactive startup shows a compact, left-aligned welcome card and a warm accent color. The input uses horizontal rules and a `❯` prompt. Messages align left and the composer stays at the bottom through window resizing and incoming replies. Ctrl+O shows workspace details while idle.

During a run, the status names the active Router or Worker alongside its public update, observed tool operation, or assigned task. Ctrl+O expands recent tools. Esc or Ctrl+C interrupts the current run when the picker is closed. Idle Ctrl+C clears the draft; on an empty prompt, press it twice within one second to exit. Ctrl+D on an empty prompt or `/exit` leaves work running.

Use `/plan` to read published steps or `/choose` to answer an open Router question. Type `/diff` followed by a space to select a Worker task and inspect its changes. `/approvals` shows pending requests for a selected task. `/approve`, `/decline` and `/answer` let you pick a task and request, then submit your response. `/tools Codex` filters the capability picker by source or name. Press Enter to inspect the selected capability. `/open` opens the same conversation in the web workspace.

[Current welcome and settings preview](images/product/terminal-cli-preview.svg), rendered from `TerminalLayout` using a deterministic fixture. The image demonstrates layout; it is not a live-provider execution capture.

## Settings and session controls

Type a slash command to open a searchable picker. Arrow keys move, Enter selects, and Esc returns to your draft. The following commands work against the running host:

| Command | Behavior and scope |
| --- | --- |
| `/config` | Terminal preference picker; `/config key=value [user\|project\|local]` saves a value |
| `/theme` | Dark, light or monochrome terminal colors; does not change the terminal application's background |
| `/model` | Choose a configured connection and model for the **shared Router** |
| `/model CONNECTION MODEL` | Select an explicit model ID; `--default` uses the connection default |
| `/effort` | Choose an effort advertised by the selected model, or `default` |
| `/permissions` | Select `ask` or `full` for the **shared account**; existing source sandbox limits still apply |
| `/status` | Host, session, project, Router, readiness and loaded preference files |
| `/context` | Recorded input-token/context measurements; unavailable measurements are shown as unavailable |
| `/clear` | Start a new conversation without deleting the old one or stopping its work |
| `/resume` | Search saved conversations in the current project, or personal Chat when outside a project session |
| `/rename TITLE` | Rename the current conversation |

Model changes apply to subsequent Router turns, including those submitted from the web. They do not change Worker profiles or a turn's already captured model binding. Permission changes affect the account's web and terminal sessions. The permission picker spells out this scope; Shift+Tab opens it without granting access automatically. Terminal credentials use narrow settings endpoints and cannot submit arbitrary host configuration patches.

Terminal preferences load from these sources, from lowest to highest priority:

1. Built-in defaults.
2. `~/.roppo/terminal/settings.json` (or `$ROPPO_CLI_HOME/settings.json`).
3. `.roppo/settings.json` in the selected `--cwd` directory, or launch directory.
4. `.roppo/settings.local.json` in that directory.
5. `--settings '{"theme":"mono"}'` or `--settings path/to/settings.json`.
6. Dedicated launch flags such as `--theme`, `--verbose`, `--lang` and `--timeout`.

Supported keys are `theme` (`dark`, `light`, `mono`), `language` (`en`, `zh`), `verbose` (boolean), `outputFormat` (`text`, `json`, `stream-json`) and `timeout` (seconds, greater than zero and at most 86400). Unknown keys and invalid JSON produce an error with the source path. `--help` and `--version` work independently of these settings files. Project preferences cannot grant permissions, change the host or inject credentials. Add `.roppo/settings.local.json` to your project's `.gitignore` when using local preferences.

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
| Ctrl+C / Esc | Interrupt an active run (Esc first dismisses an open picker) |
| Ctrl+D | Exit when the prompt is empty; work remains on the host |
| Ctrl+O | Toggle tool details |
| Ctrl+L | Redraw the terminal |
| Ctrl+R | Search input history; Enter restores the selected draft without sending it |
| Ctrl+S | Stash a draft, then restore it into an empty prompt |
| Alt+P | Open the model picker, preserving the draft |
| Shift+Tab | Open shared-account permissions |
| Alt+Enter / supported Shift+Enter / trailing `\` + Enter | Insert a newline |
| Page Up / Page Down | Scroll conversation history |
| Mouse wheel / trackpad scroll | Scroll the conversation by three lines, or move through the open menu |

The full-screen interface captures mouse events while running. An empty conversation stays fixed; overflowing messages scroll above the input. Exiting restores normal terminal mouse handling. In macOS Terminal, keep **View → Allow Mouse Reporting** enabled for this behavior. To select text with Terminal's native mouse handling, temporarily toggle it off with **Cmd+R**, then turn it back on to resume in-app scrolling.

## Use in scripts

```sh
git diff | roppo -p "Review this diff"
roppo -p "Summarize the supplied file" --file notes.md --json
roppo -c -p "Report the results" --timeout 120
roppo -p "Summarize progress" --output-format stream-json
```

For a new project, scripts can register the folder explicitly with `--trust-project`. A print invocation waits for its own run and associated Worker tasks. Plain output contains the reply. With `--json`, stdout contains one object with `conversationId`, `runId`, `status`, `text`, `tasks` and `deliveries`. Startup and transport errors return an error object. Use the conversation ID with `-r` to continue.

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

## Claude Code alignment

This fork uses Claude Code's terminal interaction conventions as a reference while retaining Roppo's shared host and Router/Worker execution model. See [CLI compatibility and remaining work](CLI_COMPATIBILITY.md) for implemented behavior and gaps. It does not read or modify `~/.claude` configuration or use Claude's branding.

## References

The interaction and naming draw on Claude Code’s documented print and resume modes and Codex’s separate interactive and script interfaces. Roppo owns session storage and task execution. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) · [Claude Code repository license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) · [Codex CLI arguments](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs) · [Codex session picker](https://github.com/openai/codex/blob/main/codex-rs/tui/src/resume_picker.rs).
