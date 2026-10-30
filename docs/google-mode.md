# Temporary Google Sheets mode

This is the Google-backed application: **GitHub Pages → Apps Script bridge → the existing private VARKA workbook**. No Node server, Google API key, service-account key, or public spreadsheet is required. The Node/SQLite application remains unchanged.

Implemented: existing individual sign-in; stock/low/estimated/stale indicators; deliveries and waste with a reason; catalog creation/editing, units/packaging, minimums, intervals, zones, activation/deactivation and archival; session start/resume/expansion; per-zone and sleeve counts; explicit keep-blank/incomplete policies; atomic staged status/zone changes with counts; paginated immutable history and own-entry corrections (history-only or current-stock); reminders, yellow cards, display names; and owner-only Telegram report settings. Feature-screen navigation and forms have EN/RU labels (Profile switches language); some shared connection/count/status text remains bilingual or English.

Offline: the app shell, inventory/catalog, and previously opened history/information/profile snapshots remain on each device; an open session's count drafts and staged checklist changes can be edited locally. Other stock/catalog/team-information mutations require a connection. “Synchronization” means reading/writing the **same workbook**, not maintaining a second SQLite copy. Access-code administration remains in private Script Properties, as in the original application. Historical pilot-specific hardcoded imports, catalog cleanup installers, Google Forms and trigger administration are deliberately not exposed as everyday PWA actions.

## Updating the working prototype

### Fixing a pending `ZONES_CHANGED` count (interface v3.1)

Do not clear site storage, reinstall, change zones back merely to bypass validation, or recreate the count on another device. The old browser request and original quantities must remain available.

1. Replace **only `PwaBridge.gs`** in the same Apps Script project with the current repository version. Keep the original five files, `PwaBridge.html`, `doGet`, spreadsheet ID and individual access codes unchanged. This patch needs **no installer or new Script Property**.
2. **Deploy → Manage deployments → Edit → New version → Deploy**. Keep the same `/exec` deployment URL. Merely saving the file does not update that URL.
3. Run GitHub **Actions → Deploy Google-mode PWA** on `main`. Reopen online and reload after service-worker activation; the footer must say **Mobile interface v3.1**. Sign in again to load the new recovery capability. Unsent counts keep their existing localStorage keys.
4. In the pending panel, optionally choose **Download saved count backup** and keep that private file on a trusted device. Then choose **Recover count with current zones** and read the confirmation.
5. The server first checks the exact old request under the legacy script lock. A committed count is confirmed without another write. Otherwise an owned OPEN checklist is closed as REPLACED and a fresh checklist is started. Closing the old checklist prevents its delayed submission from committing afterward. **No stock events or notifications are created by this recovery.**
6. In the recovered draft, review the listed products. Original values, including removed zones, remain in a device-local archive. Matching zones retain their inputs; added zones remain blank. Different units/packaging do not inherit old numeric inputs. Physically recheck every current zone of each flagged product (including zero where empty), then choose **I rechecked every current zone — use these values**. Older count timestamps also require a fresh physical check. Inactive products can explicitly be kept in the backup only. Staged catalog changes are archived rather than silently reapplied; review/restage them in Catalog if still wanted.
7. Submit only after the review is complete. The normal stock/catalog revision checks still apply. Original backups remain downloadable from Profile even after successful submission.

If recovery itself loses a reply or is interrupted, **Retry safely** resumes the same recovery ID. The append-only CLOSE/START journal records are repaired idempotently; it does not open duplicate sessions or discard drafts. If the old count has an unconfirmed/corrupt envelope, or the session was closed elsewhere, recovery stops for owner inspection instead of assuming rollback. If device storage is full, the client keeps its original pending data until the recovered candidate can be saved; free space without deleting app data, then retry. Recovery archives are not encrypted and remain scoped to that device/account/deployment. Download them before clearing browser data. Recovery does not import backups automatically or convert an old physical count into a fresh one without review.

The shared-lock guarantee applies to writers in this same Apps Script project. Separate projects writing to the same workbook do not share a script lock; stop such parallel writers before recovery. Manual spreadsheet edits can also bypass the application's validation and audit rules.

### Earlier prototype and interface updates

