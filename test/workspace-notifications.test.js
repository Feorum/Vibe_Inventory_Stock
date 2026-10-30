import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../apps-script/WorkspaceNotifications.gs", import.meta.url),
  "utf8",
);
const clone = (value) => JSON.parse(JSON.stringify(value));
function harness(overrides = {}) {
  const properties = new Map(
    Object.entries({
      TELEGRAM_TOKEN: "private-test-token",
      TELEGRAM_CHAT_ID: "private-test-chat",
      WORKSPACE_INSTALLED: "1",
      PWA_WRITES_ENABLED: "true",
      ...overrides,
    }),
  );
  const operations = new Map();
  const reminderRows = [
    ["ID", "Count version", "State", "Operation ID", "Updated"],
  ];
  const triggers = [];
  const calls = [];
  let products = [];
  let locked = false;
  let nextResponse = () => ({
    getResponseCode: () => 200,
    getContentText: () =>
      JSON.stringify({ ok: true, result: { message_id: 101 } }),
  });
  const sheet = {
    getDataRange: () => ({ getValues: () => clone(reminderRows) }),
    appendRow: (row) => reminderRows.push(clone(row)),
    getRange: (row, column) => ({
      setValue: (value) => {
        reminderRows[row - 1][column - 1] = value;
      },
    }),
  };
  const context = vm.createContext({
    console,
    Map,
    Set,
    Date,
    JSON,
    prop_: () => ({ getProperty: (key) => properties.get(key) }),
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_algorithm, value) => [
        ...createHash("sha256").update(value, "utf8").digest(),
      ],
      formatDate: (value) => value.toISOString().replace("T", " ").slice(0, 16),
    },
    v3Lock_: (callback) => {
      assert.equal(locked, false, "must not reenter legacy lock");
      locked = true;
      try {
        return callback();
      } finally {
        locked = false;
      }
    },
    workspaceOperation_: (id) =>
      operations.has(id) ? clone(operations.get(id)) : null,
    workspaceWriteResult_: (operation, result) => {
      assert.equal(locked, true, "durable writes must be locked");
      operations.set(operation.id, clone({ ...operation, result }));
    },
    workspaceAppendOperation_: (id, actor, kind, hash, result) => {
      assert.equal(locked, true);
      const operation = { id, actor, kind, hash, result: clone(result) };
      operations.set(id, operation);
      return clone(operation);
    },
    workspaceProducts_: () => clone(products),
    UrlFetchApp: {
      fetch: (url, options) => {
        assert.equal(
          locked,
          false,
          "external Telegram request must not hold write lock",
        );
        calls.push({ url, options });
        const op = [...operations.values()].find(
          (operation) => operation.result.notification.status === "UNKNOWN",
        );
        assert.ok(op, "UNKNOWN reservation must be durable before sending");
        return nextResponse();
      },
    },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      newTrigger: (name) => ({
        timeBased: () => ({
          everyHours: (hours) => ({
            create: () => {
              assert.equal(hours, 1);
              triggers.push({ getHandlerFunction: () => name });
            },
          }),
        }),
      }),
    },
    v4Owner_: () => {},
    book_: () => ({
      getSheetByName: (name) => (name === "WorkspaceReminders" ? sheet : null),
    }),
    SpreadsheetApp: { flush() {} },
  });
  vm.runInContext(source, context);
  return {
    context,
    calls,
    operations,
    properties,
    reminderRows,
    triggers,
    setProducts: (value) => {
      products = value;
    },
    setResponse: (callback) => {
      nextResponse = callback;
    },
    seed: (request, result, snapshot) => {
      const notification = context.workspaceNotification_(
        request,
        result,
        snapshot,
        "staff@example.test",
      );
      operations.set(
        request.id,
        clone({
          id: request.id,
          actor: "staff@example.test",
          kind: "count",
          result: { state: "COMMITTED", ...result, notification },
        }),
      );
      return clone(notification);
    },
  };
}

