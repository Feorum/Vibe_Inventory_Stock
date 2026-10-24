# VARKA source assessment and migration design

This document records the supplied Apps Script application, workbook, and the source-driven migration requirements. The snapshot has now been imported into the local `data/varka.sqlite`, and the Node application implements the core workflows described below. See the current [architecture](architecture.md), [API](api.md), and [runbook](../README.md) for actual modules and commands. The supplied scripts were read as application source, not executed as setup instructions. No Apps Script installers, spreadsheet writes, or Telegram sends were run.

## Source files

The five text attachments correspond to these filenames, in upload order:

| File                   | Responsibilities observed in the source                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Код.gs`               | Workbook access, original stock calculations, café-wide balances, forms, individual access-code authentication, browser entry points, notifications, and administrative helpers                                      |
| `Inventory.html`       | RU/EN mobile interface, inventory drafts, sessions, product management, zone counts, profiles, cards, reminders, history, corrections, and notification settings                                                     |
| `Enhancements.gs`      | v3 product management, audit log, reminders, yellow cards, and notification extensions                                                                                                                               |
| `InventorySessions.gs` | v4 session snapshots, append-only session journal, counts, corrections, history, and completion rules                                                                                                                |
| `BatchInventory.gs`    | v5 batch envelopes **plus v6–v11 changes**, including profiles, archive handling, zones, product synchronization, imports, atomic catalog/count submissions, session corrections, and notification delivery tracking |

The application is more advanced than the initial “stock pilot” description suggests. The last file contains later versions, not just v5. Several functions in `Inventory.html` are replaced by later definitions/wrappers; a port must follow the final effective behavior, rather than copying the first implementation of each function. Apps Script global helpers and `google.script.run` are platform-specific and cannot run directly in a normal Node/browser deployment.

The originals remain in the uploaded attachments. They and the workbook have not been added to the public frontend or committed as application assets. Credentials from Script Properties are not part of the XLSX export and should not be transferred into source code.

## Workbook inspection

Source: `VARKA — Stock _ Склад — Pilot.xlsx`.

SHA-256 of the supplied file:

```text
a3f344b19ce094d47acce5ad33fe1844de04e551bea0358fc54f6636b6deff4b
```

| Data                                                      | Observed count |
| --------------------------------------------------------- | -------------: |
| Products                                                  |            134 |
| Enabled products                                          |            120 |
| Archived products, included in the total above            |              1 |
| Categories                                                |             10 |
| Products assigned to storage zones                        |             84 |
| Products configured for sleeves of 25 pieces              |              7 |
| Raw `Events` records                                      |            332 |
| Batch envelopes, included in raw events                   |             18 |
| Expanded logical events                                   |            839 |
| Logical café-wide events                                  |            836 |
| Legacy location-specific events, retained separately      |              3 |
| Inventory session journal records                         |             35 |
| Session starts, included in the journal                   |             26 |
| User profiles                                             |              2 |
| Yellow-card records, including their stored active status |             94 |
| Reminders                                                 |              2 |

The workbook uses `l`, `kg`, `pcs`, and `pack`; the source also supports `roll`. Categories and product names are bilingual, with stable product IDs such as `P001`. There are 119 products without a configured minimum; this is distinct from a minimum of zero. One café balance is unknown, and all 120 enabled products have known balances in this snapshot.

### Reconciliation performed

1. Read workbook cells and retained event row order, including the original JSON strings in batch envelopes.
2. Checked envelope action/type, operation ID, session ID, request hash, declared event count, and stored payload digest.
3. Verified all 18 envelopes: eight version 5, one version 8, and nine version 9.
4. Expanded the compact event defaults exactly as `v8ExpandBatch_` does. The 18 envelopes contain 525 logical events; combined with 314 ordinary records, the result is 839 events.
5. Replayed only `Source = CAFE` events using `CHECK` as an absolute balance and `RECEIVE`/`WASTE` as adjustments to known balances. The three legacy location counts were not treated as café totals.
6. Compared each result with `CafeStock`: **134 of 134 balances match**, including the one unknown balance. No baseline from private Script Properties was needed to reproduce these final balances because the café check events establish them.

The supplied envelopes' digests all match SHA-256 after characters outside seven-bit ASCII are replaced with `?`. A plain UTF-8 digest matches only two envelopes, both containing ASCII-only payloads. There are no non-ASCII Latin-1 characters in these payloads, so this observation alone does not establish how the original runtime handles every possible character. A migration implementation must test its legacy encoding adapter against these actual envelopes and retain the original strings and stored digests. It must not silently rewrite payloads or expected hashes to force a match. The legacy replacement digest does not distinguish some Cyrillic text changes; use a full UTF-8 fingerprint for the preserved export and all new application requests.

This verifies the internal consistency of the uploaded snapshot, not live Google Sheets state or current physical stock. Runtime Script Properties, trigger configuration, access codes, and Google deployment settings were not exported.

## Business rules to preserve

- **Café totals are authoritative.** Storage zones are components of a physical count, not separate stock ledgers to sum again later. Internal transfers do not change café stock.
- **Unknown is not zero.** A product without a physical opening count cannot receive stock movements. An explicit physical count of zero is valid.
- **Missing minimum is not zero.** An unset threshold produces “set minimum”; an explicitly configured threshold can trigger low stock.
- **Manual low and estimated counts are separate state.** Ordinary movements preserve relevant flags; a new physical count can establish a fresh exact/manual-low state. Check freshness depends on the last physical check, not merely the last delivery.
- **Units and packaging matter.** `pcs` quantities must be whole pieces. Sleeve input multiplies by 25 only for explicitly configured products. Required zone counts must all be present, unique, and compatible with the product snapshot before their sum becomes a café count.
- **Waste requires a reason.** Do not equate every stock-out event with an undocumented adjustment. Preserve the original action, reason, author, timestamps, and before/after values.
- **Inventory sessions have frozen checklists.** Preserve the starting catalog/revisions, ownership, expansions, explicit incomplete completion, and `KEEP_CURRENT` handling. A blank item retained unchanged is not a new physical check and must not refresh its check time.
- **A submission is atomic.** Catalog activation/zone changes and counts that belong to the same batch must either all commit or none commit. Activation requires the associated count; deactivation cannot include a count for the same item.
- **Retries and conflicts are different.** Same operation ID, actor, and request payload is a replay. A changed payload under the same ID is rejected. A stale item/catalog/session revision requires review rather than an automatic rebase of an absolute count.
- **History is append-only.** Session revisions can be history-only or affect current stock. A current correction must not overwrite a newer movement and is limited by the original author/unit/revision rules.
- **Archived and inactive are different.** Deactivate before archiving, retain product IDs and history, and prevent unit changes once history exists.
- **Staff identities remain individual.** Preserve authorship and the distinction between staff operations and owner-only notification settings. The starter's shared password is not equivalent to the original per-email access codes.
- **Locale is part of the workflow.** Preserve RU/EN text, comma-decimal input, and `Europe/Minsk` display behavior. XLSX wall-clock date cells need explicit timezone interpretation; ISO timestamps in JSON already identify an instant and must not be shifted again.
- **Notifications follow a stock commit.** Telegram/report failures must not undo a committed count or cause it to be submitted twice. Ambiguous delivery stays distinguishable from a confirmed send.

The source sometimes rounds conversion/zone totals to eight decimal places, while other number parsing accepts arbitrary decimal input within its range. The original starter's three-decimal representation was insufficient. The migrated VARKA domain now uses exact decimal strings and BigInt arithmetic with eight decimal places and the original billion-unit maximum. The importer rejects unsupported precision/ranges rather than rounding them silently; the full supplied export fits the exact representation.

## Target Node.js structure

Keep the current same-origin PWA, Node process, local persistent SQLite disk, and HTTPS deployment boundary. Add domain modules instead of emulating `SpreadsheetApp`, executing uploaded `.gs` files, or exposing an unrestricted RPC dispatcher.

```text
server/
  auth/           individual accounts, hashed access codes, sessions, owner role
  catalog/        bilingual products, category IDs, units, packaging, archival
  stock/          café balances, flags, freshness, event replay, revision checks
  sessions/       frozen checklist, draft/submit, completion, correction rules
  information/    profiles, yellow cards, reminders
  notifications/  report rendering, transactional outbox, delivery worker
  migration/      workbook reader, envelope decoder, dry-run/reconciliation