If your full-featured Google app already works and you only need the **v3 visual redesign**, rerun the Pages workflow and reload online. The **v3.1 count-recovery fix does require the updated bridge deployment above**, but no installer. See the [mobile interface guide](mobile-accessibility.md). The steps below are for upgrading the older, count-only prototype to the full workflows.

Do this on your **test copy** first:

1. Back up the copied spreadsheet and current Apps Script source. Confirm `STOCK_SHEET_ID` still targets that copy.
2. Replace **only `PwaBridge.gs`** with the current repository version. The original five files, `Inventory.html`, `PwaBridge.html`, and the existing `doGet` bridge hook stay in place.
3. From the Apps Script editor, run **`installPwaFeatures`** as owner. It backs up the workbook before creating the `PwaOperations` journal. It does not create triggers, import counts, change products, or enable Telegram. Re-running it validates an already-installed journal without replacing its rows.
4. **Deploy → Manage deployments → Edit → New version → Deploy**. Keep the existing `/exec` URL and access settings.
5. On GitHub, run **Actions → Deploy Google-mode PWA** again. Reload the installed app after deployment so the current service-worker shell can activate; sign in again. An older bridge leaves the new write actions disabled and shows an update notice.
6. With `PWA_WRITES_ENABLED=true` on the copy, test each screen. Disable reports in the owner's settings if you do not want test submissions to send real notifications. No credentials should be pasted into GitHub or chat.

Fresh installations need step 3 after adding the bridge below, before using the new workflows.

## 1. Publish the static phone interface

The workflow is intentionally **manual**, so pushing code does not publish anything automatically.

1. In GitHub, open **Feorum/Vibe_Inventory_Stock → Settings → Pages**. Under Build and deployment, choose **GitHub Actions**. Pages availability for private repositories depends on your GitHub plan; a public repository exposes application source, not the private workbook. Do not change repository visibility just to enable Pages without reviewing that choice.
2. Open **Actions → Deploy Google-mode PWA → Run workflow → main**.
3. Wait for success and use the URL shown in the deployment. The expected default address is `https://feorum.github.io/Vibe_Inventory_Stock/`; use GitHub's actual displayed address if different.

Only the explicitly staged static interface and icons are uploaded. No database, export, `.env`, Apps Script source, or credential is included. Relative URLs, the manifest, and service-worker scope work under the repository subdirectory. No npm dependency install is needed to build the static files (`npm run build:google`). The frontend deployment URL is entered on the device, not committed into source.

## 2. Add the bridge in your Google account

First make a backup of the spreadsheet **and the current Apps Script source**. Prefer a test copy of the entire workbook/project. A bound-project copy may retain a Script Property pointing at the original spreadsheet: verify its spreadsheet-ID configuration before enabling writes. Keep the five existing script files and `Inventory.html`; do **not** paste these files over them or run the old installation/migration functions again.

In your existing project (`1TNO2gYfAf2aLSnv73_ICn8ekRDu6cw6Fv_bX8BUe1whpxdTAXocnoqra`):

1. Add a Script file named **PwaBridge** using [`apps-script/PwaBridge.gs`](../apps-script/PwaBridge.gs).
2. Add an HTML file named **PwaBridge** using [`apps-script/PwaBridge.html`](../apps-script/PwaBridge.html).
3. Find the **existing** `doGet` in `Код.gs`. Change it to this; keep exactly one `doGet` in the project:

   ```javascript
   function doGet(e) {
     if (e && e.parameter && e.parameter.pwa === "bridge") return pwaPage_(e);
     return HtmlService.createHtmlOutputFromFile("Inventory")
       .setTitle("VARKA Stock")
       .addMetaTag("viewport", "width=device-width, initial-scale=1");
   }
   ```

4. In **Project Settings → Script Properties**, add:

   | Property             | Initial value                                                                  |
   | -------------------- | ------------------------------------------------------------------------------ |
   | `PWA_ORIGIN`         | `https://feorum.github.io` (origin only: no repository path or trailing slash) |
   | `PWA_WRITES_ENABLED` | `false`                                                                        |

   Keep existing authentication, allowed-email, spreadsheet-ID, and version properties. Do not copy codes/tokens into a sheet, public source, URL, screenshot, or chat. The bridge uses existing `webLogin`, so current individual codes and allowed users apply. The original source requires codes of at least 32 characters; Node account codes are separate and do not authenticate here.

