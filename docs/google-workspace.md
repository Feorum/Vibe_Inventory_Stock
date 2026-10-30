# VARKA workspace · Google Sheets deployment

The main Google PWA now has **Stock, Catalog, Team, and Profile**. Counting is always available; no session must be started. This implementation targets the currently used Google-backed application, not the separate Node/SQLite application. It adds no hosting service or third-party proxy.

## Fixing `ParseError: Unexpected token ILLEGAL` at line 383

The first Workspace release contained an integer-literal syntax that the Apps Script parser rejects. Node-based tests accepted that syntax, so they did not reveal the platform-specific save failure. The corrected `Workspace.gs` uses exact scaled decimal-text arithmetic instead, without relying on an arbitrary-precision integer runtime. Browser and Node arithmetic are unchanged.

Replace the **entire contents of the existing Workspace script file** with the current repository `apps-script/Workspace.gs`. If your editor calls the file `Workspace.gs.gs`, that is still the file to replace: do not leave the old source in place and add a second copy. Save the project, finish `installWorkspace` if the error prevented initial setup, and deploy **New version** of the existing web deployment. An already-completed migration does not need to be repeated. This correction changes no spreadsheet schema or existing data and needs no Pages frontend update.

Regression tests now reject the incompatible syntax across every repository `.gs` file, execute the workspace backend with the integer constructor unavailable, and verify exact decimal sums, zero, whole pieces, the maximum, overflow, and large values beyond the safe-integer boundary. These checks do not substitute for saving the source in your actual Apps Script editor.

## Upgrade safely

Use a **test copy of the workbook and its existing Apps Script project first**. Nobody running these repository tests has access to your live Google deployment, private credentials, or Telegram chat.

1. Keep the original five Apps Script files, existing authentication properties, and existing `doGet` bridge hook. Confirm `STOCK_SHEET_ID` targets your intended **copy**, not the original workbook.
2. Update `PwaBridge.gs`. Add the repository files `Workspace.gs` and `WorkspaceNotifications.gs` as separate Apps Script files. Keep `PwaBridge.html` and all original source files. Never paste these files over the original inventory code.
3. From the editor, as owner, run **`installWorkspace`** once and authorize it. It validates the existing schema, copies the whole workbook before migration, and creates three additive tables. Re-running validates/reuses the tables; it does not replace existing rows. The backup ID is in private Script Property `WORKSPACE_BACKUP_ID`.
4. Keep `PWA_ORIGIN` set to the exact HTTPS Pages origin, for example `https://feorum.github.io` (no repository path or trailing slash). Keep the existing individual access settings. Set `PWA_WRITES_ENABLED=true` only on the intended test database when ready to test writes.
5. Apps Script: **Deploy → Manage deployments → Edit → New version → Deploy**. Keep the same `/exec` URL and existing execute-as-owner/access configuration. Saving source alone does not update an existing deployment.
6. Publish the frontend: GitHub **Actions → Deploy Google-mode PWA → Run workflow** on the branch containing this update. This workflow remains manual; a source push alone does not publish Pages.
7. Reopen the installed PWA online, reload after the new service worker activates, and sign in. Username is your existing authorized **email**; Password is your existing **individual VARKA access code**, not your Google account password. No new password is created or stored in Sheets. The app waits for the complete initial workspace load before showing the usable interface.
8. Test the checklist below on the copy. Do not switch production staff until concurrent counts, offline recovery, and notification behavior are confirmed.

