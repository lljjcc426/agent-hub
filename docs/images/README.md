# README artwork

## Product tour media

The product READMEs use actual interface captures with isolated demo data. The
names, model labels, launch brief and responses are illustrative. These images
show UI behavior, not live-provider execution or external connector acceptance.

Captured on 2026-11-15 from `6a822f6202f1cb4bdeee42ead85681bb50253e58`,
using the production Chat build and the normal local runtime:

| Asset | What it shows | Size / playback |
| --- | --- | --- |
| [files-math.jpg](product/files-math.jpg) | Agents list, a follow-up question and rendered LaTeX | 1280 × 720 |
| [attachments.jpg](product/attachments.jpg) | File attachment and a drafted request | 1280 × 720 |
| [agents.jpg](product/agents.jpg) · [dark](product/agents-dark.jpg) | Router–Worker context and the read-only Worker composer | 1280 × 720 |
| [chat-flow.gif](product/chat-flow.gif) | File reading, one Worker assignment, progress and a streamed reply | 960 × 540 · 21 s · 5 fps |
| [agents-view.gif](product/agents-view.gif) | Chat display setting, Router view, Worker view and dark theme | 960 × 540 · 12 s · 5 fps |

The chat GIF samples the running UI. The Agents GIF holds successive UI states
for readability. Both were encoded from browser screenshots with FFmpeg; no
page content or screenshot text was replaced. All account state and capture
fixtures remain outside version control. The three README GIFs total about
0.6 MB; the full video downloads only when opened.

Additional existing captures:

- [memory-settings-light.png](memory-settings-light.png): the memory settings
  UI at `a07e026` (2026-11-13), using isolated memory fixtures.
- [automation-workspace-light.jpg](automation-workspace-light.jpg): the shared
  automation workspace at `db9738d` (2026-11-15). See the
  [automation acceptance record](../AUTOMATION_WORKSPACE_ACCEPTANCE.md).

[english-tour.gif](product/english-tour.gif) is a 4-second, 960 × 540, 8 fps
excerpt of the English concept film. Its authored scenes are separate from the
runtime screenshots. See [video provenance and specifications](../media/README.md).

For model execution evidence, see the separate
[native file-task acceptance](../CHAT_FILES_MATH_ACCEPTANCE.md#native-autonomous-task).

## Roppo hero

- Asset: [roppo-hero.png](roppo-hero.png).
- Created with the built-in OpenAI image generation tool on 2026-11-07.
- Reference: the project's existing [Roppo mark](../../src/ui/assets/roppo-mark.png).
- Purpose: an original monochrome brand illustration, not a screenshot or a literal runtime topology.
- Used without post-generation image editing.

## Workspace screenshots

[workspace-dark.png](workspace-dark.png) and [workspace-light.png](workspace-light.png) show the running Roppo interface using isolated demo data. They do not demonstrate a live-provider result. Model names and task results in these screenshots are fixtures.

## Editorial references

The README hierarchy was informed by the public READMEs of [Dify](https://github.com/langgenius/dify), [Open WebUI](https://github.com/open-webui/open-webui), and [Browser Use](https://github.com/browser-use/browser-use): a recognizable product introduction, prominent setup, actual interface imagery, then documentation and community entry points. Their artwork and product copy were not reused.
