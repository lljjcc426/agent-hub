# Roppo CLI

Run `roppo` in a project directory to work with the Router and Workers configured in your local Roppo instance. Terminal and web sessions use the same account, messages, tasks and files. Workers run on the host and continue after the terminal exits.

## Install and connect

Use Node.js 22.19 or newer. From the Roppo checkout, run the following commands.

```sh
npm ci
npm link
roppo --version
```

For a new installation, run `roppo init`, finish personal account and model setup in the browser, and leave the host running. For an existing instance, run `roppo login`. To select a specific local instance, run `roppo login --host http://127.0.0.1:4337`. Match the code printed in the terminal with the browser and click **Connect terminal**. The CLI remembers the selected host. `roppo logout` revokes this terminal credential.

The CLI can read a launcher connection file through `ROPPO_CONNECTION_FILE`. It uses the URL in that file. `--host` and `ROPPO_HOST` take precedence. Credentials are stored per host in private files under `~/.roppo/terminal`. Set `ROPPO_CLI_HOME` to use a separate profile.

## Work in a project

```sh
cd ~/work/my-project
roppo "Review the change and run the relevant tests"
roppo -c
roppo -r
roppo -r <conversation-id>
```

On first use of a new folder, Roppo shows its resolved project path and requested access. Subdirectories use the nearest Git root or a more specific registered workspace. Git projects with an existing commit use per-task worktrees. Empty repositories and other new directories use read-only access. Existing sources keep their configured workspace and permissions. Registering a new source uses the host's configuration update and requires an idle host. A subscription restricted to a specific source uses that registered source.

Type `/` to browse commands and `@` to search project files. Use ↑ and ↓ to select, Tab to complete and Esc to dismiss. Git projects include tracked files and non-ignored untracked files. File names with spaces are quoted on insertion. Alt+Enter inserts a newline. Pasting several lines in a terminal with bracketed paste keeps them together until you press Enter.

Run `roppo -r` to search this project's conversations by title. Press Enter to resume a match or use `roppo -c` for the most recent conversation.

Interactive startup clears the screen. The project and team appear above the composer. Ctrl+O shows workspace details while idle.

During a run, the status shows the current public activity and elapsed time. Ctrl+O expands recent tools. Esc interrupts the current run when the picker is closed. Ctrl+D on an empty prompt or `/exit` leaves work running.

Use `/plan` to read published steps or `/choose` to answer an open Router question. Type `/diff` followed by a space to select a Worker task and inspect its changes. `/approvals` shows pending requests for a selected task. `/approve`, `/decline` and `/answer` let you pick a task and request, then submit your response. `/tools Codex` filters the capability picker by source or name. Press Enter to inspect the selected capability. `/open` opens the same conversation in the web workspace.

[Start screen](images/product/terminal-home.png) · [Worker in progress](images/product/terminal-working.png) · [Completed reply](images/product/terminal-reply.png).

## Use in scripts

```sh
git diff | roppo -p "Review this diff"
roppo -p "Summarize the supplied file" --file notes.md --json
roppo -c -p "Report the results" --timeout 120
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

## References

The interaction and naming draw on Claude Code’s documented print and resume modes and Codex’s separate interactive and script interfaces. Roppo owns session storage and task execution. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) · [Claude Code repository license](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) · [Codex CLI arguments](https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs) · [Codex session picker](https://github.com/openai/codex/blob/main/codex-rs/tui/src/resume_picker.rs).
