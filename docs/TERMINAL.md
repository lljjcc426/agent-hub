# Roppo CLI

Run `roppo` from any directory to continue your personal conversation with the Router. `roppo -c` and `roppo -p "prompt"` use that same personal Chat by default. The current directory is used for attachments and terminal preferences; it does not create a project conversation. Page Up and Page Down scroll history. Paging back at the beginning loads earlier messages. Terminal and web sessions use the same account, messages, tasks and files. Workers run on the host and continue after the terminal exits.

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

## Your personal conversation

```sh
roppo
roppo -c
roppo -p "Help me plan tomorrow"
roppo -r
```

The main transcript shows your messages and public Router replies. Internal Worker conversations and task logs stay out of the default view. Delivered files appear as file notices and remain available through `/files`. The welcome screen does not ask you to select a project or manage Workers.

Type `/` to browse commands and `@` to search local files. Use ↑ and ↓ to select, Tab to complete and Esc to dismiss. Git projects include tracked files and non-ignored untracked files. File names with spaces are quoted on insertion. Alt+Enter inserts a newline. Pasting several lines in a terminal with bracketed paste keeps them together until you press Enter.

Run `roppo -r` to search personal conversation history by title. Selecting a conversation also makes it current in the web workspace. `/clear` explicitly starts a fresh conversation and retains the previous history and background work.

Interactive startup shows a compact, left-aligned welcome card and a warm accent color. The input uses horizontal rules and a `❯` prompt. Messages align left and the composer stays at the bottom through window resizing and incoming replies. Ctrl+O explicitly expands execution diagnostics; they stay collapsed by default.

Sending a message and loading command options show immediate animated feedback. During execution, the status uses the Router’s public update, a published plan step, or a simple activity label. Replies update as real streamed content arrives. Ctrl+O expands internal tasks and tools. `/config motion=reduced` disables periodic animation; `motion=full` restores it. Animations do not move the input or override your history scroll position. Esc or Ctrl+C interrupts the current run when the picker is closed. Idle Ctrl+C clears the draft; on an empty prompt, press it twice within one second to exit. Ctrl+D on an empty prompt or `/exit` leaves work running.

Use `/plan` to read published steps, `/choose` to answer a Router question, and `/files` to see shared attachments and delivered files. `/approvals` lists actions that need your permission; select an action, review its scope, then choose Allow or Decline. Complex structured questions currently link to the same web conversation. `/tools` searches available capabilities; `/open` opens the shared conversation in the browser.

Internal task and Git inspection commands remain available through `/help advanced` and explicit command names. They are not the default conversation navigation. See [the product boundary](CLI_PRODUCT.md) for the design and current limits.

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
| `/status` | Connection, shared conversation, model, permissions and loaded preference files |
| `/context` | Recorded input-token/context measurements; unavailable measurements are shown as unavailable |
| `/clear` | Start a new conversation without deleting the old one or stopping its work |
| `/resume` | Search saved conversations in the current project, or personal Chat when outside a project session |
| `/rename TITLE` | Rename the current conversation |
| `/files` | Shared attachments and delivered file links |
| `/approvals` | Review and answer pending permission requests without entering task IDs |

Model changes apply to subsequent Router turns, including those submitted from the web. They do not change Worker profiles or a turn's already captured model binding. Permission changes affect the account's web and terminal sessions. The permission picker spells out this scope; Shift+Tab opens it without granting access automatically. Terminal credentials use narrow settings endpoints and cannot submit arbitrary host configuration patches.

Terminal preferences load from these sources, from lowest to highest priority:

1. Built-in defaults.
2. `~/.roppo/terminal/settings.json` (or `$ROPPO_CLI_HOME/settings.json`).
3. `.roppo/settings.json` in the selected `--cwd` directory, or launch directory.
4. `.roppo/settings.local.json` in that directory.
5. `--settings '{"theme":"mono"}'` or `--settings path/to/settings.json`.
6. Dedicated launch flags such as `--theme`, `--verbose`, `--lang` and `--timeout`.

Supported keys are `theme` (`dark`, `light`, `mono`), `language` (`en`, `zh`), `verbose` (boolean), `motion` (`full` or `reduced`), `outputFormat` (`text`, `json`, `stream-json`) and `timeout` (seconds, greater than zero and at most 86400). Unknown keys and invalid JSON produce an error with the source path. `--help` and `--version` work independently of these settings files. Project preferences cannot grant permissions, change the host or inject credentials. Add `.roppo/settings.local.json` to your project's `.gitignore` when using local preferences.

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


## Claude Code alignment

This fork uses Claude Code’s terminal layout, input, feedback and keyboard conventions as a reference. Its default experience is one personal conversation with the Router, with internal Worker collaboration retained behind the scenes. See [CLI compatibility and remaining work](CLI_COMPATIBILITY.md) for implemented behavior and gaps. It does not read or modify `~/.claude` configuration or use Claude's branding.

## References

The interaction and naming draw on Claude Code’s documented print and resume modes and Codex’s separate interactive and script interfaces. Roppo owns session storage and task execution. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) · [Claude Code repository license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) · [Codex CLI arguments](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs) · [Codex session picker](https://github.com/openai/codex/blob/main/codex-rs/tui/src/resume_picker.rs).
