# Deploy VARKA · one release button

After the one-time owner setup, use **GitHub → Actions → Deploy VARKA → Run workflow → main**. It tests the exact commit, updates the existing Apps Script deployment, then publishes GitHub Pages with that deployment's URL prefilled. It does not create another script project or deployment.

The workflow is **manual**, not triggered by pushes or pull requests. Automatic release on every push can be considered after a successful test-copy deployment. No live Google authorization or deployment has been performed by the repository tests.

## What it preserves

- The complete existing Apps Script project is downloaded privately. Only `PwaBridge.gs`, `PwaBridge.html`, `Workspace.gs`, and `WorkspaceNotifications.gs` are replaced from GitHub. Original inventory/authentication files, other files, and the complete manifest are preserved.
- The existing deployment ID, `/exec` URL, access setting, and execute-as setting stay the same. Script Properties, staff credentials, workbook ID, bot credentials, triggers, and data are not configured or migrated by this workflow.
- Existing devices keep their saved connection and its account/database-scoped drafts. A generated URL is a default for unconfigured devices, not permission to switch an existing connection.
- No inventory submission, installer, scheduled-trigger execution, or Telegram test is run as a deployment smoke test.
- Google credentials are used only by the backend deployment step. They are not available to dependency installation/tests and are never put into the public Pages artifact.

## 1. Identify the current test deployment

Use the Apps Script project attached to the workbook copy you intend to test—not an older link to the original café database. Confirm its private `STOCK_SHEET_ID` property points to that intended copy. The workflow does not change this property or select a different workbook for you.

Record these two **non-secret** values:

| GitHub variable             | Where to find it                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APPS_SCRIPT_ID`            | Apps Script → Project Settings → Script ID. This is **not** the spreadsheet ID.                                                                                    |
| `APPS_SCRIPT_DEPLOYMENT_ID` | Deploy → Manage deployments → your existing Web app → Deployment ID. It is also the part between `/s/` and `/exec` in its URL. Do not use the editor's `/dev` URL. |

Keep using that same deployment; do not create a new one for each update.

## 2. Prepare GitHub

In `Feorum/Vibe_Inventory_Stock`:

1. **Settings → Pages → Build and deployment → Source → GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: add the two values above as repository variables.
3. **Settings → Environments → github-pages**: create it if it does not already exist. Under deployment branches/tags, allow **only `main`**. Add a required reviewer if your plan supports it. Protect `main` with review requirements appropriate for production.
4. Google secrets will be stored in this **environment**, not in the repository or frontend. Run the release only after all setup steps have completed.

The workflows reject non-main refs and share one concurrency group. These code checks are useful, but GitHub's environment branch restriction is also necessary: a modified workflow on another branch must not gain access to production secrets.

## 3. Enable Google access once

Use the Google account that owns the existing Apps Script deployment.

1. In [Apps Script user settings](https://script.google.com/home/usersettings), enable **Google Apps Script API** access.
2. In Google Cloud Console, select or create a project for your OAuth client and enable the **Google Apps Script API** for it.
3. Configure the OAuth consent screen/audience. For an external app in Testing mode, add your own account as a test user. Google may expire these test refresh tokens after seven days; use an appropriate Internal/Production setup for ongoing releases. Organization policies may require an administrator. Do not change the existing script's linked Cloud project casually; that can affect its existing authorizations.
4. Create **OAuth client ID → Desktop app** and download its JSON file **outside the checkout**, for example in Downloads. Do not create a Web application client or use a service account. Do not upload that JSON to GitHub, Pages, screenshots, or chat.

The helper requests only `script.projects` and `script.deployments`. These permissions allow changing this account's accessible script source/deployments, so treat the resulting credentials as sensitive. They do not replace the app's staff access codes or the Telegram bot token.

### Public information for an external Production OAuth app

Google's [OAuth branding requirements](https://support.google.com/cloud/answer/15549049) require homepage, privacy, and terms links for external Production apps. The Pages build includes three informational release pages. Publish them before authorizing the helper, then set **Google Auth Platform → Branding** to these URLs for the default Pages address:

- Homepage: `https://feorum.github.io/Vibe_Inventory_Stock/release/`
- Privacy: `https://feorum.github.io/Vibe_Inventory_Stock/release/privacy.html`
- Terms: `https://feorum.github.io/Vibe_Inventory_Stock/release/terms.html`
- Authorized domain: `feorum.github.io`

