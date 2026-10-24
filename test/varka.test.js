import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/database.js";
import { quantity, decimal, hash } from "../server/varka/core.js";
import { catalog, movements, history } from "../server/varka/stock.js";
import { saveProduct, DEFAULT_CATEGORIES } from "../server/varka/catalog.js";
import {
  startSession,
  session,
  submitSession,
  refreshSession,
  correctSession,
} from "../server/varka/sessions.js";
import { provisionUser } from "../server/varka/auth.js";
import {
  information,
  saveCard,
  saveReminder,
} from "../server/varka/information.js";
import {
  settings,
  saveSettings,
  notificationWorker,
  retryNotification,
} from "../server/varka/notifications.js";
import {
  inspectSheets,
  importWorkbook,
  legacyDate,
} from "../server/varka/import.js";
import { createApp } from "../server/app.js";

const actor = { email: "owner@example.test", name: "Owner", role: "owner" };
const staff = { email: "staff@example.test", name: "Barista", role: "staff" };
function dbFor(t) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  return db;
}
function add(db, overrides = {}) {
  return saveProduct(db, actor, randomUUID(), {
    product: {
      ru: `Кофе ${randomUUID()}`,
      en: "Coffee",
      category: DEFAULT_CATEGORIES[0],
      unit: "kg",
      sleeve: 0,
      minimum: null,
      hours: 24,
      notes: "",
      zones: [],
      ...overrides,
    },
  }).product;
}
function draft(item, value, overrides = {}) {
  return {
    id: item.id,
    revision: item.revision,
    value,
    unit: "BASE",
    approx: false,
    low: false,
    countedAt: new Date().toISOString(),
    ...overrides,
  };
}
function count(db, item, value, overrides = {}) {
  const sid = startSession(db, actor, randomUUID()).session.id;
  const body = {
    version: 1,
    items: [draft(item, value, overrides)],
    blankPolicy: "KEEP_CURRENT",
    incomplete: false,
  };
  submitSession(db, actor, randomUUID(), sid, body);
  return { sid, body, item: catalog(db).find((row) => row.id === item.id) };
}
function change(item, value, action = "RECEIVE") {
  return {
    action,
    note: action === "WASTE" ? "Broken package" : "",
    items: [{ id: item.id, revision: item.revision, value, unit: "BASE" }],
  };
}