5. **Deploy → New deployment → Web app**. Execute as **Me**; access **Anyone**, if your Workspace policy permits it. This makes the authenticated web-app entry point accessible, **not the spreadsheet**. Inventory RPCs still require a VARKA session token. Google service authorization is granted in Google's own owner dialog. Never enter your Google password into the PWA.
6. Copy the deployed **`https://script.google.com/macros/s/…/exec`** URL, not the editor URL or `/dev` URL. Paste it into the PWA, enter your existing staff email/code, and sign in.

The original project must already have the supplied v4–v11 implementation installed and functioning: this bridge is not a new empty Apps Script project and is not a replacement installer. Deploying a new version of an existing deployment requires **Manage deployments → Edit → New version → Deploy**; saving source alone does not update `/exec`.

## 3. Read-only acceptance test, then enable writes

First verify product IDs, units, balances, and staff access with `PWA_WRITES_ENABLED=false`. A read-only refresh requests `suspendExpansion:true` so it does not expand session journals. The switch limits **this bridge** only; it does not disable the original UI, forms, triggers, or other project RPCs.

Then, preferably in your test copy:

1. Set `PWA_WRITES_ENABLED=true` and sign in again so the PWA reloads capabilities.
2. Start a session online. Enter a test count with every required zone; blank fields are not zero. Explicitly choose **Keep blank items unchanged** for a partial checklist.
3. Put the phone offline. Edit counts, close/reopen the installed app, and verify that drafts survive. The device must have completed an online visit and service-worker installation first.
4. Reconnect and sign in. Refresh, review changed products, and choose **Synchronize counts**. Verify the single batch and final quantity in the original application/workbook.
5. Test a conflicting count on a second device. Neither refresh nor reconnect silently rebases an offline absolute count.
6. If a reply is lost, choose **Retry safely**. The PWA checks the original submission ID before retrying the identical stored body. Do not manually recreate the same count in another app/device while its outcome is unknown.

**Existing post-commit side effects remain in force.** The original `webV5Submit` can rebuild dashboards and deliver Telegram reports according to your current settings. Disable reports through the original owner's settings for a notification-free test; no setting is silently changed by the bridge. Starting a session appends a journal entry even without submitting counts.

### Additional workflow acceptance tests

- Record a delivery and waste for a known product; verify the source Events rows, author, final balance and waste reason. Unknown stock must be physically counted first; overdraw and stale revisions must be rejected.
- Create/edit a test product, set zones/minimum/interval, deactivate then archive it. Existing categories are reused; historical unit changes remain blocked by the original backend.
- Resume an owned open session through Sessions. Add newly active products using the explicit expansion action. Stage status/zones in Catalog and return to Stock & count: a newly activated product requires a count, and every selected zone must be filled. Count submission carries those catalog changes in the same original v9 envelope.
- Open History; correct your own entry first in HISTORY_ONLY mode and verify current stock did not change. CURRENT mode must reject newer intervening movements. Original entries remain unchanged and correction revisions are displayed separately.
- Add/edit/complete a reminder, add/remove a yellow card, and change your display name. Confirm attribution and stale-version behavior.
- Only the effective script owner's account should see Telegram report settings. Staff cannot bypass that permission by calling the bridge directly.
- Open History and Information online, then reopen offline. Saved content should be readable while all server-write actions stay disabled. Inventory count drafts remain editable.

### Recovery of non-count operations

Deliveries, waste, catalog changes, reminders/cards, profiles/settings, corrections and checklist expansions now use an owner-installed **PwaOperations** journal. The device persists `{id, kind, payload}` before sending; the bridge claims the ID under a script lock, stores an actor-bound UTF-8 request hash, then calls the explicit original operation outside the journal lock. Concurrent retries cannot run that operation twice. Successful results are COMMITTED; definite pre-write business failures are REJECTED. The exact ID cannot be reused by another account or with another payload.

An exception, stopped Apps Script execution, or failure between the original write and journal acknowledgement can leave **UNKNOWN**. This is not proof of rollback. **Retry safely checks the journal but never re-executes an UNKNOWN mutation.** First allow the original execution to finish, then check again. If it stays UNKNOWN, the owner must inspect the matching original Events/ProductSync/card/reminder/profile/settings records and Apps Script execution logs. Do not clear the browser record, edit the count to a new ID, or recreate it on another device as a workaround.

