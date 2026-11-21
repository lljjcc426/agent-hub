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

**Browser files** uploads one file up to 100 MiB into a standard file input on the current page and shows downloads from that browser. A Worker can set `download:true` on the click that triggers a download to wait for the file and get its name. Task files remain available until the browser closes.

## Persistence and isolation

The workspace browser uses an existing Roppo profile or creates one on first use. Personal profiles keep cookies, site storage, tabs and grants. Each Worker task runs in a separate Chromium context, with its own tabs, cookies and site storage.

When a Worker opens a saved profile, Roppo checks the sharing switch or existing Worker grants. It copies cookies scoped to the destination host and site storage scoped to the destination origin. Changes stay inside that task browser. Enabling sharing applies to current and future Workers.

Commands inside one session run serially. A manual takeover first blocks subsequent Worker commands and then waits for commands that already started to finish; stale control generations, stale snapshots, and stale tab references are rejected. After a manual-control lease expires the browser stays paused, and Worker write operations do not resume automatically. Finished pages are retained for human inspection and operation. Idle instances are reclaimed according to configuration; at capacity an unwatched, uncontrolled finished browser is reclaimed first. Only browsers that are actively being watched open a screen stream.

`superagent_browser` is the actual tool shared by the API backend and native Codex Workers. It provides the `profiles`, `open`, `navigate`, `snapshot`, `click`, `fill`, `press`, `scroll`, tab, `login`, `request_takeover`, and `close` operations. Element operations must carry the revision of the most recent snapshot, and tabs are addressed by stable IDs such as `t1`. A repeated `requestId` is not executed again, and unconfirmed write operations after a timeout or host interruption are not replayed automatically.

## Passwords and installation

Saved accounts are provided by Roppo's local credential vault and do not depend on Chrome's password-save popup. Passwords are encrypted with AES-256-GCM, and the key file is readable and writable only by the host user; a key environment variable can be specified instead. Tools only receive a `credentialId`, and the host fills the password through the browser connection, keeping it out of command-line arguments, ordinary log tables and tool receipts; known saved passwords are filtered out of page snapshots returned to the model. Passwords are not imported from your everyday Chrome password library, and no cloud sync is offered.

Deleting a saved account removes only the password record; it does not sign the website session out. To end a website session, use the website's own logout inside the corresponding browser.

On first use, Roppo prepares the pinned Chromium and recording encoder automatically. The official container includes the browser and encoder at build time. Existing Roppo browser profiles retain their original directory and logins where supported by the host. Workspaces with a configured external Chromium keep their connection and persistent storage.

On macOS, open **Settings → Workspace settings → Browser → Desktop control** and select **Enable**. Roppo prepares the signed Cua Driver component and opens the system permission guide. Turn on Accessibility and Screen Recording in macOS and accept its direct capture confirmation if shown. The desktop package includes the component. A source installation downloads and verifies it automatically when needed. Native controls need a signed-in graphical session. Headless hosts can use the embedded browser.

The managed OpenCode backend receives both `superagent_browser` and `superagent_desktop` through the existing Roppo MCP connection.

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

`maxSessions` counts both personal and task browsers. `browser.executablePath` can select a host-provided Chromium. `browser.keyEnv` can name an environment variable that holds the 64-hex-digit key. Do not replace or drop the key directly on an existing vault.

The tools page in a Worker's configuration can turn off browser access and set a tab limit; this maps to `browser: {enabled, maxTabs}` for each `execution.workers[]` entry. These settings follow the existing task-configuration rules, and authorization of a personal profile is rechecked on every call.

Browser data lives under `<stateDir>/browser`. The existing database backup command does not include the whole Chrome profile: when migrating or backing up, stop the host and save the database, this directory, and the external key together. Restoring only the database does not restore logins, and a lost key cannot be used to recover saved passwords. Website session lifetime, cross-site SSO, device binding, and two-factor authentication remain decided by each website; permanent logins or unconditional migration across machines are not promised.

See the [historical acceptance record](BROWSER_ACCEPTANCE_2026-11-07.md) and the [runtime licenses](THIRD_PARTY_BROWSER.md).

### Screenshots and recordings

- `screenshot` exports PNG with optional `fullPage`. `record_start` and `record_stop` save a silent MP4 of the selected tab. Roppo prepares the encoder automatically.
- Cua Driver `get_window_state` with `include_screenshot:true` or `get_desktop_state` supplies PNG. Its recording tools save a silent MP4 of the primary display. Only one display recording can run at a time.
- Both tools return task-owned attachments. Chat can download the captures and writable tasks also receive a workspace path. Use `inlineImage:false` for image capture with a text-only model. Recordings stop on assignment end or their configured duration.

The watched page is rendered beside Chat. The existing takeover, return control and full-screen controls apply to the live page.

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
