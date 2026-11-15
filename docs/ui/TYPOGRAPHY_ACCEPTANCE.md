# Workspace typography

The shared type scale is defined in `src/ui/typography.css` and documented in `docs/DESIGN.md`. Page headings use 28px on desktop and 24px at window widths up to 800px. Form labels, buttons and page tabs use 14px; inputs use 14px on desktop and 16px on narrow windows.

Behavior rules now uses these roles in place of its previous 40px heading, 26px field labels and 20px controls. Field spacing and action padding are reduced accordingly. Agent team, model settings, task views, conversation entries, automations, plugin management, account screens and the public guide use the same UI roles. The packaged Agent board follows the host window's typography breakpoint through the optional environment field `compactTypography`.

## Verification

- 45 browser checks cover 13 workspace routes plus account and public-guide pages at 1440px, 390px and 320px, including Chinese, English, light and dark themes.
- Computed page headings are 28px / 24px. Behavior-rule controls are 14px and narrow-screen inputs are 16px. The document has no horizontal overflow in those checks.
- Rule drafts survive keyboard tab navigation. Preview opens and closes normally, with an 18px title and readable inputs. Team settings use the same input scale.
- A 720 CSS-pixel viewport at 2x density checks the layout corresponding to a 1440px window at 200% zoom.
- The rebuilt Agent board is checked in its sandboxed iframe, including the host-window breakpoint and navigation width.
- Type checking, the Chat build and 37 related tests pass. The browser reports no page errors.

The typography detector reports existing content-specific font sizes and existing font stacks against the older design reference. These include Markdown, code, diagram annotations, brand lettering and status metadata; none introduces a new large UI heading. The current shared UI scale is recorded in the updated design reference.

Local browser reports, screenshots and build logs are in `.local/typography/`.