test("VARKA uses exact eight-decimal quantities throughout the original range", () => {
  const large = quantity("1000000000");
  assert.equal(large, 100000000000000000n);
  assert.equal(decimal(quantity("0,00000001")), "0.00000001");
  assert.equal(decimal(quantity("0.1") + quantity("0.2")), "0.3");
  assert.throws(() => quantity("1.5", "pcs"), /whole/i);
  assert.throws(() => quantity("0.000000001"), /eight/);
  assert.throws(() => quantity("1000000001"), /exceed/);
});
test("new products have unknown balances and missing thresholds, not fabricated zero", (t) => {
  const db = dbFor(t);
  const item = add(db);
  assert.equal(item.quantity, null);
  assert.equal(item.minimum, null);
  assert.equal(item.low, false);
  assert.equal(item.stale, true);
  assert.throws(
    () => movements(db, actor, randomUUID(), change(item, "2")),
    /Count this product/,
  );
  const current = count(db, item, "0").item;
  assert.equal(current.quantity, "0");
  assert.equal(current.low, true);
});
test("deliveries, waste, manual low and estimate flags follow café semantics", (t) => {
  const db = dbFor(t);
  let item = count(db, add(db), "0.3", { approx: true, low: true }).item;
  movements(db, staff, randomUUID(), change(item, "0.1", "WASTE"));
  item = catalog(db)[0];
  assert.equal(item.quantity, "0.2");
  assert.equal(item.accuracy, "ESTIMATED");
  assert.equal(item.manualLow, true);
  const checked = item.checkedAt;
  movements(db, staff, randomUUID(), change(item, "0.1"));
  item = catalog(db)[0];
  assert.equal(item.quantity, "0.3");
  assert.equal(item.checkedAt, checked);
  item = count(db, item, "0.3").item;
  assert.equal(item.accuracy, "EXACT");
  assert.equal(item.manualLow, false);
});
test("waste needs a reason and cannot overdraw stock", (t) => {
  const db = dbFor(t);
  const item = count(db, add(db), "1").item;
  assert.throws(() =>
    movements(db, actor, randomUUID(), {
      ...change(item, "1", "WASTE"),
      note: "",
    }),
  );
  assert.throws(
    () => movements(db, actor, randomUUID(), change(item, "2", "WASTE")),
    /Insufficient/,
  );
  assert.equal(catalog(db)[0].quantity, "1");
});
test("stale revisions and operation-ID reuse fail without changing stock", (t) => {
  const db = dbFor(t);
  const item = count(db, add(db), "2").item;
  const id = randomUUID();
  const body = change(item, "1");
  movements(db, actor, id, body);
  assert.equal(movements(db, actor, id, body).replayed, true);
  assert.throws(
    () => movements(db, actor, id, change(item, "2")),
    /REQUEST_ID_REUSED/,
  );
  assert.throws(
    () => movements(db, actor, randomUUID(), body),
    /Stock changed/,
  );
  assert.equal(catalog(db)[0].quantity, "3");
});
test("a failed item rolls back an entire session submission", (t) => {
  const db = dbFor(t);
  const a = add(db),
    b = add(db);
  const current = startSession(db, actor, randomUUID()).session;
  assert.throws(() =>
    submitSession(db, actor, randomUUID(), current.id, {
      version: current.version,
      items: [draft(a, "2"), draft(b, "-1")],
      incomplete: false,
      blankPolicy: "REQUIRE_ALL",
    }),
  );
  assert.equal(catalog(db).filter((item) => item.quantity !== null).length, 0);
  assert.equal(session(db, current.id).status, "OPEN");
  assert.equal(history(db).entries.length, 0);
});
test("blank counts require an explicit policy and never refresh physical-check timestamps", (t) => {
  const db = dbFor(t);
  const a = count(db, add(db), "4").item;
  const b = add(db);
  const current = startSession(db, actor, randomUUID()).session;
  assert.throws(
    () =>
      submitSession(db, actor, randomUUID(), current.id, {
        version: 1,
        items: [draft(b, "2")],
        incomplete: false,
        blankPolicy: "REQUIRE_ALL",
      }),
    /Count every item/,
  );
  const result = submitSession(db, actor, randomUUID(), current.id, {
    version: 1,
    items: [draft(b, "2")],
    incomplete: false,
    blankPolicy: "KEEP_CURRENT",
  });
  assert.equal(result.status, "COMPLETE_WITH_UNCHANGED");
  assert.equal(
    catalog(db).find((item) => item.id === a.id).checkedAt,
    a.checkedAt,
  );
});
test("inventory sessions are individual and session submission retries do not duplicate counts", (t) => {
  const db = dbFor(t);
  const item = add(db);
  const current = startSession(db, actor, randomUUID()).session;
  const body = {
    version: 1,
    items: [draft(item, "5")],
    blankPolicy: "REQUIRE_ALL",
    incomplete: false,
  };
  const id = randomUUID();
  assert.throws(
    () => submitSession(db, staff, id, current.id, body),
    /OWN_SESSION_ONLY/,
  );
  submitSession(db, actor, id, current.id, body);
  assert.equal(submitSession(db, actor, id, current.id, body).replayed, true);
  assert.equal(history(db).entries.length, 1);
});
test("all zone counts and configured sleeves contribute to one café total", (t) => {
  const db = dbFor(t);
  const item = add(db, {
    unit: "pcs",
    sleeve: 25,
    notes: "250 ml cups",
    zones: ["fridge", "shelf"],
  });
  const current = startSession(db, actor, randomUUID()).session;
  const body = {
    version: 1,
    blankPolicy: "REQUIRE_ALL",
    incomplete: false,
    items: [
      draft(item, "0", {
        locations: [{ zoneId: "fridge", value: "2", unit: "SLEEVE_25" }],
      }),
    ],
  };
  assert.throws(
    () => submitSession(db, actor, randomUUID(), current.id, body),
    /INCOMPLETE_ZONES/,
  );
  body.items[0].locations.push({ zoneId: "shelf", value: "3", unit: "BASE" });
  submitSession(db, actor, randomUUID(), current.id, body);
  assert.equal(catalog(db)[0].quantity, "53");
  assert.equal(history(db).entries[0].locations.length, 2);
});
test("catalog changes and counts commit atomically; activation must include a count", (t) => {
  const db = dbFor(t);
  const item = add(db);
  const off = add(db, { active: false });
  const current = startSession(db, actor, randomUUID()).session;
  const changes = [
    { id: off.id, version: off.version, active: true, zones: [] },
  ];
  const body = {
    version: 1,
    blankPolicy: "KEEP_CURRENT",
    incomplete: false,
    productChanges: changes,
    items: [draft(item, "2")],
  };
  assert.throws(
    () => submitSession(db, actor, randomUUID(), current.id, body),
    /ACTIVATION_REQUIRES_COUNT/,
  );
  assert.equal(catalog(db).find((row) => row.id === off.id).active, false);
  body.items.push(draft(off, "-1"));
  assert.throws(() => submitSession(db, actor, randomUUID(), current.id, body));
  assert.equal(catalog(db).find((row) => row.id === off.id).active, false);
  assert.equal(catalog(db).find((row) => row.id === item.id).quantity, null);
  body.items.pop();
  body.items.push(draft(off, "1"));
  submitSession(db, actor, randomUUID(), current.id, body);
  assert.equal(catalog(db).find((row) => row.id === off.id).active, true);
});
test("units cannot change with history and archival requires deactivation", (t) => {
  const db = dbFor(t);
  const item = count(db, add(db), "1").item;
  assert.throws(
    () =>
      saveProduct(db, actor, randomUUID(), {
        id: item.id,
        version: item.version,
        product: { ...item, unit: "l" },
      }),
    /UNIT_HAS_HISTORY/,
  );
  assert.throws(
    () =>
      saveProduct(db, actor, randomUUID(), {
        id: item.id,
        version: item.version,
        action: "archive",
      }),
    /DEACTIVATE/,
  );
  const off = saveProduct(db, actor, randomUUID(), {
    id: item.id,
    version: item.version,
    action: "active",
    active: false,
  }).product;
  saveProduct(db, actor, randomUUID(), {
    id: off.id,
    version: off.version,
    action: "archive",
  });
  assert.equal(catalog(db).length, 0);
  assert.equal(history(db).entries.length, 1);
});
test("history-only corrections preserve current stock; current corrections cannot overwrite newer movements", (t) => {
  const db = dbFor(t);
  const counted = count(db, add(db), "5");
  const event = db.prepare("SELECT * FROM varka_events").get();
  const body = {
    mode: "HISTORY_ONLY",
    reason: "Transcription error",
    parentId: null,
    changes: [
      { id: event.id, value: "4", version: hash(JSON.stringify(event)) },
    ],
  };
  const correction = correctSession(db, actor, randomUUID(), counted.sid, body);
  assert.equal(catalog(db)[0].quantity, "5");
  assert.equal(history(db).revisions.length, 1);
  assert.throws(
    () =>
      correctSession(db, staff, randomUUID(), counted.sid, {
        ...body,
        parentId: correction.id,
      }),
    /OWN_ENTRIES_ONLY/,
  );
  movements(db, actor, randomUUID(), change(catalog(db)[0], "1"));
  assert.throws(
    () =>
      correctSession(db, actor, randomUUID(), counted.sid, {
        ...body,
        mode: "CURRENT",
        parentId: correction.id,
      }),
    /newer movement/,
  );
  assert.equal(catalog(db)[0].quantity, "6");
});
test("current corrections append events and can be safely revised again", (t) => {
  const db = dbFor(t);
  const counted = count(db, add(db), "5");
  const event = db.prepare("SELECT * FROM varka_events").get();
  const body = {
    mode: "CURRENT",
    reason: "Recounted",
    parentId: null,
    changes: [
      { id: event.id, value: "4", version: hash(JSON.stringify(event)) },
    ],
  };
  const correction = correctSession(db, actor, randomUUID(), counted.sid, body);
  assert.equal(catalog(db)[0].quantity, "4");
  correctSession(db, actor, randomUUID(), counted.sid, {
    ...body,
    parentId: correction.id,
    changes: [{ ...body.changes[0], value: "3" }],
  });
  assert.equal(catalog(db)[0].quantity, "3");
  assert.equal(history(db).entries.length, 3);
});
test("reminders and cards enforce versions and keep attribution", (t) => {
  const db = dbFor(t);
  const noteId = randomUUID();
  saveReminder(db, actor, randomUUID(), {
    id: noteId,
    text: "Order beans",
    done: false,
  });
  const note = information(db).reminders[0];
  saveReminder(db, staff, randomUUID(), { ...note, done: true });
  assert.throws(
    () => saveReminder(db, actor, randomUUID(), { ...note, done: true }),
    /changed/,
  );
  saveCard(db, actor, randomUUID(), {
    id: "A1",
    action: "add",
    name: "Круассан",
    category: "A",
  });
  assert.equal(information(db).cards[0].author, actor.email);
  assert.equal(information(db).reminders[0].editor, staff.email);
});
test("notification settings are owner-only and deliveries are independent of commits", async (t) => {
  const db = dbFor(t);
  assert.throws(
    () =>
      saveSettings(db, staff, randomUUID(), {
        version: 1,
        enabled: true,
        mode: "ALL",
      }),
    /OWNER_ONLY/,
  );
  saveSettings(db, actor, randomUUID(), {
    version: 1,
    enabled: true,
    mode: "ALL",
  });
  const item = count(db, add(db), "3").item;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM varka_outbox").get().n, 1);
  const run = notificationWorker(db, {
    enabled: true,
    token: "test",
    chatId: "test",
    fetchImpl: async () => {
      throw new Error("connection lost");
    },
  });
  await run();
  const row = db.prepare("SELECT * FROM varka_outbox").get();
  assert.equal(row.status, "UNKNOWN");
  assert.equal(catalog(db)[0].quantity, item.quantity);
  await run();
  assert.equal(
    db.prepare("SELECT attempts FROM varka_outbox").get().attempts,
    1,
  );
  assert.throws(
    () => retryNotification(db, actor, randomUUID(), { id: row.id }),
    /Check Telegram/,
  );
  retryNotification(db, actor, randomUUID(), {
    id: row.id,
    acknowledgeDuplicateRisk: true,
  });
  await notificationWorker(db, {
    enabled: true,
    token: "test",
    chatId: "test",
    fetchImpl: async () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
  })();
  assert.equal(
    db.prepare("SELECT status FROM varka_outbox").get().status,
    "SENT",
  );
});
test("individual sessions are revoked on credential rotation and protect owner routes", async (t) => {
  const db = dbFor(t);
  provisionUser(db, { ...actor, code: "owner-test-code-1234" });
  provisionUser(db, { ...staff, code: "staff-test-code-1234" });
  const server = createApp({ db }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/varka`;
  assert.equal((await fetch(`${base}/bootstrap`)).status, 401);
  const login = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Inventory-Request": "1" },
    body: JSON.stringify({ email: staff.email, code: "staff-test-code-1234" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await fetch(`${base}/admin/users`, { headers: { Cookie: cookie } }))
      .status,
    403,
  );
  provisionUser(db, { ...staff, code: "rotated-staff-code-1234" });
  assert.equal(
    (await fetch(`${base}/bootstrap`, { headers: { Cookie: cookie } })).status,
    401,
  );
});

function sourceFixture() {
  const at = "2026-10-20T12:00:00.000Z";
  const event = Array(22).fill("");
  Object.assign(event, {
    0: "op-1:P001",
    1: at,
    2: "CHECK",
    3: "P001",
    4: "CAFE",
    6: "1.25",
    7: staff.email,
    8: "EXACT",
    9: "NO",
    11: "session-1",
    13: "kg",
    14: "Кофе",
    15: "Coffee",
    18: "hash",
    19: "SESSION_BATCH_ITEM",
    20: "2026-10-20T11:59:00.000Z",
    21: "Barista",
  });
  const batch = {
    version: 5,
    operationId: "V5BATCH:operation-1",
    sessionId: "session-1",
    requestHash: "hash",
    by: staff.email,
    submittedAt: at,
    status: "COMPLETE",
    missing: [],
    events: [event],
  };
  const json = JSON.stringify(batch);
  const envelope = [
    batch.operationId,
    at,
    "SESSION_BATCH",
    "",
    "CAFE",
    "",
    1,
    staff.email,
    "",
    "",
    json,
    "session-1",
    "",
    "",
    "",
    "",
    "",
    "hash",
    hash(json.replace(/[^\x00-\x7f]/gu, "?")),
    "V5_SESSION",
  ];
  const header = (name) => [name];
  return [
    {
      sheet: "Products",
      data: [
        header("ID"),
        [
          "P001",
          "Кофе",
          "Coffee",
          DEFAULT_CATEGORIES[0],
          "kg",
          "",
          "YES",
          "",
          24,
          "",
          "",
          "",
          "",
          "",
          "[]",
        ],
      ],
    },
    { sheet: "Events", data: [header("Event ID"), envelope] },
    {
      sheet: "CafeStock",
      data: [
        header("ID"),
        [
          "P001",
          "Кофе",
          "kg",
          "1.25",
          "SET MINIMUM",
          at,
          staff.email,
          "EXACT",
          at,
          "NO",
          "",
        ],
      ],
    },
    {
      sheet: "InventorySessions",
      data: [
        header("Operation ID"),
        [
          "session-1",
          at,
          staff.email,
          "START",
          "session-1",
          "",
          JSON.stringify({
            products: [
              {
                id: "P001",
                ru: "Кофе",
                en: "Coffee",
                unit: "kg",
                sleeve: false,
                zones: [],
              },
            ],
          }),
        ],
      ],
    },
  ];
}
test("legacy importer verifies original hashes, replays balances, and preserves all event rows", (t) => {
  const db = dbFor(t);
  const sheets = sourceFixture();
  const plan = inspectSheets(sheets, {
    fingerprint: "fixture",
    filename: "fixture.xlsx",
  });
  assert.equal(plan.report.reconciledBalances, 1);
  assert.equal(plan.report.legacyDigestBatches, 1);
  assert.equal(importWorkbook(db, plan).replayed, false);
  assert.equal(importWorkbook(db, plan).replayed, true);
  assert.equal(catalog(db)[0].quantity, "1.25");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM varka_events").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM varka_outbox").get().n, 0);
  assert.ok(
    db.prepare("SELECT COUNT(*) AS n FROM varka_legacy_rows").get().n > 0,
  );
});
test("tampered envelopes and mismatched materialized balances block migration", () => {
  const sheets = sourceFixture();
  sheets[1].data[1][10] += " ";
  assert.throws(() => inspectSheets(sheets), /checksum mismatch/);
  const wrong = sourceFixture();
  wrong[2].data[1][3] = "2";
  assert.throws(() => inspectSheets(wrong), /Balance mismatch/);
});
test("legacy dates distinguish Minsk wall-clock cells from ISO timestamps", () => {
  assert.equal(
    legacyDate(new Date("2026-10-20T15:00:00.000Z")),
    "2026-10-20T12:00:00.000Z",
  );
  assert.equal(
    legacyDate("2026-10-20T15:00:00.000Z"),
    "2026-10-20T15:00:00.000Z",
  );
});

test("expanding a legacy checklist does not rewrite the original START journal payload", (t) => {
  const db = dbFor(t);
  const sheets = sourceFixture();
  sheets[0].data.push([
    "P002",
    "Чай",
    "Tea",
    DEFAULT_CATEGORIES[0],
    "kg",
    "",
    "NO",
    "",
    24,
    "",
    "",
    "",
    "",
    "",
    "[]",
  ]);
  sheets[2].data.push([
    "P002",
    "Чай",
    "kg",
    "",
    "CHECK NEEDED",
    "",
    "",
    "",
    "",
    "NO",
    "",
  ]);
  const extra = {
    id: "P002",
    ru: "Чай",
    en: "Tea",
    unit: "kg",
    sleeve: false,
    zones: [],
  };
  sheets[3].data.push([
    "expand-1",
    "2026-10-20T12:00:00.000Z",
    staff.email,
    "EXPAND",
    "session-1",
    "",
    JSON.stringify({ products: [extra] }),
  ]);
  const plan = inspectSheets(sheets, { fingerprint: "expanded-fixture" });
  assert.equal(plan.sessions[0].snapshot.length, 2);
  assert.equal(plan.journal[0].payload.products.length, 1);
  importWorkbook(db, plan);
  assert.equal(
    JSON.parse(
      db
        .prepare(
          "SELECT payload FROM varka_session_journal WHERE action='START'",
        )
        .get().payload,
    ).products.length,
    1,
  );
});
