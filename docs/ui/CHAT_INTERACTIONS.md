# Chat replies and motion

Chat keeps one conversation and an always-available Send action. A quote of a Worker message is sent to Router; the Worker view remains read-only.

- Hover or focus a message to quote, react, copy its rendered text, or copy Markdown from More. On touch screens, More holds the quote and reaction actions.
- Select text inside a message to quote that selection. Math expressions retain their TeX source; code headers and copy controls are excluded.
- Quote drafts survive reload and failed admission. Clicking a sent quote locates the original, including older pages and another Agent's view. Back to latest restores the current window.
- Reactions persist with the message and can be removed. They do not start a model turn, approve a task, or change its state.

## Data and continuity

`chat-message.quote` stores a source message ID and an optional verified selection. The server resolves the source within the owned conversation and derives its author. Whole-message quotes retain their complete text. `quotedMessage` is separate from the current trigger and mandate; scoped journal rebuilds and unscoped transcript rebuilds include this background. Missing or cleared originals are unavailable. Chat reset covers quotes and reactions through the existing history cleanup.

`POST /api/chat/conversations/:id/reactions` sets `{messageId, emoji, active}` idempotently. The UI serializes rapid edits per message, applies server-confirmed state, and preserves the current Agent/window when a write finishes. Streaming updates preserve saved reactions.

`GET /api/chat/conversations/:id?around=:messageId` returns a bounded window containing the original. Loading earlier preserves the reader's anchor; returning to latest replaces the historical window rather than joining disconnected pages.

## Motion

The implementation uses existing CSS, Web Animations and a single animation-frame scroll follower. It adds no animation dependency or user configuration.

| Interaction | Duration |
| --- | --- |
| New message | 360 ms |
| New streamed block | 220 ms |
| Tool arrival / disclosure | 320 / 280 ms |
| Reaction insertion or removal | 260 ms |
| Quote draft expansion | 300 ms |
| Popover / copy icon | 220 ms |

Animations reverse or cancel from their current state. The scroll follower stops on reader input; new output does not pull someone away from history. `prefers-reduced-motion` disables movement. Copy feedback follows the real clipboard promise and stays within the action row.

## Verification

`tests/chat-interactions.spec.ts` covers ownership, selection validation, complete long quotes, idempotency, restart and model-change continuity, paginated originals, reactions during streaming, HTTP authorization, and Chat reset. Existing Chat, duplex and math suites also run.

Browser acceptance covers desktop and mobile, dark mode, reduced motion, whole and selected quotes, code and formula copying, clipboard rejection, draft recovery after failed admission, emoji search/removal, rapid reactions, continuous sending, reading during streaming, earlier-page anchoring, and quoting/locating Worker messages. A separate isolated DeepSeek run verifies that the actual model receives and answers the quoted context; reactions make no model call.