For a confirmed interrupted operation, an owner who understands the records can reconcile its journal row _after the original execution has ended_: only if the intended write is verified, set column F to `COMMITTED` and G to `{"ok":true,"manuallyReconciled":true}`. Only if it is verified that **no part of the write happened**, set F to `REJECTED` and G to `{"rejected":true,"error":"Owner verified no write occurred"}`. Partial writes need domain-specific repair first, not either shortcut. Leave all identity/hash columns and stock history intact. If the outcome cannot be proved, keep UNKNOWN and seek assistance. This deliberately favors preventing duplicate stock changes over guessing at an uncertain result.

## Transport and security

Apps Script's HTML service is framed inside a Google-owned sandbox. A separately hosted PWA cannot use `google.script.run` directly, and a JSON fetch is not a reliable authenticated CORS API. This prototype uses a hidden Apps Script HTML bridge. Inside Google's sandbox, the bridge calls an explicit `pwaDispatch` allowlist using `google.script.run`; the PWA communicates through `postMessage`.

Both ends pin the expected origins and channel. The PWA also pins the responding inner Window, rather than assuming Google's outer iframe is the RPC frame. A cryptographically random channel is in the bridge URL; **credentials and inventory payloads are not**. The Apps Script endpoint is not a secret. No JSONP, public-sheet publishing, `no-cors` fetch, third-party proxy, wildcard message target, or shared API key is used. `ALLOWALL` framing is limited to the bridge response; the original inventory page retains its original behavior. Do not add generic function-name dispatch.

The bridge can fail if Google blocks anonymous embedding, a Workspace policy prohibits “Anyone,” or browser tracking/cookie restrictions block Google's iframe/RPC. The app reports a timeout rather than pretending synchronization succeeded. Automated tests simulate the transport; **the actual Google deployment, Safari, and Samsung Internet still need the acceptance test above**. If embedding fails on a target device, use the existing Apps Script app online while deciding on a small hosted Node backend; do not weaken spreadsheet sharing or disable browser security to force it.

## Offline and concurrency limits

- The cached shell and account/deployment-scoped snapshots/drafts live on each device. Offline changes cannot synchronize between disconnected devices.
- Tokens and codes are memory-only. Reopening offline shows saved inventory without a fresh login on that trusted device; online synchronization requires signing in again. Cache access is **not** secure offline identity verification. Local device access controls matter.
- Lock clears this device's saved inventory and drafts (with confirmation); pending operations must be resolved first. Browser storage is unencrypted, may be evicted, and is not a backup.
- No background sync is promised on iOS. Refresh and submission are deliberate, foreground actions. An offline/network event never automatically sends counts. No last-write-wins absolute-count merge is used.
- The bridge reuses the original Apps Script locks, revision validation, batch envelope, numerical behavior, access-code system, cache/session expiration, quotas, and limitations. It does not upgrade legacy floating-point arithmetic or strengthen the original legacy checksum. Counts older than the original session's accepted time window may be rejected and must be physically rechecked.
- Do not change units/zones while staff are working with a frozen checklist. If metadata changes, discard affected entries, resolve the old session in the original UI, and start a new session. Changing existing source data manually can bypass legacy locking/audit rules; use the original UI for stock updates.
- This is a small-team bridge, not unlimited concurrent-device hosting. Quota exhaustion or a Google outage blocks online synchronization, not local drafting.

## Later move to Node/SQLite

Keep one authoritative system at a time. For cutover, resolve pending submissions on every device, freeze the old UI/forms/triggers, export the final workbook, and run the checked SQLite importer against a new database. Verify balances/history and provision Node accounts before redirecting staff to the Node PWA. Old Google drafts must not be automatically submitted to a different backend; identities, revisions, and operation logs differ. The Google transport is isolated in `google-pwa/transport.js` and the Node PWA remains available unchanged.

## Local verification

```sh
npm run build:google
npm test
npm run test:e2e
```

Browser tests serve the staged static app under a repository-like subdirectory and simulate the Google iframe backend without connecting to your workbook. Backend tests execute `PwaBridge.gs` in a mocked Apps Script runtime. These are not evidence of a completed live Google deployment.
