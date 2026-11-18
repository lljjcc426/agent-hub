# Chat files, formulas and copy feedback — 2026-11-15

## Behavior

- Markdown tables, checklists and code blocks; KaTeX inline/block formulas with `$…$`, `$$…$$`, `\(…\)` and `\[…\]`. Code and link destinations remain literal. Unfinished streaming formulas remain text until complete. Formula assets are bundled locally and loaded with the Markdown renderer.
- Reply and code copy buttons show a check and “Copied/已复制” for 2.5 seconds after a successful clipboard write, or “Copy failed/复制失败” on rejection. Copies preserve the source Markdown, LaTeX and code.
- Multi-file selection, drop and image paste use assistant-ui's attachment adapter. Originals of any type can be uploaded, up to 32 files per message and 100 MiB per file. Ready drafts survive reload; removal persists; sent files remain downloadable. Uploading/failed files cannot be submitted. Files can be sent without text.
- Router reads text and images with `router_read`; a Worker processes binary documents with existing task tools. The host makes exact task-owned, read-only copies available to its managed sandbox and declares matching native model permissions. Private state and credentials remain denied.
- Files follow built-in Chat ownership and cleanup. Reset clears originals, drafts and task copies. External entries and their files are outside this change. Upload success does not imply every format can be understood: document interpretation depends on model capability and available task tools. Images above the 8 MiB visual-tool limit remain available as original files.

## Browser verification

`examples/chat-files-acceptance.ts` runs a separate host/account. Default mode supplies an explicitly labeled model fixture for deterministic UI checks; it is not native model evidence.

Observed through the in-app browser:

- Multi-selection of Markdown, DOCX and WebP, preview and removal; a reload retains the text draft and remaining files.
- A sent attachment downloads byte-for-byte equal to its source. A restored ZIP draft can be removed and stays removed after another reload.
- Pasting a PNG creates an attachment; sending it with an empty composer produces a file-only message and a completed response.
- A 26 MiB file shows its size error. Review discovered that incomplete attachments could originally enter sending; the final implementation keeps the error visible and disables Send, including keyboard submission through the same runtime gate.
- Inline formulas, a quadratic formula, matrix, formulas inside a table, checkboxes and a literal code fence render correctly. Twelve KaTeX nodes across two replies, no math errors. At 390 × 844 the document has no horizontal overflow. Light/dark themes and desktop layout were inspected.
- Clicking reply copy and code copy visibly shows “Copied”; clipboard reads verify raw formula delimiters and exact code. The message footer retains time, completed status and copy together. Browser console has no errors in this flow.
- A local HTTP proxy injected a 503 on the view refresh immediately after successful message admission. The final browser displayed “Message sent. Refresh to see the latest replies.” with an empty composer and zero draft attachments; the admitted message remained in the transcript. This verifies that a refresh failure does not restore a sent file as an unsent draft.

Local screenshots and detailed test/model receipts are under ignored `.local/chat-files/`; no account cookies, host credentials or private state are committed.

## Native autonomous task

The same example in `native` mode uses the signed-in Codex CLI, a `gpt-6.1-terra` Router, and `gpt-6.1-sol` Workers. Network is disabled; the managed command sandbox is enabled. Six synthetic originals were submitted through the authenticated Chat HTTP API: CSV, XLSX, DOCX, PDF, ZIP and WebP. This is real runtime/model acceptance, separate from browser submission evidence above.

One user request, without specifying roles or implementation steps:

> 帮我核对这几份销售材料，找出不一致的地方，算一下正确总额，再给我一个简洁表格和计算公式；图片里是什么也顺便看一眼。

The first run exposed conflicting file-permission descriptions: the managed command sandbox allowed the task attachment, while native model permissions denied its enclosing state directory. The Worker stopped to ask for readable Office/ZIP material. Exact task attachment paths now receive the same read-only allowance in both places; other private files remain denied. A fresh run used the identical task and files, with no intervention during execution.

Observed final run: `799ade71-bfea-496d-a628-fee4cfc289fc`, Worker task `797a15f5e0a813b7e16a8c7100228f17`. Router selected one Worker, Atlas. It read all six files, identified the DOCX claim of 390 versus the correct 380, supplied a comparison table and Excel formula, and described the R-shaped avatar. Four managed shell jobs completed with exit code 0; the verification job independently recalculated CSV/XLSX totals with Decimal and checked fields and ZIP contents. Router returned the consolidated answer; run and task both completed, with no clarification request in the successful run.

## Regression coverage

Tests cover authenticated upload/download, same-origin mutations, owner/conversation isolation, safe raster previews versus SVG downloads, paginated Router reads and image input, Worker original-byte copies and exact native permission declarations, idempotent file-only messages, failed admission preserving drafts, simultaneous upload limits, interrupted uploads, cancellation, restart, and reset during active uploads without resurrection. Formula tests protect code, links, escapes and incomplete expressions and verify display/table parsing.

`npm run check`: 98 test files passed, 1489 tests passed and 1 skipped. Backend, Chat and workspace-view type checks and the production build passed. The final UI review additionally separates successful message admission from a subsequent view-refresh failure and removes acknowledged attachments from a restored draft, preventing a completed send from being offered again as an unsent file.

The dependency graph resolves KaTeX to 0.19.1, including transitive remark/rehype users; installation audit reported no vulnerabilities. The UI source detector reported no findings.
