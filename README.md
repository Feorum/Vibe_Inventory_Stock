# VARKA · Café inventory

The VARKA Google Apps Script inventory rewritten as a **Node.js 24 + Express + SQLite PWA**. One server serves the phone interface and API. There is no frontend build step or app-store release.

The supplied workbook has been imported into the local, ignored `data/varka.sqlite`: **134 products, 839 original logical events, 26 inventory sessions, 94 card records, and 2 reminders**. All 134 café balances, manual-low flags, accuracy flags, and physical-check timestamps reconcile with the export. The import preserves the unknown balance, missing minimums, inactive/archived products, batch envelopes, and original workbook rows. It sends no historical notifications. The final verified backup is at `data/backups/varka-verified.sqlite`; earlier snapshots are retained too. Private data is not included in Git or the Docker image.

This is a migration of the uploaded snapshot, not continuous Google Sheets synchronization. Freeze spreadsheet writes and use a fresh, reconciled export for the eventual production cutover.

## No rented host yet? Google Sheets prototype

The separate [Google-mode setup guide](docs/google-mode.md) provides a static PWA for GitHub Pages and an authenticated bridge added to the existing Apps Script project. It uses the **same live Google workbook** for stock/counting, deliveries/waste, catalog management, sessions, history/corrections, reminders/cards, profile and owner report settings. Per-device offline snapshots/count drafts and conflict-aware synchronization remain available; other mutations require a connection and have a durable operation journal. No Node server is needed for this mode. Bridge writes default off; the owner must deploy/configure it and complete the real-phone tests. Existing prototype users: follow **Updating the working prototype**, including the new `installPwaFeatures` function. This does not mirror Sheets into SQLite or expose historical migration/trigger administration as daily actions.

## Run

Install Node.js 24, then run from the checkout:

```sh
npm ci
npm start
```

Open `http://localhost:3000`. The default database is `data/varka.sqlite`. A fresh clone starts empty until you run the importer. `npm run dev` restarts the server when backend files change. The earlier starter database, if present at `data/inventory.sqlite`, is left intact.

With no configured staff credentials, nonproduction mode provides a clearly labeled development owner. **Provision an owner before exposing the server or publishing it.** Production refuses to start without an enabled, provisioned owner and the configured deployment password.

For the Google-backed app's phone layout and accessibility behavior, see [Mobile interface v3](docs/mobile-accessibility.md). This frontend-only update is published using the existing Pages workflow; it does not require changes to Apps Script.

## Staff access

Copy `.env.example` to `.env` and set `OWNER_EMAIL` and a strong `APP_PASSWORD` of at least 12 characters. On first startup, these provision that owner; sign in using the email and password as the individual access code. Existing account codes are not reset on subsequent startups. Imported profiles do not include their old Apps Script access codes.

Alternatively, provision an account using a securely supplied `VARKA_ACCESS_CODE` environment variable:

```sh
npm run user:add -- owner@example.com --role owner --name "Owner"
```

Set `VARKA_ACCESS_CODE` in the shell or secure environment before this command; do not put a real code into a committed script or shared terminal transcript. The command also accepts `--database ./data/varka.sqlite`. Provision staff similarly with `--role staff`, or use **Profile → Staff access** as the owner. Match existing staff emails to preserve ownership of imported sessions and history. Codes are salted/scrypt-hashed; login cookies are HttpOnly and SameSite=Strict, with Secure enabled in production. Sessions last 12 hours and are revoked on credential rotation, disablement, or role updates. Only the owner can manage accounts and notification settings.

## Workflows

- **Stock:** café-wide balances, low/out flags, missing minimums, estimates, and overdue physical checks; record a delivery or waste. Waste requires a reason. Products need an opening physical count before any movement.
- **Count:** start or resume your inventory session, count every assigned zone, optionally use configured sleeves of 25 pieces, and submit one atomic batch. Explicitly choose whether blanks remain unchanged or the session is incomplete. Blanks never become zero or acquire a new check timestamp.
- **Catalog:** RU/EN names, existing categories, units, check intervals, nullable minimums, packaging, enabled status, and storage zones. Unit changes are blocked after history exists. Deactivate before archiving. During an open session, stage enabled-status/zone changes to commit with that session's counts.
- **History:** paginated immutable stock events with original authors, timestamps, quantities, and location provenance. Correct your own session entries with a reason; choose history-only or current stock. Current corrections cannot overwrite newer movements.
- **Information:** team reminders and yellow cards, including version checks and author attribution.
- **Profile:** display name, staff access, notification settings, and delivery outcomes.

Quantities use exact decimal strings with up to eight decimal places and a maximum of 1,000,000,000. Calculation uses Node `BigInt` internally. Whole pieces are enforced. Unsupported source precision or range blocks import rather than being rounded silently. All dates display in `Europe/Minsk`; the UI supports RU and EN.

## Import another export

Dry-run first; this command opens no application database:

```sh
npm run import:varka -- "path/to/VARKA.xlsx"
```

It verifies the legacy batch digests and identities, expands compact events, replays café balances, validates session references, and compares quantities/flags/check times against `CafeStock`. Invalid envelopes, duplicate IDs, unsupported precision, and reconciliation differences stop the import.

Apply to a **new** database, then point `DATABASE_PATH` at it after verification:

```sh
npm run import:varka -- "path/to/VARKA.xlsx" --apply --database ./data/new-varka.sqlite
```

