# Roppo Embedded Browser

[English](BROWSER.en.md) · [简体中文](BROWSER.md)

[Browser experience acceptance, 2026-11-15 (Chinese)](BROWSER_ACCEPTANCE_2026-11-15.md)

The browser lives on the right side of the session and shares the tab panel with **Files** and **Team activity**. The button in the top-right corner collapses or reopens the panel; the left side no longer has a separate browser entry. The Router keeps handling communication and dispatch, and Workers operate their own browsers through host tools; no second model planning loop is introduced.

## Usage

1. Ask the Router to perform a web task. A Worker opens an isolated browser autonomously; **View page** in Chat opens the matching session.
2. When your own sign-in or verification is needed, the task waits and Chat offers **Take control**. After signing in, click **Continue task**. The original Worker reads a fresh snapshot and continues the same task without another instruction.
3. For manual browsing, click **Open browser**. A default profile is created automatically. Names, saved accounts and Worker login grants live in **Settings → Browser**; none are prerequisites for public browsing.
4. Finished pages remain available for manual navigation and new tabs. The old Worker loses authority. Another window can use **Take over here** to transfer control.

Input includes pointer movement, down/up, drag selection, right-button events, scrolling, text/paste/IME and common keys. Copy/cut writes the remote selection to the local clipboard and requires browser clipboard permission. F6 focuses the address bar, which accepts URLs or search terms. During manual control the remote viewport follows the panel size; watching preserves the Worker's viewport.

**Browser files** uploads one file up to 25 MB into a standard file input on the current page and retrieves completed downloads. Selected uploads remain until the browser closes so a form can submit later. Task downloads are removed with their browser; save them before closing. File selection currently covers standard inputs in the main document, not every cross-origin frame, custom file manager or system file dialog.

## Persistence and isolation

Browser profiles and saved accounts remain selectable inside their own session, but a personal profile that is currently in use can be bound to only one session; to use it in another session, create a separate profile or close the original instance first. Worker login copying still follows the authorization you granted.

A personal browser uses its own Chrome profile and keeps persistent website cookies, site storage, and tab URLs/current tabs across sessions. It reopens after a normal close and after a host restart. Each Worker receives a different browser process session and writable directory per assignment/subagent; they do not share the personal profile and cannot operate tabs belonging to another assignment.

When reusing a personal login, Roppo first exports the authorized profile and then copies only the cookies and origin storage that match the target URLs into the task browser. Later changes made by the Worker are not written back to the personal profile. When several browsers use the same website account, the business data on the website's server still belongs to that one account; local browser isolation cannot remove write conflicts at the website's business layer. Tasks of this kind should be serialized by the Router, or use different website accounts.

Commands inside one session run serially. A manual takeover first blocks subsequent Worker commands and then waits for commands that already started to finish; stale control generations, stale snapshots, and stale tab references are rejected. After a manual-control lease expires the browser stays paused, and Worker write operations do not resume automatically. Finished pages are retained for human inspection and operation. Idle instances are reclaimed according to configuration; at capacity an unwatched, uncontrolled finished browser is reclaimed first. Only browsers that are actively being watched open a screen stream.

`superagent_browser` is the actual tool shared by the API backend and native Codex Workers. It provides the `profiles`, `open`, `navigate`, `snapshot`, `click`, `fill`, `press`, `scroll`, tab, `login`, `request_takeover`, and `close` operations. Element operations must carry the revision of the most recent snapshot, and tabs are addressed by stable IDs such as `t1`. A repeated `requestId` is not executed again, and unconfirmed write operations after a timeout or host interruption are not replayed automatically.

## Passwords and installation

Saved accounts are provided by Roppo's local credential vault and do not depend on Chrome's password-save popup. Passwords are encrypted with AES-256-GCM, and the key file is readable and writable only by the host user; a key environment variable can be specified instead. Tools only receive a `credentialId`, and the password is passed to the browser through standard input, so it never appears in command-line arguments, ordinary log tables, or tool receipts; known saved passwords are filtered out of page snapshots returned to the model. Passwords are not imported from your everyday Chrome password library, and no cloud sync is offered.

Deleting a saved account removes only the password record; it does not sign the website session out. To end a website session, use the website's own logout inside the corresponding browser.

The runtime depends on the pinned `agent-browser 0.27.0`. On macOS the installed Google Chrome is used by default; on other hosts you can point `browser.executablePath` at a compatible executable, or install the Chrome the tool uses:

```sh
npm ci
npx agent-browser install
npm run build:chat
```

Top-level configuration example (the rest of the configuration keeps its original values):

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

`maxSessions` counts both personal and task browsers. `browser.command` can select a compatible engine executable, and `browser.keyEnv` can name an environment variable that holds the 64-hex-digit key. Do not replace or drop the key directly on an existing vault.

The tools page in a Worker's configuration can turn off browser access and set a tab limit; this maps to `browser: {enabled, maxTabs}` for each `execution.workers[]` entry. These settings follow the existing task-configuration rules, and authorization of a personal profile is rechecked on every call.

Browser data lives under `<stateDir>/browser`. The existing database backup command does not include the whole Chrome profile: when migrating or backing up, stop the host and save the database, this directory, and the external key together. Restoring only the database does not restore logins, and a lost key cannot be used to recover saved passwords. Website session lifetime, cross-site SSO, device binding, and two-factor authentication remain decided by each website; permanent logins or unconditional migration across machines are not promised.

Current acceptance covers macOS with local Chrome. Linux/Windows, arbitrary external websites, Chrome extensions, system Passkeys, and complex cross-site login flows are not counted as passing items. See the [acceptance record](BROWSER_ACCEPTANCE_2026-11-07.md) and the [open-source licenses](THIRD_PARTY_BROWSER.md).

Workers can export a PNG using `screenshot`, with optional `fullPage`. The tool records a task-owned attachment, hash and, for writable workspaces, `workspacePath`. Images up to 8 MB are returned visually to the model and can be read through `superagent_read asset/<id>`. Chat displays a downloadable thumbnail. Screenshot attachments survive browser closure and follow task-history cleanup.

Human input uses agent-browser's existing WebSocket input protocol instead of starting a CLI and querying tabs for each click or scroll. Pointer moves and wheel events are coalesced. Chat receives each new frame as it arrives. If the client falls behind, the host resumes with the latest frame. The preview fits within the sidebar at its original aspect ratio and never enlarges the image. Taking control leaves the remote viewport size intact. See [upstream Streaming](https://agent-browser.dev/streaming).

### Persistent workspace browser

For an account with a dedicated external Chromium, the host configuration can set
`browser.workspace` to an object containing the account's `owner` UUID and a
loopback `cdpPort`. The external service owns the browser profile and must keep
it on persistent storage. Restrict its debugging endpoint to the local host.
The built-in Chat opens that browser for the account and exposes
`workspace_browser` to its Router. Taking control suspends Router input.
Returning control after a requested takeover continues the original conversation
in the same tab. An AgentHub restart reconnects to the external browser.
Before stopping the external service, close Chromium gracefully so it can flush
recent login data. Sites determine the lifetime of their sessions.

For LinuxServer Chromium on the local Colima deployment, set `PIXELFLUX_WAYLAND=false` when creating the container. This selects X11/Xvfb. In a local comparison with the Selkies viewer disconnected, it reduced click-to-preview latency. Reuse the persistent `/config` volume and stop Chromium gracefully before switching the container.