Use the actual Pages host if different. These pages describe the owner-operated release helper; they contain no credentials or private backend source. If the backend is already compatible, the existing **Deploy Google-mode PWA** frontend-only workflow can publish them before Google release credentials exist. Otherwise publish the informational pages separately without switching staff to an incompatible frontend. Configure the audience as **Production** before authorizing for ongoing releases; if it remains in Testing, add the owner as a test user and account for Google's seven-day test-token expiry.

## 4. Authorize and upload credentials without copying tokens

On your own computer, use Node.js 24 and the [GitHub CLI](https://cli.github.com/). On macOS, install `gh` through its official instructions or Homebrew if needed, then sign in:

```sh
gh auth login --hostname github.com --web
```

From the checkout containing this update, run the command below, replacing the client path with the JSON file you downloaded. The GitHub account must be able to manage environment secrets for this repository.

```sh
node scripts/authorize-google-release.js \
  --client /Users/YOUR_NAME/Downloads/desktop-client.json \
  --repo Feorum/Vibe_Inventory_Stock \
  --environment github-pages
```

The helper opens Google authorization in your browser (or prints a link; `--no-browser` disables automatic opening). Choose the owner account. A temporary server on `127.0.0.1` receives the authorization response; it is not a rented host or permanent service. State and PKCE protect the callback. Only continue if the OAuth client is the private client you created.

After consent, the helper sends these values directly to GitHub environment secrets through the CLI's standard input:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`

Tokens/codes/secrets are not printed or saved to a new file. The helper refuses a client JSON inside the repository. It does not create the GitHub environment or log you into GitHub automatically. Keep the downloaded client JSON private; the helper does not delete your original file.

Wait for the success message before running a deployment. If credential upload fails partway, some secrets may have changed: rerun setup to populate all three before releasing. Reauthorize if Google later revokes or expires the refresh token. Never paste credentials into this chat or into the application's deployment-URL field.

## 5. Confirm the manifest and original-code baseline once

The release refuses to change access settings or publish somebody's unpublished original-code edits.

In Apps Script, enable **Show appsscript.json manifest file in editor** in Project Settings. Preserve all existing manifest fields, libraries, scopes, and runtime settings. Its `webapp.access` and `webapp.executeAs` must explicitly match the **current deployment's** settings.

For example, **only if** the existing deployment executes as you and already permits anonymous access, the matching addition is:

```json
"webapp": {
  "access": "ANYONE_ANONYMOUS",
  "executeAs": "USER_DEPLOYING"
}
```

Do **not** copy that access value for a restricted deployment. Common access values are `MYSELF`, `DOMAIN`, `ANYONE` (signed-in Google users), and `ANYONE_ANONYMOUS`; execution is `USER_DEPLOYING` or `USER_ACCESSING`. Use values matching your current deployment and organization's policy. The deployer verifies the match and never fills/broadens permissions for you.

Review and save your current original code and manifest. If necessary, manually **Edit → New version → Deploy** the existing deployment once to establish that reviewed baseline. Before automation, original files/manifest in HEAD must match the deployed version. If they differ, review and resolve those edits first—do not blindly deploy unknown changes. The workflow can replace unpublished changes to its four managed files because GitHub is their source of truth; it cannot authorize changes to unrelated files.

The original `doGet` hook to `pwaPage_`, original authentication/ledger functions, and canonical HTML file name `PwaBridge` must be present. Duplicate managed-file aliases fail rather than deploying duplicate functions. Server names such as `Workspace.gs` are recognized safely; ambiguous duplicates must be resolved by the owner.

## 6. Make a release

1. Push reviewed changes to `main`.
2. Open **Actions → Deploy VARKA → Run workflow**, select **main**, and run it.
3. Wait for Node/browser tests. Approve the `github-pages` environment if a reviewer is configured.
4. The release reads/rechecks the complete project, overlays the four managed files, uploads HEAD if needed, creates an immutable version if needed, updates the **same** deployment, and verifies its version/URL/access before building Pages.
5. Pages receives a generated public `deployment-config.js`. The service-worker cache revision is derived from all public assets, so a code or default-URL change causes an update without manually editing a cache number.
6. Reopen the PWA online, reload after the update, refresh the database, and verify login/counting against the test copy. New devices have the URL prefilled; users still sign in normally. Existing devices are not silently rerouted and no drafts are cleared.

The deployment URL is intentionally public configuration, not an authentication secret. Passwords, OAuth credentials, Script Properties, backend source, and workbook exports are not staged for Pages.

The older **Deploy Google-mode PWA** workflow remains an advanced **frontend-only** release path. It uses the same deployment-ID variable to generate the default URL, but does not update or verify Apps Script. Use it only when the backend is already compatible. If that variable is unset, a frontend-only build has no default URL and the existing manual connection field remains available.

## Failure and recovery rules

- Missing IDs/secrets, incorrect project/deployment, incomplete original code, duplicate managed aliases, or mismatched access settings stop the release. No new deployment is created as a fallback.
- Current source and deployment are rechecked to detect concurrent edits. **Pause manual editor/deployment changes during a release.** The Google API has no compare-and-swap operation for this whole sequence; the checks reduce but cannot eliminate the final race window.
- Updating project **HEAD affects editor runs and installable triggers immediately**, even before a new web version is deployed. Plan releases carefully around active work and scheduled automations. This workflow does not automatically disable triggers.
- Source upload, version creation, deployment update, and Pages publication are **not one cross-service transaction**. If Pages fails after Apps Script succeeds, the backend can already be updated. If a write times out, it may have completed. Inspect current HEAD/deployment before rerunning; the script does not blindly retry writes or roll back over newer work.
- A failed backend step blocks Pages in the combined workflow. If the identical backend is already deployed on the next run, it is verified without creating another version.
- Remote source and raw Google error bodies are withheld from logs to avoid exposing private code or credentials. HTTP 400 can mean source/manifest problems or a version limit; HTTP 401/403 can mean authorization, API enablement, ownership, or organization policy. Inspect the project/Google settings privately. Reauthorize through the helper when necessary.
- API-level version/URL verification is **not** a live business-workflow test. After first setup, verify actual Google authorization/embedding, your copied workbook, triggers, mobile offline recovery, and a dedicated Telegram test chat. New script scopes/services may require manual owner authorization even after this release credential setup.

No setup command or workflow automatically runs database installers, migrations, inventory writes, or Telegram notification tests.

## Verification completed in this checkout

**220/220 Node tests** and **207/207 browser regressions** passed. Three opt-in screenshot cases are intentionally skipped in the regular browser run. New checks include 18 mocked deployment API cases, 14 OAuth-helper cases, seven isolated Pages/config/cache tests, workflow-policy checks, and browser cases for fresh-device defaults, saved connections/drafts taking priority, and invalid saved endpoints not being silently switched. Public staging, JavaScript syntax, YAML formatting/parsing, and `git diff --check` passed.

Google/GitHub API interactions in these checks are mocked; OAuth callback tests bind only an ephemeral local loopback port. No real Google consent, GitHub secret upload, Apps Script deployment, Pages publication, inventory write, or Telegram delivery was performed. The first live end-to-end release remains blocked on the owner's one-time setup above. Real-device acceptance remains separate from Chromium phone-size emulation.