The entire import is transactional. A previously imported file fingerprint is a no-op replay, even if the database subsequently acquired new stock changes; a different workbook cannot overwrite populated VARKA inventory. Original sheet rows and envelopes are retained privately in SQLite. Historical notification settings are preserved, but no historical deliveries are queued. Google Script Properties, live triggers, access codes, and browser-local Apps Script drafts are not part of the export; provision new access and resolve old drafts before cutover.

See [the original-source assessment](docs/legacy-migration.md) for verified source counts and legacy checksum details.

## Samsung and iPhone installation

Use the deployed app's **HTTPS** address. Localhost is allowed for desktop development, but a phone visiting a plain HTTP LAN address cannot use full PWA features. A phone's localhost refers to the phone, not the development server.

- **Samsung:** Chrome or Samsung Internet → browser menu → Install app / Add to Home screen, or the app's Install button.
- **iPhone:** Safari → Share → Add to Home Screen → Add. iOS does not provide Chrome's automatic installation prompt.

After a successful connected visit, stock/history/information snapshots can be viewed offline. An already opened count session can be drafted offline and survives reloads. Sending stock changes always needs the server and revision validation. There is no automatic background submission. If a response is lost, the exact request and operation ID are preserved; **Retry safely** confirms or replays that operation without duplicating it. Access codes are never stored in drafts or pending operations.

“Lock” revokes the login and clears saved API snapshots. Count drafts remain scoped to the account on that device so they can be recovered after signing in again. These are unencrypted device-local records; use trusted shop devices. Browser storage can be evicted and is not a backup.

## Deploy with HTTPS

Use one Node process and persistent local storage. Do not use ephemeral serverless storage or share the SQLite file among replicas/network filesystems.

The included Docker Compose configuration provides Caddy HTTPS and a persistent SQLite volume:

1. Point `DOMAIN` at the server and allow inbound TCP 80/443.
2. Create `.env` from `.env.example`; set `DOMAIN`, `OWNER_EMAIL`, and a strong `APP_PASSWORD`.
3. Run `docker compose up --build -d`.
4. Copy the reviewed workbook into the app container and run the importer there, or restore the verified SQLite backup into the volume while the app is stopped. The private local database is deliberately excluded from image builds.
5. Check `docker compose ps` and the app/Caddy logs. Sign in, validate counts/history, and install on both phones before switching staff from Google Sheets.

To import within the running container before staff use it:

```sh
docker compose cp ./VARKA.xlsx app:/app/data/import.xlsx
docker compose exec app node scripts/import-varka.js /app/data/import.xlsx
docker compose exec app node scripts/import-varka.js /app/data/import.xlsx --apply --database /app/data/varka.sqlite
```

Use this only with an empty VARKA inventory in that volume. Never remove `inventory_data` during upgrades. The app runs as the nonroot `node` user; ensure externally restored files are readable/writable by that user (UID 1000 in the supplied image).

Caddy is the single trusted proxy, and Compose sets `TRUST_PROXY=1`. For a different hosting setup, terminate HTTPS, preserve Host, supply X-Forwarded-Proto, set `NODE_ENV=production`, and enable trust only behind exactly one trusted proxy. The Node port is not published by Compose.

On TLS-inspecting networks, the Dockerfile supports an optional build-only trusted CA mount: `docker build --build-arg HTTPS_PROXY --build-arg HTTP_PROXY --secret id=npm_ca,src=/path/to/ca.pem -t varka .`. Keep TLS verification enabled; the CA mount is not saved into the image.

## Telegram reports

Reports are written to a transactional SQLite outbox only after successful stock changes, never by importing old events. Owner settings choose low/out products or all active products. The worker sends ordinary Telegram text messages and tracks PENDING, SENDING, SENT, FAILED, and UNKNOWN outcomes. A lost reply or interrupted send is UNKNOWN and is not retried automatically; the owner must verify the chat before explicitly accepting the duplicate risk.

Delivery defaults off. To activate it, supply `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID` securely to the server, set `TELEGRAM_DELIVERY_ENABLED=true`, and enable reports in Profile. Pending reports can then be delivered; inspect the queue before turning this on after testing. Tokens are not stored in the database or browser. No real Telegram messages were sent during migration or validation.

## Backups and checks

```sh
npm run backup -- ./data/backups/varka-2026-10-24.sqlite
npm test
npx playwright install chromium  # only if a system Chromium is unavailable
npm run test:e2e
```

Backup uses SQLite's online backup API, including committed WAL data, and refuses to overwrite an existing file. In Docker, run `docker compose exec app node scripts/backup.js /app/data/backups/backup.sqlite`, then copy the completed backup off the host. Test restoration. Stop the app before replacing its database; preserve the old database and its WAL/SHM sidecars together, and do not mix stale sidecars with a restored backup.

Backend checks cover migration integrity, exact arithmetic, atomic rollback, conflicts, session ownership, zones/sleeves, archival, corrections, access revocation, and notification outcomes. Browser checks cover mobile layouts, counting/waste, offline reloads, RU/EN, staff provisioning, locking, and lost-response recovery using desktop, Samsung-sized, and iPhone-sized Chromium profiles. These are emulated phone layouts; actual Samsung hardware, iPhone Safari, and a public HTTPS deployment remain untested here.

Frontend files are precached by `public/varka-sw.js`; bump its shell cache version when deploying changed assets. `npm run icons` regenerates the checked-in icons. [Architecture](docs/architecture.md) and [API](docs/api.md) describe extension points. The old generic starter routes and `starter.html` remain for compatibility, with separate `items`/`movements` tables; they do not operate on the migrated VARKA stock.
