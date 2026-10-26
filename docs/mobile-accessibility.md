# Mobile interface v3

The Google-backed interface is redesigned for phones; inventory rules, Google RPCs, account permissions, local draft keys and pending-operation recovery are unchanged. This update requires only the **Deploy Google-mode PWA** GitHub Actions workflow, not an Apps Script installer or a new Google deployment. After a successful deployment, reopen online and reload after the service worker activates. The footer identifies **Mobile interface v3**. Do not clear site storage or uninstall to get an update: that can erase unsent drafts.

## Everyday use

- **Sign in once per connected visit.** The connection form collapses after sign-in. The deployment URL remains saved and can be expanded under Google connection settings. Reopened saved inventory offers a short Sign in to synchronize action instead of placing a large login form above stock. Credentials are still memory-only.
- **Navigate with your thumb.** Six labeled/icon navigation buttons stay at the bottom on phones, including iPhone safe-area spacing. They become a sticky horizontal menu on larger screens. The selected section is identified by text, shape, and `aria-current`, not color alone.
- **See stock at a glance.** Active/low/check-due summaries, clearer balances, text badges, search-result counts and empty states distinguish unknown quantities from zero. The connection badge and expandable synchronization details distinguish saved device data, offline mode, read-only mode and a connected session.
- **Count without losing your place.** Quantity controls use decimal keypads and larger numerals. Storage zones are grouped by product with a screen-reader legend. Progress counts items with all required zone fields entered; it is not proof that the quantities are valid. Local errors are explained beside fields and associated programmatically. Zero counts as an entry; blanks remain blanks. The submit bar stays above navigation, while blank/incomplete choices remain in the finishing section. No automatic submissions were added.
- **Use accessible forms.** Dialogs have names/instructions, required-field markers, visible error summaries within the modal, and sticky Save/Cancel controls. Keyboard focus starts in the form, returns to its opener on cancel, or moves to the current section heading if the old opener was replaced. Escape closes a form; it does not cancel a write already sent. Pending operations remain recoverable through Retry safely.

## Accessibility choices

Native buttons, labels, fieldsets, progress and dialogs preserve keyboard and assistive-technology semantics. Navigation uses normal buttons, not an incomplete custom ARIA tab widget. A skip link, visible focus outlines, focus-on-section-change, contextual quantity labels and polite local status messages support non-pointer use. Identical per-keystroke save messages are not repeatedly rewritten into a live region.

Touch controls are designed around 48px heights (navigation at least 44px wide at 320px). Inputs use at least 16px type to avoid automatic iOS focus zoom. Text, outlines and status labels have intentional contrast. The viewport does not disable pinch zoom. Layout is tested at 320px and with 200% CSS zoom, and styles respect reduced-motion and forced-color preferences. Pending-write and permission gates are unchanged; visual conveniences do not bypass validation.

## Verification and remaining manual checks

Playwright exercises the original workflows and the new layout using desktop, Samsung-sized and iPhone-sized **Chromium** profiles. `@axe-core/playwright` scans sign-in, the six sections, counting and representative dialogs against WCAG A/AA rules. Tests also check focus return and modal errors, minimum navigation targets, progress/zero/invalid quantities, small-screen overflow, zoom, and offline draft recovery. These checks are not a WCAG conformance certification and do not emulate actual Safari or screen readers.

Before broad staff rollout, use a test workbook and check:

1. iPhone Safari and the installed PWA: VoiceOver reading order, modal focus, landscape, large text, home-indicator spacing, and whether the real keyboard leaves the focused zone field and form buttons usable.
2. Samsung Chrome/Samsung Internet: TalkBack, large system text, decimal keypad and Back/Escape behavior.
3. Several long Cyrillic/English names, many zones, empty lists and a realistic full catalog. Ensure nothing is clipped at high zoom.
4. Offline reopen, local count editing/clearing, reconnect, conflict review and safe retry. Confirm that changing sections or closing a modal never sends a count.

No live spreadsheet or notification settings are changed by UI tests; browser integration tests use a simulated Google bridge.