Existing session drafts/pending requests are **not silently converted or deleted**. Open `legacy.html` on the same Pages origin/device to finish them or use the [zone-recovery procedure](google-mode.md#fixing-a-pending-zones_changed-count-interface-v31). A new session-free draft has a different storage namespace. Do not recreate an uncertain old submission in the new app until its old outcome is resolved.

## Scheduled Telegram reminders

The existing private properties `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` are reused. They are never sent to the frontend. Do not paste their values into GitHub, screenshots, or chat.

After the workspace migration, run **`installWorkspaceReminders`** from the editor as owner. It installs one hourly `workspaceReminderTick_` trigger, and does not delete or modify other triggers. Profile shows whether this handler is configured. Apps Script only exposes triggers owned by the executing account: install it as the same owner that executes the web deployment. The optional editor-run `workspaceReminderTick` wrapper is owner-only; it can send real due reminders, so do not run it as a harmless diagnostic.

Set `WORKSPACE_REMINDER_LANGUAGE` to `ru` or `en` (default `en`). Dates use existing `CAFE_TIMEZONE`, default `Europe/Minsk`. The trigger requires `PWA_WRITES_ENABLED=true` and valid Telegram credentials. Catalog intervals have explicit units and Off. Because the scheduler runs hourly, a reminder can arrive up to approximately an hour after its deadline, plus Google's scheduling delay.

A deadline starts from the last **successful recount**, even if the quantity is unchanged. Catalog edits, deliveries, refreshes, and visits do not reset it. Off and inactive products are excluded. Never-counted products have no recount timestamp and therefore no invented deadline. One confirmed/ambiguous alert is recorded per product and successful recount identity; only a new recount makes another alert eligible. Known rejected deliveries may retry; an ambiguous send does not repeat automatically. Forecasting, median consumption, and automatic interval estimation are not implemented.

Review the original project's legacy scheduled **`refreshAndAlert_`** (or older `refreshAndAlert`) trigger before enabling production reminders. It implements the old overdue/threshold report rules, not the new Off/manual-Low rules. After checking which reports you still need, disable that specific legacy timer if using the new scheduler, to avoid duplicate/inconsistent automatic alerts. Do not delete form-submission triggers or unrelated integrations. The installer deliberately does not make this operational choice for you.

## Data and synchronization design

| Layer                                                       | Responsibility                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `google-pwa/workspace.js`, `workspace.css`, `locales.js`    | Four-page mobile interface, complete English/Russian UI, explicit refresh and submission, online mutations       |
| `google-pwa/workspace-model.js`                             | Pure draft/decimal/filter/snapshot/acknowledgment rules; no credentials                                          |
| `google-pwa/transport.js`, `PwaBridge.html`, `PwaBridge.gs` | Pinned Google iframe transport and explicit method allowlist; no public spreadsheet or credential URLs           |
| `apps-script/Workspace.gs`                                  | Existing authentication/schema adapters, separate revisions, locked catalog/count writes, durable request replay |
| `apps-script/WorkspaceNotifications.gs`                     | Localized immutable reports, separately tracked Telegram message chunks, fixed-interval scheduled reminders      |

The original `Products`, `Events`, `UserProfiles`, `Reminders` (shared notes), and `YellowCards` remain authoritative. Existing IDs, cards, profiles, events, and integrations are retained. New catalog deletions are tombstones, not physical removal of history. New counts use native readable event envelopes. The migration adds:

| Table                     | Purpose                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `WorkspaceOperations`     | Actor/kind/request digest and durable operation plans/results                   |
| `WorkspaceOperationParts` | Segmented immutable operation JSON, avoiding a single Sheets-cell catalog limit |
| `WorkspaceReminders`      | Per-product/recount reminder outcome and operation reference                    |

No SQLite migration is needed for Google mode. The independent Node application remains runnable with `npm ci && npm start`; it has not been changed to use these new Google workspace endpoints.

### Counting and conflicts

The existing per-location model is retained: enter every assigned zone for a counted product; the sum is its café-wide total. No zones means one explicitly unassigned total input. Empty means **uncounted**, and zero is valid. Approximate and manual Low are independent; flags without quantities do not create a recount or refresh its timestamp. Piece counts must be whole numbers. Inputs accept comma or dot decimals. Google Sheets' numeric precision remains a limit: quantities that cannot round-trip safely through the native ledger are rejected instead of silently rounded.

Drafts include the original stock and count-specification versions, an edit version, zone values, and flags. They are scoped by **deployment URL + server-returned workbook ID + authenticated email**. A refresh replaces only the loaded database snapshot, never drafts or pending requests. Language changes, filters, navigation, reloads, and temporary offline use do not submit anything. Header synchronization is a read; only **Synchronize quantity → Send** submits quantities.

Stock revisions are separate from catalog revisions. A name/category/minimum/interval edit may coexist with a stock submission. Concurrent stock changes conflict; unit/location/status changes also require explicit review. Deleted products remain in saved drafts for resolution, and a stale client cannot recreate a tombstoned ID. Acknowledgment clears only accepted entries whose edit versions still match. Newer local edits remain and advance only from their own confirmed predecessor, never from an unrelated remote count.

Requests are persisted locally **before** sending and bound server-side to actor, kind, and SHA-256 digest. A retry uses the same exact body/ID. Durable plans can reconcile interrupted known writes; stale uncommitted work becomes a conflict instead of overwriting someone else's changes. Per-item accepted, failed, and conflicted outcomes are shown. Google Sheets is not an ACID multi-table database: very large submissions may use several ledger envelopes; acknowledged results are per item, not a promise of all-catalog atomicity.

The shared-lock guarantee covers writers in this **same Apps Script project**. Separate projects, direct spreadsheet edits, and old external clients can bypass these safeguards; do not run unsynchronized writers against the same workbook. Stop edits during migration and test the legacy writers you intend to retain.

### Telegram is a separate outcome

The confirmation dialog covers the **entire loaded catalog**, independent of search and filters. All valid pending quantity entries are saved regardless of notification scope:

- **Entire list:** every catalog product, including labeled inactive products.
- **Only entered items:** successfully recounted items in this submission.
- **Only items marked Low:** IDs with the manual Low flag in the frozen confirmation snapshot.

Reports distinguish fresh accepted recounts from previously recorded quantities and unknown quantities. The request freezes the complete report projection at Send time, including uncounted products and their previous values. The server validates stable IDs (including existing tombstones), text/number bounds, and flags; accepted recounts override that projection with confirmed results. Report-only previous quantities never write inventory. Products added after Send cannot silently expand that report. Inventory commits before any Telegram HTTP request. A notification failure never rolls back saved inventory.

Each message chunk is marked uncertain **before** sending, because Telegram does not provide an idempotency key. A confirmed `SENT` chunk is not sent again. A definite `FAILED` result permits notification-only retry. `UNKNOWN` means the chat may already contain the message; it is not success or proof of failure and is not automatically retried. Check the chat/owner logs instead of resubmitting the stock under another ID. Multipart retries skip acknowledged chunks. Missing credentials are reported separately.

### Offline and privacy

The service worker caches only same-origin static assets; Google RPC, credentials, and tokens are not cached. Passwords and tokens stay in memory and are cleared on logout/reload. Existing private Script Properties retain the original access-code mechanism; no plaintext password is added to Sheets or browser storage.

On trusted devices, locally saved inventory/drafts can be reopened offline without pretending to reauthenticate. Online mutations require a fresh server login. This is not encrypted offline identity verification: anyone with browser/device storage access can read cached shop data. Logout hides the workspace; saved account-scoped drafts are retained for deliberate recovery. Browser storage may be evicted and is not a backup. There is no background stock submission, cross-device offline sync, or guarantee that an unvisited device has offline data.

## Specification and verification map

| Requirements                   | Implementation / verification                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · inspect/preserve           | Existing five source files, authentication, native event/schema projection, card identifiers, and Telegram properties reviewed; additive migration and backup             |
| 2–3 · four pages/login/loading | Main workspace has four pages and global forced read; server email/access-code authentication, localized errors, full initial load and retry                              |
| 4–7 · stock/drafts/submission  | Complete combined filters, per-zone counts, independent flags, explicit inactive states, local versioned drafts, full-catalog confirmation and separate Telegram delivery |
| 8 · catalog                    | Add/edit/status/delete with versions, tombstones, validated fields, explicit confirmation, retained form input on failed saves                                            |
| 9 · reminders                  | Off/fixed intervals, owner-installed hourly trigger, recount-based deduplication; no forecasting claims                                                                   |
| 10 · Team/Profile              | Existing shared notes/cards schemas, A/C/D grouping and database codes, real account information, language/logout                                                         |
| 11 · language                  | Separate RU/EN dictionaries and localized system reports; user-entered text is not translated                                                                             |
| 12 · concurrency               | Separate catalog/count-spec/stock versions, shared locking, actor/body-bound IDs, partial outcomes, acknowledged-edit protection, independent notification journal        |
| 13 · mobile                    | Responsive 320px layout, numeric keyboards, visible actions alongside gestures, focus/dialog behavior, minimum 44px targets, offline/status messaging                     |
| 14–15 · verification           | Node model/backend tests plus browser workflow tests use isolated in-memory data; retained legacy/native regression suites remain runnable                                |

Run `npm test`, `npm run build:google`, and `npm run test:e2e`. Server tests use an in-memory workbook emulator with the native ledger schema; browser tests simulate the Google iframe against a safe in-memory backend. No test changes your live workbook or sends a real Telegram message.

Verified on 30 October 2026: **126/126 backend/model/translation tests**, **117/117 browser regressions** across desktop, Samsung-size, and iPhone-size Chromium. After the final client acknowledgment/minimum-validation changes, the **45/45 workspace browser checks** were rerun successfully. Static staging, JavaScript syntax checks, and `git diff --check` also passed. Backend tests include a 360-product dataset and interrupted multi-envelope writes; browser checks cover 320px reflow and automated accessibility audits.

**Still requiring external acceptance:** run the migration on the copied Google workbook; deploy Apps Script and Pages; verify actual Google authorization/embedding, Apps Script quotas/trigger ownership, and a dedicated Telegram test chat. Test Samsung Internet/Chrome and physical iPhone Safari/Home Screen, including the on-screen keyboard, screen reader, offline reopen, and interrupted writes. Chromium phone-size emulation and automated accessibility checks are not evidence of native Safari/real-device validation.

Before production, use two authorized accounts on the test copy: submit conflicting counts, concurrently rename and count a product, deactivate/delete while another draft is open, retry a lost reply, and reject a Telegram send after a successful inventory save. Confirm a same-quantity recount advances the reminder timestamp and the next scheduled reminder only fires once. Resolve all old pending operations before final cutover.