public/
  api/            explicit HTTP client replacing google.script.run
  inventory/      zone counts, sleeve conversion, count/receive/waste forms
  sessions/       locally persisted drafts and explicit conflict review
  information/    cards, reminders, profiles
  locales/        shared RU/EN message keys
```

This tree records the conceptual domain split used for the port. The implemented modules are under `server/varka/`; their exact file mapping is documented in [architecture](architecture.md). The old starter API/UI remains separate for compatibility and does not operate on migrated stock.

### SQLite model

| Table group                                                             | Purpose                                                                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `users`, `auth_sessions`                                                | Individual identities, roles, hashed credentials, revocable sessions; never import old authentication tokens as source data             |
| `products`, `categories`, `zones`, `product_zones`                      | Preserve stable source IDs, RU/EN names, nullable minimum, check interval, packaging, active/archive status, and metadata revisions     |
| `stock_events`, `stock_balances`                                        | Append-only source events and their materialized café projection; balances may be unknown and retain manual-low/accuracy/check metadata |
| `inventory_sessions`, `session_items`, `session_journal`                | Original checklist snapshots, authorship, completion state, and additions                                                               |
| `stock_batches`, `idempotency_requests`                                 | Atomic operation identity, actor, canonical request hash, commit result, and replay lookup                                              |
| `session_revisions`, `revision_items`                                   | Corrections without deleting or rewriting original history                                                                              |
| `profiles`, `yellow_cards`, `reminders`                                 | Supporting workflow records, versions, and author snapshots                                                                             |
| `notification_settings`, `notification_outbox`, `notification_attempts` | Owner settings and durable delivery state separate from stock commit success                                                            |
| `migration_runs`, `legacy_rows`                                         | Export fingerprint, reconciliation results, original source rows, and replay provenance                                                 |

Choose and document a lossless decimal representation before implementing the importer. A fixed eight-decimal SQLite integer scale with Node `BigInt` and decimal-string JSON is one option for values accepted at that precision; the original maximum exceeds safe JavaScript integer precision after scaling, so ordinary `Number` arithmetic is insufficient. Values outside the chosen exact representation must block import and appear in a dry-run report.

### HTTP boundary

The legacy capabilities below are now exposed through explicit authenticated `/api/varka` routes; see [API](api.md) for their concrete paths and payloads:

| Legacy entry points                                          | Target capability                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `webLogin`, `webLogout`, `webAuth_`                          | Individual sign-in/sign-out and session middleware                              |
| `webV3Load`, `webV8Load`, `webV8Refresh`                     | Catalog, stock projection, zones, and selected session reads                    |
| `webSave`                                                    | Atomic delivery/waste batch with expected revisions and reasons                 |
| `webV5Start`, `webV5Submit`, `webV9SubmissionStatus`         | Start a checklist; submit one transaction; query an ambiguous operation outcome |
| `webV8SyncProducts`, `webV7Archive`                          | Versioned catalog edits and archival                                            |
| `webV4History`, `webV9CorrectSession`                        | Paginated immutable history and scoped corrections                              |
| `webV6Profile`, `webV6Information`, `webV6Note`, `webV6Card` | Profiles, reminders, and yellow cards                                           |
| `webV10Settings`, `webV10SaveSettings`                       | Owner-managed notification settings                                             |

Use one SQLite transaction for operation replay checks, product/session revision validation, catalog changes, stock events/projection updates, session completion, and notification-outbox insertion. Make external notification requests only after commit. A server-side operation-status endpoint lets a phone resolve an uncertain response without inventing another operation ID.

## Implementation boundary and cutover gates

Implemented: individual accounts and revocable sessions, exact café stock, zone/sleeve counts, atomic inventory sessions and staged catalog changes, RU/EN mobile views, product lifecycle/revisions, reminders/cards, immutable history/corrections, offline drafts, persisted operation recovery, and a durable notification outbox. The checked import populated 134 products, 839 events, 26 sessions, 94 cards, and both reminders; the post-import backup is retained privately under `data/backups/`.

Do not import the workbook into the current generic `items`/`movements` schema as though that were a completed migration. It would lose source IDs, precision/unknown semantics, session relationships, and staff attribution. Do not replace 836 café events with 134 fabricated opening entries while claiming historical parity.

The following acceptance checks guided implementation; final external cutover checks remain operational requirements:

1. Add the normalized legacy-aware schema and lossless data reader. Preserve the original export and every raw event/journal row, including legacy area events and inactive/archived products. A default dry-run must create no application database changes.
2. Build envelope expansion and reconciliation fixtures using the observed counts and all 134 balance matches above. Tampered envelopes, duplicate operation IDs, missing references, unsupported units/precision, and balance differences must fail the import rather than be skipped.
3. Port staff authentication and stock/catalog invariants. Test unknown versus zero, unset minimum, whole pieces, sleeves, required waste reasons, stale revisions, and concurrent withdrawal/physical-count conflicts.
4. Implement inventory sessions, all-zone counts, explicit unchanged/incomplete handling, atomic catalog changes, and append-only corrections. Verify a failed item leaves the entire batch unchanged, and that retries never duplicate a batch.
5. Port the mobile RU/EN workflows, profiles, cards, reminders, and operation recovery. Keep offline inventory read-only; locally stored count drafts require server revision checks before an explicit submit. Test reloads and reconnects on iPhone Safari and Samsung browsers, beyond the existing Chromium viewport tests.
6. Add the notification outbox and owner settings without sending historical notifications during import. Test confirmed, failed, and ambiguous delivery outcomes independently of stock commit status.
7. Freeze spreadsheet writes for the final export, rerun dry-run reconciliation, import into a new SQLite database, verify IDs/balances/history and both phone workflows, and take a restorable backup before switching the deployed application to that database.

The uploaded snapshot is imported and reconciled, but public deployment is separate. Provision real staff credentials, use a final fresh export after freezing spreadsheet writes, test actual Samsung/iPhone browsers and HTTPS installation, and configure Telegram explicitly if required. The Node worker uses standard text reports rather than the original rich-message implementation. Old Apps Script browser drafts, private Script Properties, Forms triggers, and deployment secrets are not imported. Google scripts and triggers should be retired only after the replacement workflow passes the external cutover checks.