const products = [
  {
    id: "P001",
    ru: "Молоко",
    en: "Milk",
    unit: "l",
    active: true,
    last: "5.12345678",
    lastCountedAt: "2026-01-01T10:00:00Z",
    low: false,
  },
  {
    id: "P002",
    ru: "Чашки",
    en: "Cups",
    unit: "pcs",
    active: false,
    last: "0",
    lastCountedAt: "2026-01-02T10:00:00Z",
    low: true,
  },
  {
    id: "P003",
    ru: "Кофе",
    en: "Coffee",
    unit: "kg",
    active: true,
    last: null,
    lastCountedAt: null,
    low: false,
  },
];
const result = {
  accepted: [
    {
      id: "P001",
      last: "2.5",
      lastCountedAt: "2026-01-03T10:00:00Z",
      approx: true,
      low: false,
    },
  ],
};
const request = (scope = "ALL", language = "en") => ({
  id: "count-1234567890123456",
  notification: { scope, language, lowIds: ["P003"] },
});

test("workspace Telegram scopes use full catalog, accepted recounts, and immutable manual Low snapshot", () => {
  const h = harness();
  const all = h.seed(request(), result, products).messages.join("\n");
  assert.match(all, /P001 · Milk \[Approximate\]\nFresh recount: 2.5 l/);
  assert.match(all, /P002 · Cups \[Inactive\]\nPreviously recorded: 0 pcs/);
  assert.match(all, /P003 · Coffee \[Low\]\nNot counted/);
  assert.doesNotMatch(all, /Cups \[Inactive, Low/);
  const entered = h
    .seed(request("ENTERED"), result, products)
    .messages.join("\n");
  assert.match(entered, /P001/);
  assert.doesNotMatch(entered, /P002|P003/);
  const low = h.seed(request("LOW"), result, products).messages.join("\n");
  assert.match(low, /P003 · Coffee \[Low\]/);
  assert.doesNotMatch(low, /P001|P002/);
  assert.equal(result.accepted[0].last, "2.5");
});

test("workspace Russian Telegram text is consistent and preserves decimals/user content", () => {
  const h = harness();
  const text = h
    .seed(request("ALL", "ru"), result, products)
    .messages.join("\n");
  assert.match(text, /Остатки\nВесь каталог/);
  assert.match(text, /Молоко \[Примерно\]\nПересчитано сейчас: 2,5 л/);
  assert.match(text, /Чашки \[Неактивный\]\nРанее записано: 0 шт\./);
  assert.match(text, /Кофе \[Мало\]\nНе пересчитано/);
  assert.doesNotMatch(
    text,
    /Fresh|Previously|Inactive|Low|Last recount|Entire/,
  );
  const uncountedAccepted = { accepted: [] };
  const previous = h
    .seed(request("ALL", "ru"), uncountedAccepted, products)
    .messages.join("\n");
  assert.match(previous, /5,12345678 л/);
});

test("workspace Telegram chunks stay within safe limits and retain every product", () => {
  const h = harness();
  const catalog = Array.from({ length: 150 }, (_, i) => ({
    ...products[0],
    id: "P" + i,
    ru: "Очень длинное название ".repeat(6),
    en: "Long product name ".repeat(6),
  }));
  const notification = h.seed(request(), { accepted: [] }, catalog);
  assert.ok(notification.messages.length > 1);
  assert.ok(notification.messages.every((text) => text.length <= 3500));
  const combined = notification.messages.join("\n");
  for (const product of catalog)
    assert.match(combined, new RegExp(product.id + " ·"));
});

test("workspace confirmed Telegram delivery is persisted once and cannot be duplicated by retry", () => {
  const h = harness();
  h.seed(request(), result, products);
  assert.equal(
    h.context.workspaceDeliver_(request().id, "staff@example.test").status,
    "SENT",
  );
  assert.equal(
    h.context.workspaceDeliver_(request().id, "staff@example.test").status,
    "SENT",
  );
  assert.equal(h.calls.length, 1);
  const op = h.operations.get(request().id);
  assert.equal(op.result.notification.delivery[0].messageId, 101);
  assert.ok(h.calls[0].url.includes("private-test-token"));
});

test("workspace known rejection supports notification-only retry without altering saved inventory", () => {
  const h = harness();
  h.seed(request(), result, products);
  h.setResponse(() => ({
    getResponseCode: () => 429,
    getContentText: () => JSON.stringify({ ok: false, error_code: 429 }),
  }));
  assert.equal(
    h.context.workspaceDeliver_(request().id, "staff@example.test").status,
    "FAILED",
  );
  assert.deepEqual(
    h.operations.get(request().id).result.accepted,
    result.accepted,
  );
  h.setResponse(() => ({
    getResponseCode: () => 200,
    getContentText: () =>
      JSON.stringify({ ok: true, result: { message_id: 102 } }),
  }));
  assert.equal(
    h.context.workspaceDeliver_(request().id, "staff@example.test").status,
    "SENT",
  );
  assert.equal(h.calls.length, 2);
  assert.deepEqual(
    h.operations.get(request().id).result.accepted,
    result.accepted,
  );
});

test("workspace timeout and ambiguous server failures remain UNKNOWN and never auto-repeat", () => {
  for (const response of [
    () => {
      throw Error(
        "network timeout https://api.telegram.org/botprivate-test-token",
      );
    },
    () => ({
      getResponseCode: () => 500,
      getContentText: () => JSON.stringify({ ok: false }),
    }),
    () => ({
      getResponseCode: () => 200,
      getContentText: () => "invalid reply",
    }),
  ]) {
    const h = harness();
    h.seed(request(), result, products);
    h.setResponse(response);
    const outcome = h.context.workspaceDeliver_(
      request().id,
      "staff@example.test",
    );
    assert.equal(outcome.status, "UNKNOWN");
    assert.equal(outcome.error, "TELEGRAM_DELIVERY_UNKNOWN");
    assert.ok(!JSON.stringify(outcome).includes("private-test-token"));
    assert.equal(
      h.context.workspaceDeliver_(request().id, "staff@example.test").status,
      "UNKNOWN",
    );
    assert.equal(h.calls.length, 1);
  }
});

test("workspace Telegram checks operation ownership and credentials before sending", () => {
  const h = harness({ TELEGRAM_TOKEN: "" });
  assert.equal(h.seed(request(), result, products).status, "NOT_CONFIGURED");
  assert.throws(
    () => h.context.workspaceDeliver_(request().id, "other@example.test"),
    /OPERATION_NOT_FOUND/,
  );
  assert.equal(
    h.context.workspaceDeliver_(request().id, "staff@example.test").status,
    "NOT_CONFIGURED",
  );
  assert.equal(h.calls.length, 0);
  h.properties.set("TELEGRAM_TOKEN", "new-private-token");
  assert.equal(
    h.context.workspaceDeliver_(request().id, "staff@example.test").status,
    "SENT",
  );
  assert.equal(h.calls.length, 1);
});

test("workspace Telegram cannot start before inventory is confirmed committed", () => {
  const h = harness();
  h.seed(request(), { ...result, state: "PREPARED" }, products);
  assert.throws(
    () => h.context.workspaceDeliver_(request().id, "staff@example.test"),
    /INVENTORY_NOT_CONFIRMED/,
  );
  assert.equal(h.calls.length, 0);
});

test("workspace multipart retry never resends previously acknowledged message chunks", () => {
  const h = harness();
  const catalog = Array.from({ length: 100 }, (_, i) => ({
    ...products[0],
    id: "P" + i,
    en: "Long product name ".repeat(6),
  }));
  const notification = h.seed(request(), { accepted: [] }, catalog);
  let attempt = 0;
  h.setResponse(() => {
    attempt++;
    return attempt === 2
      ? {
          getResponseCode: () => 429,
          getContentText: () => JSON.stringify({ ok: false }),
        }
      : {
          getResponseCode: () => 200,
          getContentText: () =>
            JSON.stringify({ ok: true, result: { message_id: 100 + attempt } }),
        };
  });
  assert.equal(
    h.context.workspaceDeliver_(request().id, "staff@example.test").status,
    "FAILED",
  );
  assert.equal(
    h.context.workspaceDeliver_(request().id, "staff@example.test").status,
    "SENT",
  );
  assert.equal(h.calls.length, notification.messages.length + 1);
  assert.notEqual(h.calls[0].options.payload, h.calls[2].options.payload);
});

test("workspace reminders install once and exclude Off, inactive, future and never-counted products", () => {
  const h = harness();
  assert.equal(h.context.installWorkspaceReminders().configured, true);
  assert.equal(h.context.installWorkspaceReminders().configured, true);
  assert.equal(h.triggers.length, 1);
  h.setProducts([
    { ...products[0], reminderHours: null },
    { ...products[1], reminderHours: 1 },
    { ...products[2], reminderHours: 1 },
    {
      ...products[0],
      id: "future",
      reminderHours: 1,
      lastCountedAt: new Date(Date.now() + 86400000).toISOString(),
    },
  ]);
  assert.equal(h.context.workspaceReminderTick().processed, 0);
  assert.equal(h.calls.length, 0);
});

test("workspace reminder fires only once per successful recount, including same quantity recount", () => {
  const h = harness();
  const due = { ...products[0], reminderHours: 1, stockVersion: "stock-a" };
  h.setProducts([due]);
  assert.equal(h.context.workspaceReminderTick().processed, 1);
  assert.match(JSON.parse(h.calls[0].options.payload).text, /Recount due/);
  assert.match(
    JSON.parse(h.calls[0].options.payload).text,
    /Previously recorded/,
  );
  assert.equal(h.context.workspaceReminderTick().processed, 0);
  h.setProducts([
    { ...due, ru: "Updated catalog name", stockVersion: "movement-b" },
  ]);
  assert.equal(h.context.workspaceReminderTick().processed, 0);
  assert.equal(h.calls.length, 1);
  h.setProducts([
    {
      ...due,
      lastCountedAt: "2026-01-04T10:00:00Z",
      stockVersion: "recount-b",
    },
  ]);
  assert.equal(h.context.workspaceReminderTick().processed, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.reminderRows.length, 3);
});

test("workspace ambiguous reminders are not repeated and missing setup sends nothing", () => {
  const h = harness();
  h.setProducts([{ ...products[0], reminderHours: 1 }]);
  h.setResponse(() => {
    throw Error("timeout");
  });
  assert.equal(
    h.context.workspaceReminderTick().results[0].notification.status,
    "UNKNOWN",
  );
  assert.equal(h.context.workspaceReminderTick().processed, 0);
  assert.equal(h.calls.length, 1);
  h.properties.set("WORKSPACE_INSTALLED", "");
  assert.equal(h.context.workspaceReminderTick(), undefined);
  assert.equal(h.calls.length, 1);
});

test("workspace reminder identity uses recount ID rather than wall-clock or movement version", () => {
  const h = harness();
  const due = {
    ...products[0],
    reminderHours: 1,
    lastCountId: "count-a:P001",
    stockVersion: "v1",
  };
  h.setProducts([due]);
  assert.equal(h.context.workspaceReminderTick().processed, 1);
  h.setProducts([{ ...due, stockVersion: "v2" }]);
  assert.equal(h.context.workspaceReminderTick().processed, 0);
  h.setProducts([{ ...due, lastCountId: "count-b:P001", stockVersion: "v3" }]);
  assert.equal(h.context.workspaceReminderTick().processed, 1);
  assert.equal(h.calls.length, 2);
});

test("workspace reminder delivery rechecks recount identity, activity and interval after preparation", () => {
  const original = {
    ...products[0],
    reminderHours: 1,
    lastCountId: "count-a:P001",
  };
  for (const changed of [
    { ...original, active: false },
    { ...original, reminderHours: null },
    { ...original, lastCountId: "count-b:P001" },
    { ...original, lastCountedAt: new Date().toISOString() },
  ]) {
    const h = harness();
    const notification = h.context.workspaceNotification_(
      request(),
      result,
      products,
      "system:reminders",
    );
    h.operations.set("reminder-test", {
      id: "reminder-test",
      actor: "system:reminders",
      kind: "reminder",
      result: {
        reminder: {
          productId: original.id,
          countVersion: original.lastCountId,
        },
        notification,
      },
    });
    h.setProducts([changed]);
    assert.equal(
      h.context.workspaceDeliver_("reminder-test", "system:reminders", true)
        .status,
      "DEFERRED",
    );
    assert.equal(h.calls.length, 0);
  }
});
