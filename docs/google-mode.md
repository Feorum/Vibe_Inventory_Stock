# Temporary Google Sheets mode

This is a separate, limited prototype: **GitHub Pages → Apps Script bridge → the existing private VARKA workbook**. No Node server, Google API key, service-account key, or public spreadsheet is required. The Node/SQLite application remains unchanged.

Implemented: existing individual sign-in, live active product/balance reads, explicit refresh, existing inventory-session creation, per-zone counts (including configured sleeves), offline shell/snapshots/count drafts, manual synchronization, revision-conflict review, and idempotent lost-reply recovery. Product editing, deliveries/waste, corrections, reminders, and reports remain in the original Apps Script UI for this prototype; they are not new offline workflows. “Synchronization” here means reading/writing the **same workbook**, not maintaining a second SQLite copy.

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
