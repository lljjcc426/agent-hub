# Chat presentation acceptance — 2026-11-15

## Scope

Compact user bubbles; real timestamps; a single footer for timestamp, current run status and copy; once-only arrivals and animated tool disclosures; editable Router/Worker names; language-aware replies. The default one-Worker ownership policy and authorization rules are unchanged.

## Browser evidence

An isolated host from `examples/chat-presentation-acceptance.ts` was exercised in the in-app Chromium browser. Its default model is explicitly a UI fixture, not proof of autonomous bug-fixing or language selection.

- Desktop 1440 × 1000, mobile 390 × 844, light and dark themes.
- A one-line desktop bubble measures 43px (previously 87px); mobile one-line 41.2px and three-line 91.6px. Paragraph margins are zero and the mobile document has no horizontal overflow.
- First-send creation, subsequent tool arrivals, restored history and Agent switching checked through actual DOM state. New content has `chat-enter`; reload and Agent switches have no arrival attributes. Disclosure transition is 200ms. Reduced-motion emulation yields `animation-name: none` and zero disclosure transition duration.
- Timestamp, completed status and copy have the same vertical center. Copy returns only the reply text. Cancelling a live request yields Stopped, never Complete.
- Router renamed from Rory to 小洛 and Worker from Atlas to 阿特 through the real configuration form and revisioned Save. Chat, Agents previews, tool actors, composer and Worker conversation headers update. Worker input remains disabled.

## Native model evidence

The `native` mode uses the signed-in Codex CLI with `gpt-6.1-terra`; no fixture supplies these responses. All four turns completed in the same Chat:

| Human message | Browser locale | Observed reply |
| --- | --- | --- |
| introduce yourself | zh-CN | English introduction identifying itself as Rory |
| 用一句话说说你能帮我做什么 | en-GB | One-sentence Chinese reply |
| 请用英文介绍你自己。 | zh-CN | English introduction |
| 👋 | fr-FR | Bonjour ! 👋 |

After applying the corrected local custom prompt to the isolated native host, a fifth English introduction also completed in English and retained the configured name Rory. These are observed language cases, not an exhaustive multilingual evaluation. Browser reduced-motion emulation is distinct from testing every OS/browser combination.

## Regression coverage

`npm run check`: 97 test files passed, 1481 tests passed and 1 skipped. Backend, Chat and workspace-view type checks and the production Chat build passed.

Chat tests cover per-message locale persistence, idempotent retries, Router → Worker → Router locale propagation, invalid locale rejection, renamed historical projections without rewriting stored evidence, unchanged IDs and continued chat after rename. Prompt preview tests cover configured identities and the same language contract used at runtime.

The local installation also had an old custom Router prompt specifying “默认使用中文” and a fixed Feishu identity. Correcting that saved prompt is a deployment-specific configuration change, not a migration that overwrites other users’ instructions.
