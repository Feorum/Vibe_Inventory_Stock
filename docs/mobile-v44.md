# Mobile counting verification · Workspace v4.4

The screenshots below use the same isolated three-product fixture, Russian interface, fixed browser time, and viewport height. They are not images of the private café database. They show the implementation before and after this revision, not visual mockups.

| CSS width | Before                                           | After                                          |
| --------- | ------------------------------------------------ | ---------------------------------------------- |
| 360px     | [Before](../artifacts/mobile-v44/before-360.png) | [After](../artifacts/mobile-v44/after-360.png) |
| 390px     | [Before](../artifacts/mobile-v44/before-390.png) | [After](../artifacts/mobile-v44/after-390.png) |
| 430px     | [Before](../artifacts/mobile-v44/before-430.png) | [After](../artifacts/mobile-v44/after-430.png) |

The old screen repeats a server-saved message on empty cards and duplicates the draft progress counter. The revised screen uses full-column inputs, shows no success state for untouched cards, labels local draft/partial states accurately, and keeps the main current-draft counter beside Save. Product dates are historical server count dates, not local edit times.

The revised default sorts by product name, so the same three products appear in a different order. Images capture the immediate post-login state: the fresh database-refresh notice is dismissible and expires after 10 seconds in the revised app, whereas the old notice remains. The comparison does not hide that new temporary notice before capture.

Additional examples: [390px with enlarged text](../artifacts/mobile-v44/after-390-large-text.png), [entered draft](../artifacts/mobile-v44/after-390-draft.png), and [reduced viewport for keyboard clearance](../artifacts/mobile-v44/after-390-keyboard.png). The last image simulates viewport loss; it is not evidence of a real hardware keyboard or physical-phone test.

## Capture procedure

The opt-in screenshot workflow is in `test/e2e/workspace.spec.js`. Run it on an unmodified pre-change checkout for the before images and on the new revision for after images:

```sh
VARKA_CAPTURE_PHASE=before npx playwright test test/e2e/workspace.spec.js --project=desktop --grep "capture"
VARKA_CAPTURE_PHASE=after npx playwright test test/e2e/workspace.spec.js --project=desktop --grep "capture"
```

The fixture fixes the browser clock to 3 November 2026 and mocks only the Apps Script transport. Actual application rendering, numeric input, storage, and synchronization UI are used. Capture paths are outside the ignored Playwright results folder so normal test reruns do not delete the comparison images. Do not overwrite the baseline images using the revised UI.

## Date behavior and limitations

- The configured café timezone comes from `Workspace.gs` as `timeZone`; the existing default is `Europe/Minsk`.
- Today and Yesterday mean café calendar dates. Overdue day counts compare calendar days, including across daylight-saving boundaries.
- Custom range dates are inclusive. Missing dates, impossible dates, or start-after-end fail validation without discarding the form or drafts.
- Unknown historical timestamps are never treated as recent. They appear in Never counted and All dates, not a fabricated age bucket.
- Sorting oldest-first places unknown dates first; name and stable ID break ties.
- The current database exposes a product-level successful `CAFE CHECK` date. Zone values exist, but independent saved count dates for each location do not. Location selection filters products; it does not imply a location-specific count date. The Filters panel explains this.
- Draft edits, metadata edits, reads, and Telegram sends do not update historical count dates. Only accepted recount results do.

## Acceptance still needed

Verified for this revision: **164/164 Node backend/model/translation tests**, **177/177 browser regressions** across desktop, Samsung-size, and iPhone-size Chromium, and **13/13 targeted layout/scroll/notice checks** after the final single-location-field and dismiss-button refinements. The normal full suite intentionally skips three opt-in screenshot cases; the screenshot workflow ran separately and produced all comparison images. Static Pages staging, JavaScript syntax checks, and `git diff --check` also passed. No test wrote to a live workbook or sent an actual Telegram message.

Automated mobile checks use Chromium emulation and a reduced viewport to exercise keyboard clearance; they do not open a physical phone keyboard. Test the deployed app in Samsung Internet/Chrome and iPhone Safari/Home Screen, including device text enlargement, numeric Next behavior, screen-reader disclosures, safe areas, offline reopening, and a live submission on a copied workbook. Google authorization, quotas, deployment configuration, and real Telegram delivery are not verified by these isolated tests.
