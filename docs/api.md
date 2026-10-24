# VARKA JSON API

The PWA and API share one origin. All routes below begin with `/api/varka`. Mutations require `Content-Type: application/json`, `X-Inventory-Request: 1`, and—except sign-in/sign-out—a unique UUID `Idempotency-Key`. Authenticated routes require the individual login cookie. Production cookies require HTTPS.

Errors return `{ "error": "Explanation", "code": "MACHINE_CODE" }`; conflict responses may include the affected product/current revision. Quantities are decimal **strings**, never JSON numbers. A missing balance/minimum is null, not zero.

| Method     | Path                                         | Purpose                                                                                                       |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET        | `/session`                                   | Current individual profile or null; no caching                                                                |
| POST       | `/session`                                   | Sign in with `{ email, code }`; sets HttpOnly cookie                                                          |
| DELETE     | `/session`                                   | Revoke login; send `{}`                                                                                       |
| GET        | `/bootstrap`                                 | Current user, catalog/stock, categories, zones, units, recent sessions, settings, migration report, sync time |
| POST       | `/products`                                  | Versioned creation/edit, activation, or archival                                                              |
| POST       | `/movements`                                 | Atomic delivery/waste batch                                                                                   |
| GET        | `/sessions`                                  | Recent session summaries with ownership                                                                       |
| POST       | `/sessions`                                  | Start a frozen checklist with `{}`; session ID is the operation ID                                            |
| GET        | `/sessions/:id`                              | Checklist and recorded counts                                                                                 |
| POST       | `/sessions/:id/refresh`                      | Explicitly refresh unsubmitted snapshot metadata/expand products using `{ version }`                          |
| POST       | `/sessions/:id/submit`                       | Atomic session/catalog/count completion                                                                       |
| POST       | `/sessions/:id/corrections`                  | Append a scoped session correction                                                                            |
| GET        | `/history?before=SEQ&limit=100&sessionId=ID` | Paginated original events and related corrections; limit capped at 500                                        |
| GET        | `/history/:eventId`                          | Immutable event fingerprint for correction validation                                                         |
| GET        | `/operations/:id`                            | Stored outcome for the authenticated actor's native operation; 404 if not committed                           |
| GET        | `/information`                               | Active yellow cards and reminders                                                                             |
| POST       | `/cards`                                     | Add or remove a card                                                                                          |
| POST       | `/reminders`                                 | Create/update text or completion status                                                                       |
| POST       | `/profile`                                   | Change the current user's display name with `{ name, version }`                                               |
| POST       | `/notification-settings`                     | Owner-only `{ enabled, mode, version }`                                                                       |
| GET / POST | `/admin/users`                               | Owner-only account metadata/provisioning; hashes/codes are never returned                                     |
| GET        | `/admin/notifications`                       | Owner-only delivery metadata/status queue                                                                     |
| POST       | `/admin/notifications/retry`                 | Owner-only explicit delivery retry                                                                            |

`GET /api/health` remains an unauthenticated SQLite liveness check. Earlier starter routes under `/api/items`, `/api/movements`, and `/api/session` refer to separate prototype tables/authentication; they are not the migrated stock API.

## Create a product

```json
{
  "product": {
    "ru": "Молоко",
    "en": "Milk",
    "category": "Молоко / Milk",
    "unit": "l",
    "sleeve": 0,
    "minimum": "40",
    "hours": 24,
    "notes": "",
    "active": true,
    "zones": ["fridge", "cabinet"]
  }
}
```

Use an existing category from bootstrap. Units are `l`, `kg`, `pcs`, `pack`, or `roll`. Minimum may be null. Sleeve is 0 or 25, and 25 requires pieces plus packaging notes. `pack` also requires notes. Check interval is a whole number from 1 to 8760 hours. New stock is unknown until a session count establishes it.

For an edit, add the product `id` and current integer `version`. Use `{ id, version, action: "active", active: false }` to deactivate; then `{ id, version, action: "archive" }` to archive. A product with history cannot change units/packaging.

## Receive or waste

```json
{
  "action": "WASTE",
  "note": "Damaged package",
  "items": [
    {
      "id": "P001",
      "revision": "1:4",
      "value": "0.25",
      "unit": "BASE",
      "approx": false,
      "low": false
    }
  ]
}
```

Action is RECEIVE or WASTE; waste requires a note. Items need current bootstrap revisions and known balances. `SLEEVE_25` is an optional input unit only for configured piece products; other inputs use BASE. A failure in any item rolls back the whole request. Positive amounts, sufficient stock, maximum range, and whole pieces are enforced server-side.

## Submit an inventory session

```json
{
  "version": 1,
  "blankPolicy": "KEEP_CURRENT",
  "incomplete": false,
  "items": [
    {
      "id": "P001",
      "revision": "1:4",
      "unit": "BASE",
      "approx": false,
      "low": false,
      "countedAt": "2026-10-24T12:00:00.000Z",
      "locations": [
        { "zoneId": "fridge", "value": "6", "unit": "BASE" },
        { "zoneId": "cabinet", "value": "53", "unit": "BASE" }
      ]
    }
  ],
  "productChanges": []
}
```

Use the current session version and item revision. Every assigned zone must be present exactly once. A product without assigned zones uses `value: "59"` directly, with no locations. Zero is a valid explicit count. Local `countedAt` is retained; the accepted check timestamp is server-recorded, matching the legacy balance projection.

REQUIRE_ALL rejects missing counts unless `incomplete: true`. KEEP_CURRENT explicitly leaves blanks untouched and closes as COMPLETE_WITH_UNCHANGED when appropriate. Kept blanks do not create CHECK events or refresh timestamps. The session must be open and owned by the caller.

To atomically stage product changes with counts, include `{ id, version, active, zones }` entries in `productChanges`. Activation requires an associated count; deactivation cannot include one. Counts use pre-change item revisions, and all affected catalog/count/session data commits together.

## Correct a session

First obtain the target event fingerprint from `/history/:eventId` and the latest session correction ID from history. Then submit:

```json
{
  "mode": "HISTORY_ONLY",
  "parentId": null,
  "reason": "Transcription error",
  "changes": [
    {
      "id": "original-event-id",
      "version": "event-fingerprint",
      "value": "4.5"
    }
  ]
}
```

CURRENT additionally updates stock if no newer movement exists; HISTORY_ONLY changes annotations only. Only the original actor may correct their own session counts. Existing events are never updated or deleted. Reusing an old correction-history parent returns a conflict.

## Supporting records and access

Reminders accept `{ id, text, done, version }`, omitting version for creation. Cards accept `{ id, action: "add", name, size, category, note }` or `{ id, action: "remove", version }`. Both preserve author snapshots and require version checks for changes.

Account provisioning accepts `{ email, name, role: "staff", enabled: true, code }`; omit code only when preserving existing credentials/metadata. New or rotated codes require 12–200 characters. Account management revokes old sessions. The server persists only a fingerprint of code-bearing operation payloads, and the UI never stores codes in its pending queue.

Notification mode is LOW or ALL. Retrying an UNKNOWN report additionally requires `acknowledgeDuplicateRisk: true`. HTTP/network ambiguities must not be resolved by inventing new stock operation IDs: retry the exact original stock request or query its stored outcome.
