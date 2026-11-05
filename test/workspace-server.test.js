import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

const source = await readFile(
  new URL("../apps-script/Workspace.gs", import.meta.url),
  "utf8",
);
const notificationSource = await readFile(
  new URL("../apps-script/WorkspaceNotifications.gs", import.meta.url),
  "utf8",
);
const copy = (value) => JSON.parse(JSON.stringify(value));
const reordered = (value) =>
  Array.isArray(value)
    ? value.map(reordered)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .reverse()
            .map((key) => [key, reordered(value[key])]),
        )
      : value;
function database({ count = 2, baseline = {} } = {}) {
  const sheets = new Map(),
    properties = new Map([["PWA_WRITES_ENABLED", "true"]]);
  let fail = () => {},
    locked = false,
    backups = 0;
  const range = (sheet, row, column, height = 1, width = 1) => ({
    getValues: () =>
      Array.from({ length: height }, (_, i) =>
        Array.from(
          { length: width },
          (_, j) => sheet.values[row - 1 + i]?.[column - 1 + j] ?? "",
        ),
      ),
    setValues(values) {
      for (let i = 0; i < height; i++)
        for (let j = 0; j < width; j++) {
          sheet.values[row - 1 + i] ||= [];
          sheet.values[row - 1 + i][column - 1 + j] = values[i][j];
        }
      fail(sheet.name, "set");
      return this;
    },
    setValue(value) {
      return this.setValues([[value]]);
    },
    setFontWeight() {
      return this;
    },
    setBackground() {
      return this;
    },
  });
  const add = (name, values = []) => {
    const sheet = {
      name,
      values,
      getDataRange: () => ({ getValues: () => copy(sheet.values) }),
      getRange: (r, c, h, w) => range(sheet, r, c, h, w),
      getLastRow: () => sheet.values.length,
      setFrozenRows() {},
      appendRow(value) {
        sheet.values.push(copy(value));
        fail(name, "append");
        return sheet;
      },
    };
    sheets.set(name, sheet);
    return sheet;
  };
  add("Products", [
    [
      "ID",
      "RU",
      "EN",
      "Category",
      "Unit",
      "Sleeve",
      "Active",
      "Minimum",
      "Hours",
      "Notes",
      "",
      "Create",
      "Mutation",
      "Archived",
      "Zones JSON",
    ],
    ...Array.from({ length: count }, (_, i) => [
      "P" + String(i + 1).padStart(3, "0"),
      "Товар " + i,
      "Product " + i,
      "Milk",
      "l",
      "",
      "YES",
      "",
      24,
      "",
      "",
      "",
      "",
      "",
      '["fridge","shelf"]',
    ]),
  ]);
  add("Events", [Array.from({ length: 22 }, (_, i) => "Event " + i)]);
  add("UserProfiles", [
    ["Email", "Name", "Updated at"],
    ["staff@example.test", "Staff", "2026-10-30"],
  ]);
  add("Reminders", [
    [
      "ID",
      "Text",
      "Status",
      "Created at",
      "Updated at",
      "Author",
      "Last editor",
      "Author name",
    ],
  ]);
  add("YellowCards", [
    [
      "Code",
      "Name",
      "Size",
      "Category",
      "Source note",
      "Needed",
      "Updated at",
      "Updated by",
      "Active",
      "Author name",
      "Card operation",
    ],
    [
      "A1",
      "Original card",
      "",
      "A",
      "",
      "NO",
      "2026-10-30",
      "owner@example.test",
      "YES",
      "Owner",
      "original-operation",
    ],
  ]);
  const book = {
    getSheetByName: (name) => sheets.get(name),
    insertSheet: (name) => add(name),
    getId: () => "safe-test-database",
    copy: () => {
      backups++;
      return { getId: () => "safe-backup" };
    },
  };
  const context = vm.createContext({
    console,
    Map,
    Set,
    Date,
    BigInt: undefined, // Apps Script compatibility: no constructor dependency.
    book_: () => book,
    prop_: () => ({
      getProperty: (key) => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value),
    }),
    v4Owner_: () => "owner@example.test",
    v10CanManage_: (email) => email === "owner@example.test",
    v3Lock_: (callback) => {
      assert.equal(locked, false, "nested lock");
      locked = true;
      try {
        return callback();
      } finally {
        locked = false;
      }
    },
    v3Sheet_: (name, headers) => sheets.get(name) || add(name, [headers]),
    v3Cell_: (value) => (/^[=+@-]/.test(String(value)) ? "'" + value : value),
    v8ProductZones_: (p) => (p[14] ? JSON.parse(p[14]).sort() : []),
    v8Zones_: () => [
      { id: "fridge", ru: "Холодильник", en: "Fridge" },
      { id: "shelf", ru: "Полка", en: "Shelf" },
    ],
    v9MaterializeProducts_: () => {},
    baselines_: () => copy(baseline),
    webHash_: (value) =>
      createHash("sha256").update(String(value)).digest("hex"),
    webAuth_: (token) => {
      if (!["staff", "other", "owner"].includes(token))
        throw Error("SIGN_IN_REQUIRED");
      return `${token}@example.test`;
    },
    webLogin: (email, password) => {
      if (password !== "safe-test-code") throw Error("Invalid sign-in");
      return { email, token: "staff" };
    },
    SpreadsheetApp: { flush() {} },
    ScriptApp: { getProjectTriggers: () => [] },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_, value) => [
        ...createHash("sha256").update(value).digest(),
      ],
      getUuid: randomUUID,
      formatDate: (date) => date.toISOString(),
    },
  });
  // Native ledger expansion/replay functions copied from the original Apps
  // Script, so these tests inspect the actual legacy Events row protocol.
  vm.runInContext(
    `
    function v8ExpandBatch_(b){if(b.compactDefaults)b.events.forEach(e=>{if(!e[0])e[0]=b.operationId+':'+e[3];if(!e[1])e[1]=b.submittedAt;if(!e[7])e[7]=b.by;if(!e[11])e[11]=b.sessionId;if(!e[18])e[18]=b.requestHash;if(!e[19])e[19]='SESSION_BATCH_ITEM';if(!e[21])e[21]=v3Cell_(b.authorName||'Anonymous');});return b;}
    function v5Decode_(r){try{if(!String(r[0]).startsWith('V5BATCH:')||r[2]!=='SESSION_BATCH'||r[19]!=='V5_SESSION'||webHash_(String(r[10]))!==r[18])return null;const b=JSON.parse(r[10]);if((b.version!==5&&b.version!==8&&b.version!==9)||b.operationId!==r[0]||b.sessionId!==r[11]||b.requestHash!==r[17]||!Array.isArray(b.events)||b.events.length!==Number(r[6]))return null;return v8ExpandBatch_(b);}catch(e){return null;}}
    function rows_(n){const raw=book_().getSheetByName(n).getDataRange().getValues().slice(1).filter(r=>r[0]);return n==='Events'?raw.flatMap(r=>String(r[0]).startsWith('V5BATCH:')?(v5Decode_(r)?.events||[]):[r]):raw;}
    function totalState_(events,baselines){const m=JSON.parse(JSON.stringify(baselines||{}));for(const e of events){if(e[4]!=='CAFE')continue;const a=m[e[3]]||(m[e[3]]={q:null,checked:null,by:'',quality:'',low:false,last:null,note:''});const q=Number(e[6]);if(e[2]==='CHECK'){a.q=q;a.checked=e[1];a.by=e[7];a.quality=e[8];a.low=e[9]==='YES';a.note=e[10]||'';}else if(e[2]==='RECEIVE'&&a.q!==null)a.q+=q;else if(e[2]==='WASTE'&&a.q!==null)a.q-=q;else continue;if(e[8]==='ESTIMATED')a.quality='ESTIMATED';if(e[9]==='YES')a.low=true;a.last=e[1];}return m;}
  `,
    context,
  );
  vm.runInContext(source + "\n" + notificationSource, context);
  const call = (method, body = {}, token = "staff") =>
    copy(context.workspaceDispatch_(method, token, body));
  context.installWorkspace();
  const load = () => call("workspaceLoad");
  const item = (p, value = "0") => ({
    id: p.id,
    stockVersion: p.stockVersion,
    countVersion: p.countVersion,
    catalogVersion: p.catalogVersion,
    editVersion: randomUUID(),
    approx: false,
    low: false,
    locations: [
      { zoneId: "fridge", value, unit: "BASE" },
      { zoneId: "shelf", value: "0", unit: "BASE" },
    ],
  });
  const countRequest = (items, scope = "ENTERED") => ({
    id: randomUUID(),
    items,
    notification: { scope, language: "en", lowIds: [] },
  });
  return {
    context,
    sheets,
    properties,
    call,
    load,
    item,
    countRequest,
    backups: () => backups,
    fault: (fn) => {
      fail = fn;
    },
  };
}

test("workspace additive migration backs up once and preserves all legacy sheets", () => {
  const db = database();
  const before = copy(db.sheets.get("Products").values),
    cards = copy(db.sheets.get("YellowCards").values);
  db.context.installWorkspace();
  assert.equal(db.backups(), 1);
  assert.deepEqual(db.sheets.get("Products").values, before);
  assert.deepEqual(db.sheets.get("YellowCards").values, cards);
  assert.ok(db.sheets.has("WorkspaceOperationParts"));
});

test("workspace migration refuses incomplete legacy tables before creating another backup or writing", () => {
  for (const name of [
    "Products",
    "Events",
    "UserProfiles",
    "Reminders",
    "YellowCards",
  ]) {
    const db = database();
    const sheet = db.sheets.get(name);
    sheet.values[0] = sheet.values[0].slice(0, -1);
    db.properties.delete("WORKSPACE_BACKUP_ID");
    const before = copy([...db.sheets.values()].map((s) => s.values));
    assert.throws(
      () => db.context.installWorkspace(),
      /WORKSPACE_LEGACY_SCHEMA_MISSING/,
    );
    assert.equal(db.backups(), 1);
    assert.deepEqual(
      copy([...db.sheets.values()].map((s) => s.values)),
      before,
    );
  }
});
test("workspace login delegates existing secrets, auth guards every method, missing name stays missing", () => {
  const db = database();
  assert.equal(
    db.call("workspaceLogin", {
      username: "staff@example.test",
      password: "safe-test-code",
    }).token,
    "staff",
  );
  assert.throws(
    () => db.call("workspaceLogin", { username: "x", password: "bad" }),
    /INVALID_LOGIN/,
  );
  assert.throws(() => db.call("workspaceLoad", {}, "bad"), /SIGN_IN_REQUIRED/);
  assert.equal(db.call("workspaceLoad", {}, "other").profile.name, null);
  assert.equal(
    JSON.stringify([...db.sheets.values()].map((s) => s.values)).includes(
      "safe-test-code",
    ),
    false,
  );
});
test("workspace exposes the configured café timezone without adding or changing inventory dates", () => {
  const db = database();
  const original = copy([...db.sheets.values()].map((sheet) => sheet.values));
  assert.equal(db.load().timeZone, "Europe/Minsk");
  assert.deepEqual(db.load().features, {
    unitRecount: true,
    fractionalPieces: true,
    expirationWarning: true,
  });
  db.properties.set("CAFE_TIMEZONE", "America/New_York");
  const loaded = db.load();
  assert.equal(loaded.timeZone, "America/New_York");
  assert.ok(loaded.products.every((product) => product.lastCountedAt === null));
  assert.deepEqual(
    copy([...db.sheets.values()].map((sheet) => sheet.values)),
    original,
  );
});
test("historical count dates change only for acknowledged products, not failed counts, edits, refreshes or Telegram", () => {
  const oldDate = "2020-01-01T12:00:00.000Z";
  const db = database({
    baseline: {
      P001: { q: 3, checked: oldDate, quality: "EXACT", low: false },
      P002: { q: 4, checked: oldDate, quality: "EXACT", low: false },
    },
  });
  const original = db.load().products;
  const result = db.call(
    "workspaceCount",
    db.countRequest([db.item(original[0], "0"), db.item(original[1], "-1")]),
  );
  assert.equal(result.accepted.length, 1);
  assert.equal(result.failed.length, 1);
  const saved = db.load().products;
  assert.notEqual(saved[0].lastCountedAt, oldDate);
  assert.equal(saved[0].lastCountedAt, result.accepted[0].lastCountedAt);
  assert.equal(saved[1].lastCountedAt, oldDate);
  assert.equal(saved[0].lastLocations.length, 2);
  assert.ok(
    saved[0].lastLocations.every(
      (location) => !Object.hasOwn(location, "lastCountedAt"),
    ),
  );
  db.call("workspaceCatalog", {
    id: randomUUID(),
    action: "save",
    product: { ...saved[0], ru: "Renamed", minimum: 9 },
  });
  db.call("workspaceNotify", { id: result.id }); // Not configured: no HTTP call.
  const refreshed = db.load().products;
  assert.equal(refreshed[0].lastCountedAt, saved[0].lastCountedAt);
  assert.equal(refreshed[1].lastCountedAt, oldDate);
});
test("zero, comma decimals and flags save only explicitly completed zone counts", () => {
  const db = database(),
    products = db.load().products,
    a = db.item(products[0], "0"),
    b = db.item(products[1], "1,25");
  b.approx = true;
  b.low = true;
  const result = db.call("workspaceCount", db.countRequest([a, b]));
  assert.equal(result.accepted.length, 2);
  assert.equal(result.accepted[0].last, 0);
  assert.equal(result.accepted[1].last, 1.25);
  const loaded = db.load().products;
  assert.equal(loaded[1].approx, true);
  assert.equal(loaded[1].low, true);
  assert.equal(result.accepted[0].stockVersion, loaded[0].stockVersion);
  assert.equal(result.accepted[1].stockVersion, loaded[1].stockVersion);
});
test("blank, invalid, negative, missing zone and invalid decimal precision fail per item", () => {
  for (const value of [
    "",
    "-1",
    "NaN",
    "1e2",
    "1.123456789",
    "999999999.00000001",
  ]) {
    const db = database(),
      p = db.load().products[0],
      request = db.countRequest([db.item(p, value)]);
    const result = db.call("workspaceCount", request);
    assert.equal(result.failed.length, 1, value);
    assert.equal(db.load().products[0].last, null);
  }
  const db = database(),
    item = db.item(db.load().products[0]);
  item.locations.pop();
  assert.equal(
    db.call("workspaceCount", db.countRequest([item])).failed[0].error,
    "INVALID_ZONES",
  );
});
test("flags-only snapshot not a count; minimum does not imply manual Low", () => {
  const db = database(),
    request = db.countRequest([], "LOW");
  request.notification.lowIds = ["P001"];
  const result = db.call("workspaceCount", request);
  assert.equal(result.accepted.length, 0);
  assert.equal(db.sheets.get("Events").values.length, 1);
  assert.equal(db.load().products[0].lastCountedAt, null);
});
test("concurrent users count same stock: first accepted, stale second conflicted, unaffected items accepted", () => {
  const db = database(),
    original = db.load().products;
  db.call("workspaceCount", db.countRequest([db.item(original[0], "2")]));
  const result = db.call(
    "workspaceCount",
    db.countRequest([db.item(original[0], "4"), db.item(original[1], "5")]),
    "other",
  );
  assert.equal(result.accepted[0].id, "P002");
  assert.equal(result.conflicted[0].id, "P001");
  assert.equal(db.load().products[0].last, 2);
});
test("catalog metadata edit and count remain independent; stale catalog edits conflict", () => {
  const db = database(),
    original = db.load().products[0],
    request = {
      id: randomUUID(),
      action: "save",
      product: { ...original, ru: "Renamed", reminderHours: null },
    };
  const updated = db.call("workspaceCatalog", request).product;
  assert.notEqual(updated.catalogVersion, original.catalogVersion);
  assert.equal(updated.countVersion, original.countVersion);
  assert.equal(updated.stockVersion, original.stockVersion);
  db.call("workspaceCount", db.countRequest([db.item(original, "3")]));
  assert.equal(db.load().products[0].ru, "Renamed");
  assert.equal(db.load().products[0].last, 3);
  assert.throws(
    () => db.call("workspaceCatalog", { ...request, id: randomUUID() }),
    /CATALOG_CONFLICT/,
  );
});
test("count first does not stale metadata version or permit metadata write to overwrite stock", () => {
  const db = database(),
    original = db.load().products[0];
  db.call("workspaceCount", db.countRequest([db.item(original, "7")]));
  db.call("workspaceCatalog", {
    id: randomUUID(),
    action: "save",
    product: { ...original, ru: "After count" },
  });
  const p = db.load().products[0];
  assert.equal(p.last, 7);
  assert.equal(p.ru, "After count");
});
test("inactive products deliberately count; remote deactivation and deletion block stale drafts", () => {
  const db = database(),
    original = db.load().products[0];
  const inactive = db.call("workspaceCatalog", {
    id: randomUUID(),
    action: "status",
    product: {
      id: original.id,
      catalogVersion: original.catalogVersion,
      active: false,
    },
  }).product;
  assert.equal(
    db.call("workspaceCount", db.countRequest([db.item(original)]))
      .conflicted[0].error,
    "PRODUCT_CHANGED",
  );
  assert.equal(
    db.call("workspaceCount", db.countRequest([db.item(inactive)])).accepted
      .length,
    1,
  );
  db.call("workspaceCatalog", {
    id: randomUUID(),
    action: "delete",
    product: inactive,
  });
  assert.equal(
    db.call("workspaceCount", db.countRequest([db.item(inactive)]))
      .conflicted[0].error,
    "PRODUCT_DELETED",
  );
  assert.throws(
    () =>
      db.call("workspaceCatalog", {
        id: randomUUID(),
        action: "save",
        product: original,
      }),
    /PRODUCT_DELETED/,
  );
  assert.equal(db.sheets.get("Products").values[1][13], "YES");
});
test("same-quantity recount refreshes successful recount identity, catalog/refresh do not", () => {
  const db = database();
  const first = db.call(
    "workspaceCount",
    db.countRequest([db.item(db.load().products[0], "1")]),
  );
  const p = db.load().products[0];
  db.call("workspaceCatalog", {
    id: randomUUID(),
    action: "save",
    product: { ...p, minimum: 2 },
  });
  assert.equal(
    db.load().products[0].lastCountId,
    first.accepted[0].lastCountId,
  );
  const second = db.call(
    "workspaceCount",
    db.countRequest([db.item(db.load().products[0], "1")]),
  );
  assert.notEqual(
    second.accepted[0].lastCountId,
    first.accepted[0].lastCountId,
  );
});
test("committed count retries use same result; actor/body reuse rejected", () => {
  const db = database(),
    request = db.countRequest([db.item(db.load().products[0])]);
  const result = db.call("workspaceCount", request);
  assert.deepEqual(db.call("workspaceCount", request), result);
  assert.equal(db.sheets.get("Events").values.length, 2);
  assert.throws(
    () => db.call("workspaceCount", request, "other"),
    /REQUEST_ID_REUSED/,
  );
  assert.throws(
    () => db.call("workspaceCount", { ...request, items: [] }),
    /REQUEST_ID_REUSED/,
  );
  assert.throws(
    () => db.call("workspaceStatus", { id: request.id }, "other"),
    /OWN_OPERATION_ONLY/,
  );
});
test("request identity canonicalizes only JSON object order and keeps revision hashes unchanged", () => {
  const db = database();
  const request = { z: [{ b: "1", a: 1 }], a: false };
  const expected = createHash("sha256")
    .update('{"a":false,"z":[{"a":1,"b":"1"}]}')
    .digest("hex");
  assert.equal(db.context.workspaceRequestHash_(request), expected);
  assert.equal(db.context.workspaceRequestHash_(reordered(request)), expected);
  assert.notEqual(
    db.context.workspaceHash_(request),
    db.context.workspaceHash_(reordered(request)),
    "the general revision/envelope hash must retain its existing behavior",
  );
  assert.notEqual(
    db.context.workspaceRequestHash_({ a: [1, 2] }),
    db.context.workspaceRequestHash_({ a: [2, 1] }),
  );
  assert.notEqual(
    db.context.workspaceRequestHash_({ a: 1 }),
    db.context.workspaceRequestHash_({ a: "1" }),
  );
  assert.notEqual(
    db.context.workspaceRequestHash_(
      JSON.parse('{"__proto__":{"a":1},"x":2}'),
    ),
    db.context.workspaceRequestHash_({ x: 2 }),
    "all JSON property names remain part of the identity",
  );
});
test("new counts replay after RPC key reordering while changed values and array order stay rejected", () => {
  const db = database();
  const request = db.countRequest(
    db.load().products.map((product) => ({
      ...db.item(product, "1.25"),
      expirationWarning: false,
      countedAt: "2026-11-05T10:00:00.000Z",
    })),
  );
  request.summary = { entered: 2, uncounted: 0, low: 0 };
  const result = db.call("workspaceCount", request);
  const before = copy([...db.sheets.values()].map((sheet) => sheet.values));
  assert.deepEqual(db.call("workspaceCount", reordered(request)), result);
  assert.deepEqual(
    copy([...db.sheets.values()].map((sheet) => sheet.values)),
    before,
  );
  for (const change of [
    (body) => {
      body.items[0].locations[0].value = "2";
    },
    (body) => {
      body.items[0].approx = true;
    },
    (body) => {
      body.items[0].catalogVersion = "different";
    },
    (body) => {
      body.items[0].countedAt = "2026-11-05T11:00:00.000Z";
    },
    (body) => {
      body.summary.entered = 3;
    },
    (body) => {
      body.notification.language = "ru";
    },
    (body) => {
      body.items.reverse();
    },
    (body) => {
      body.items[0].locations.reverse();
    },
    (body) => {
      delete body.items[0].expirationWarning;
    },
  ]) {
    const changed = copy(request);
    change(changed);
    assert.throws(() => db.call("workspaceCount", changed), /REQUEST_ID_REUSED/);
  }
  assert.deepEqual(
    copy([...db.sheets.values()].map((sheet) => sheet.values)),
    before,
  );
});
test("catalog, team and owner Telegram test writes use the same canonical request identity", () => {
  const cases = [
    [
      "workspaceCatalog",
      (db) => ({
        id: randomUUID(),
        action: "save",
        product: { ...db.load().products[0], minimum: 2 },
      }),
      "staff",
    ],
    [
      "workspaceTeam",
      () => ({ id: randomUUID(), kind: "note", text: "Check stock" }),
      "staff",
    ],
    [
      "workspaceTelegramTest",
      () => ({ id: randomUUID(), language: "ru" }),
      "owner",
    ],
  ];
  for (const [method, makeRequest, actor] of cases) {
    const db = database();
    const request = makeRequest(db);
    const result = db.call(method, request, actor);
    const operations = db.sheets.get("WorkspaceOperations").values;
    assert.equal(operations[1][3], db.context.workspaceRequestHash_(request));
    assert.deepEqual(db.call(method, reordered(request), actor), result);
    assert.equal(operations.length, 2);
  }
});

function legacyCount() {
  const db = database();
  const request = db.countRequest(
    db.load().products.map((product) => ({
      ...db.item(product, "1.25"),
      expirationWarning: false,
      countedAt: "2026-11-05T10:00:00.000Z",
    })),
  );
  request.summary = { entered: 2, uncounted: 0, low: 0 };
  const canonical = db.context.workspaceRequestHash_;
  db.context.workspaceRequestHash_ = db.context.workspaceHash_;
  const result = db.call("workspaceCount", request);
  db.context.workspaceRequestHash_ = canonical;
  const row = db.sheets.get("WorkspaceOperations").values[1];
  assert.notEqual(row[3], canonical(request));
  const plan = JSON.parse(row[6]);
  const identity = {
    scheme: "workspace-request-v1",
    operationId: row[0],
    actor: row[1],
    kind: row[2],
    originalHash: row[3],
    canonicalHash: canonical(request),
  };
  return { db, request, result, row, plan, identity };
}
test("legacy raw-hash retries still work and only a reviewed bound identity can recover a reordered legacy count", () => {
  const { db, request, result, row, plan, identity } = legacyCount();
  assert.deepEqual(db.call("workspaceCount", request), result);
  assert.throws(
    () => db.call("workspaceCount", reordered(request)),
    /REQUEST_ID_REUSED/,
  );
  const originalHash = row[3];
  const events = copy(db.sheets.get("Events").values);
  plan.requestIdentity = identity;
  row[6] = JSON.stringify(plan);
  assert.deepEqual(db.call("workspaceCount", reordered(request)), result);
  assert.equal(row[3], originalHash);
  assert.deepEqual(db.sheets.get("Events").values, events);
  assert.equal(db.sheets.get("WorkspaceOperations").values.length, 2);
  assert.throws(
    () => db.call("workspaceCount", request, "other"),
    /REQUEST_ID_REUSED/,
  );
  assert.throws(
    () => db.call("workspaceTeam", { ...request, kind: "note", text: "x" }),
    /REQUEST_ID_REUSED/,
  );
});
test("reviewed legacy identities reject changed values, array order and every corrupt binding", () => {
  const fixture = legacyCount();
  const { db, request, row, plan, identity } = fixture;
  const saveIdentity = (value) => {
    row[6] = JSON.stringify({ ...plan, requestIdentity: value });
  };
  saveIdentity(identity);
  for (const change of [
    (body) => {
      body.items[0].locations[0].value = "2";
    },
    (body) => {
      body.items[0].catalogVersion = "different";
    },
    (body) => {
      body.items[0].countedAt = "2026-11-05T11:00:00.000Z";
    },
    (body) => {
      body.summary.entered = 3;
    },
    (body) => {
      body.notification.language = "ru";
    },
    (body) => {
      body.items.reverse();
    },
    (body) => {
      body.items[0].locations.reverse();
    },
    (body) => {
      body.extra = true;
    },
  ]) {
    const changed = copy(request);
    change(changed);
    assert.throws(() => db.call("workspaceCount", changed), /REQUEST_ID_REUSED/);
  }
  for (const [key, value] of [
    ["scheme", "unrecognized"],
    ["operationId", randomUUID()],
    ["actor", "other@example.test"],
    ["kind", "catalog"],
    ["originalHash", "b".repeat(64)],
    ["canonicalHash", "c".repeat(64)],
    ["canonicalHash", null],
  ]) {
    saveIdentity({ ...identity, [key]: value });
    assert.throws(
      () => db.call("workspaceCount", reordered(request)),
      /REQUEST_ID_REUSED/,
    );
  }
});
test("reviewed legacy identity never resumes prepared, empty or partial counts", () => {
  for (const change of [
    (result) => {
      result.state = "PREPARED";
    },
    (result) => {
      result.accepted = [];
    },
    (result) => {
      result.failed = [{ id: "P001", error: "INVALID_COUNT" }];
    },
    (result) => {
      result.conflicted = [{ id: "P001", error: "STOCK_CONFLICT" }];
    },
    (result) => {
      result.id = randomUUID();
    },
  ]) {
    const { db, request, row, plan, identity, result } = legacyCount();
    plan.requestIdentity = identity;
    row[6] = JSON.stringify(plan);
    change(result);
    row[5] = JSON.stringify(result);
    const before = copy([...db.sheets.values()].map((sheet) => sheet.values));
    assert.throws(
      () => db.call("workspaceCount", reordered(request)),
      /REQUEST_ID_REUSED/,
    );
    assert.deepEqual(
      copy([...db.sheets.values()].map((sheet) => sheet.values)),
      before,
    );
  }
});
test("lost reply immediately after Events append recovers without duplicate stock", () => {
  const db = database(),
    request = db.countRequest([db.item(db.load().products[0], "4")]);
  db.fault((name, kind) => {
    if (name === "Events" && kind === "append") {
      db.fault(() => {});
      throw Error("lost reply");
    }
  });
  assert.throws(() => db.call("workspaceCount", request), /lost reply/);
  assert.equal(db.load().products[0].last, 4);
  assert.equal(db.call("workspaceCount", request).accepted.length, 1);
  assert.equal(db.sheets.get("Events").values.length, 2);
});
test("prepared count interrupted before Events append refuses later conflicting stock", () => {
  const db = database(),
    original = db.load().products[0],
    request = db.countRequest([db.item(original, "4")]);
  db.fault((name, kind) => {
    if (name === "WorkspaceOperations" && kind === "append") {
      db.fault(() => {});
      throw Error("interrupted");
    }
  });
  assert.throws(() => db.call("workspaceCount", request), /interrupted/);
  db.call("workspaceCount", db.countRequest([db.item(original, "8")]), "other");
  const recovered = db.call("workspaceCount", request);
  assert.equal(recovered.accepted.length, 0);
  assert.equal(recovered.conflicted.length, 1);
  assert.equal(db.load().products[0].last, 8);
});
test("catalog writes repair an interrupted response using durable plan", () => {
  const db = database(),
    p = db.load().products[0],
    request = {
      id: randomUUID(),
      action: "save",
      product: { ...p, ru: "Recovered" },
    };
  db.fault((name, kind) => {
    if (name === "Products" && kind === "set") {
      db.fault(() => {});
      throw Error("interrupted");
    }
  });
  assert.throws(() => db.call("workspaceCatalog", request), /interrupted/);
  assert.equal(db.call("workspaceCatalog", request).product.ru, "Recovered");
  assert.equal(db.sheets.get("Products").values.length, 3);
});
test("complete catalogs beyond old limits use segmented journal and multiple native Events envelopes", () => {
  const db = database({ count: 360 }),
    snapshot = db.load();
  assert.equal(snapshot.products.length, 360);
  const request = db.countRequest(
      snapshot.products.map((p) => db.item(p, "1")),
      "ALL",
    ),
    result = db.call("workspaceCount", request);
  assert.equal(result.accepted.length, 360);
  assert.ok(db.sheets.get("Events").values.length > 2);
  assert.ok(db.sheets.get("WorkspaceOperationParts").values.length > 1);
  for (const sheet of db.sheets.values())
    for (const row of sheet.values)
      for (const cell of row)
        if (typeof cell === "string") assert.ok(cell.length < 50000);
  assert.equal(
    db.load().products.every((p) => p.last === 1),
    true,
  );
  assert.equal(result.notification.format, "RICH");
  assert.equal(result.notification.language, "ru");
  assert.equal(result.notification.messages.length, 1);
  assert.equal(result.notification.delivery.length, 1);
  assert.ok(result.notification.messages[0].length > 4096);
  for (const product of snapshot.products)
    assert.ok(
      result.notification.messages[0].includes(product.id + " · " + product.ru),
    );
  assert.deepEqual(db.call("workspaceCount", request), result);
});
test("team notes and cards use original schema and mutation IDs; no duplicates on retry", () => {
  const db = database();
  const note = { id: randomUUID(), kind: "note", text: "Check milk" },
    card = {
      id: randomUUID(),
      kind: "card",
      code: "C2",
      name: "New",
      category: "C",
      size: "",
      note: "",
    };
  db.call("workspaceTeam", note);
  db.call("workspaceTeam", note);
  db.call("workspaceTeam", card);
  db.call("workspaceTeam", card);
  assert.equal(db.load().notes.length, 1);
  assert.equal(db.load().notes[0].authorName, "Staff");
  assert.equal(db.load().cards.length, 2);
  assert.throws(
    () => db.call("workspaceTeam", { ...card, id: randomUUID() }),
    /CARD_EXISTS/,
  );
  assert.throws(
    () => db.call("workspaceTeam", { ...card, id: randomUUID(), code: "A0" }),
    /INVALID_CARD_NUMBER/,
  );
});
test("read-only server denies every mutation, not only browser controls", () => {
  const db = database();
  db.properties.set("PWA_WRITES_ENABLED", "false");
  for (const method of [
    "workspaceCount",
    "workspaceCatalog",
    "workspaceTeam",
    "workspaceNotify",
  ])
    assert.throws(() => db.call(method, {}), /PWA_READ_ONLY/);
  assert.equal(db.load().permissions.write, false);
});
test("baseline key order and extra imported fields do not change the acknowledged stock revision", () => {
  const db = database({
    baseline: {
      P001: {
        note: "Import",
        extra: "legacy",
        quality: "EXACT",
        by: "old",
        last: "2025-01-01T00:00:00.000Z",
        checked: "2025-01-01T00:00:00.000Z",
        low: false,
        q: 5,
      },
    },
  });
  const result = db.call(
    "workspaceCount",
    db.countRequest([db.item(db.load().products[0], "1")]),
  );
  assert.equal(
    result.accepted[0].stockVersion,
    db.load().products[0].stockVersion,
  );
});
test("native envelope retains per-zone audit, and a newer standalone count never reuses old zone detail", () => {
  const db = database(),
    request = db.countRequest([db.item(db.load().products[0], "1,25")]);
  db.call("workspaceCount", request);
  assert.deepEqual(
    db.load().products[0].lastLocations,
    request.items[0].locations,
  );
  db.sheets
    .get("Events")
    .appendRow([
      randomUUID(),
      new Date().toISOString(),
      "CHECK",
      "P001",
      "CAFE",
      "",
      3,
      "other@example.test",
      "EXACT",
      "NO",
      "",
    ]);
  assert.equal(db.load().products[0].lastLocations, null);
});
test("partially saved multi-envelope retry does not overwrite a newer count or label it fresh", () => {
  const db = database({ count: 220 }),
    snapshot = db.load(),
    request = db.countRequest(
      snapshot.products.map((p) => db.item(p, "1")),
      "ALL",
    );
  db.fault((name, kind) => {
    if (name === "Events" && kind === "append") {
      db.fault(() => {});
      throw Error("interrupted");
    }
  });
  assert.throws(() => db.call("workspaceCount", request), /interrupted/);
  const uncommitted = db.load().products.find((p) => p.last === null);
  assert.ok(uncommitted);
  db.call(
    "workspaceCount",
    db.countRequest([db.item(uncommitted, "9")]),
    "other",
  );
  const result = db.call("workspaceCount", request);
  assert.equal(
    result.accepted.some((item) => item.id === uncommitted.id),
    false,
  );
  assert.equal(
    result.conflicted.some((item) => item.id === uncommitted.id),
    true,
  );
  assert.equal(db.load().products.find((p) => p.id === uncommitted.id).last, 9);
  const message = result.notification.messages.join("\n");
  assert.ok(
    message.includes(`${uncommitted.id} · ${uncommitted.ru}<br>Не пересчитано`),
  );
});
test("a deleted Low item returns a per-item conflict without blocking other valid counts", () => {
  const db = database(),
    original = db.load().products;
  db.call("workspaceCatalog", {
    id: randomUUID(),
    action: "delete",
    product: original[0],
  });
  const request = db.countRequest(
    [db.item(original[0]), db.item(original[1])],
    "LOW",
  );
  request.notification.lowIds = [original[0].id];
  const result = db.call("workspaceCount", request);
  assert.equal(result.accepted[0].id, original[1].id);
  assert.equal(result.conflicted[0].error, "PRODUCT_DELETED");
  const flagsOnly = db.countRequest([], "LOW");
  flagsOnly.notification.lowIds = [original[0].id];
  const flagsResult = db.call("workspaceCount", flagsOnly);
  assert.equal(flagsResult.accepted.length, 0);
  assert.equal(flagsResult.conflicted[0].error, "PRODUCT_DELETED");
});
test("segmented journal text cannot become a spreadsheet formula at a chunk boundary", () => {
  const db = database(),
    prefix = '{"text":"';
  const value = {
    text:
      "x".repeat(40000 - prefix.length) +
      '=IMPORTDATA("https://invalid.test")' +
      "x".repeat(10000),
  };
  const encoded = db.context.workspaceEncode_(randomUUID(), "result", value);
  assert.deepEqual(copy(db.context.workspaceDecode_(encoded)), value);
  const rows = db.sheets.get("WorkspaceOperationParts").values.slice(1);
  assert.ok(rows[1][1].startsWith("JSON:=IMPORTDATA"));
  assert.equal(
    rows.every((row) => row[1].startsWith("JSON:")),
    true,
  );
});
test("Telegram ALL freezes uncounted saved values and product membership at Send time", () => {
  const db = database();
  db.call(
    "workspaceCount",
    db.countRequest([db.item(db.load().products[1], "2")]),
  );
  const original = db.load().products,
    request = db.countRequest([db.item(original[0], "1")], "ALL");
  request.notification.products = original.map(
    ({ id, ru, en, unit, active, last, lastCountedAt, approx, low }) => ({
      id,
      ru,
      en,
      unit,
      active,
      last,
      lastCountedAt,
      approx,
      low,
    }),
  );
  db.call(
    "workspaceCount",
    db.countRequest([db.item(original[1], "9")]),
    "other",
  );
  db.call("workspaceCatalog", {
    id: randomUUID(),
    action: "save",
    product: {
      ...original[1],
      id: undefined,
      ru: "Added later",
      en: "Added later",
    },
  });
  const result = db.call("workspaceCount", request),
    report = result.notification.messages.join("\n");
  assert.ok(report.includes("Пересчитано сейчас: 1 л"));
  assert.ok(report.includes("Ранее записано: 2 л"));
  assert.equal(report.includes("Added later"), false);
  assert.equal(report.includes("Ранее записано: 9 л"), false);
  assert.equal(db.load().products[1].last, 9);
});
test("report-only previous quantities never update inventory and unknown report IDs are refused", () => {
  const db = database(),
    p = db.load().products[0],
    request = db.countRequest([], "ALL");
  request.notification.products = [
    { ...p, last: 123, lastCountedAt: "2025-01-01T00:00:00.000Z" },
  ];
  const result = db.call("workspaceCount", request);
  assert.ok(result.notification.messages[0].includes("Ранее записано: 123 л"));
  assert.equal(db.load().products[0].last, null);
  assert.throws(
    () =>
      db.call("workspaceCount", {
        ...request,
        id: randomUUID(),
        notification: {
          ...request.notification,
          products: [{ ...p, id: "FAKE" }],
        },
      }),
    /INVALID_NOTIFICATION/,
  );
});
test("exact minimum and pieces validation cannot silently round a decimal", () => {
  const db = database();
  assert.throws(
    () => db.context.workspaceQuantity_("999999999.00000001", "l"),
    /INVALID_QUANTITY/,
  );
  assert.throws(
    () => db.context.workspaceQuantity_("999999999.00000001", "pcs"),
    /INVALID_QUANTITY/,
  );
  const p = db.load().products[0];
  assert.throws(
    () =>
      db.call("workspaceCatalog", {
        id: randomUUID(),
        action: "save",
        product: { ...p, minimum: "999999999.00000001" },
      }),
    /INVALID_QUANTITY/,
  );
});
test("old floating movement artifacts in uncounted report data never block fresh stock saves", () => {
  const db = database();
  const original = db.load().products,
    request = db.countRequest([db.item(original[0], "1")], "ALL");
  request.notification.products = original.map((p) => ({
    ...p,
    last: p.id === original[1].id ? 0.1 + 0.2 : p.last,
  }));
  const result = db.call("workspaceCount", request);
  assert.equal(result.accepted.length, 1);
  assert.ok(
    result.notification.messages.join("\n").includes("Ранее записано: 0,3 л"),
  );
});

test("Apps Script files avoid parser-incompatible integer literals and constructor dependencies", async () => {
  const directory = new URL("../apps-script/", import.meta.url);
  for (const name of (await readdir(directory)).filter((file) =>
    file.endsWith(".gs"),
  )) {
    const code = await readFile(new URL(name, directory), "utf8");
    assert.doesNotMatch(
      code,
      /\b(?:0[xob][\da-f]+|\d+)n\b|\bBigInt\s*\(/i,
      name,
    );
    assert.doesNotThrow(() => new vm.Script(code, { filename: name }));
  }
});

test("Apps Script decimal text arithmetic is exact beyond the safe integer boundary", () => {
  const db = database();
  assert.equal(db.context.BigInt, undefined);
  const cases = [
    ["0", "0"],
    ["99999999", "1"],
    ["9007199254740991", "1"],
    ["9007199254740992", "9"],
    ["99999999999999999", "1"],
    ["100000000000000000", "1"],
  ];
  let seed = 731;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  for (let i = 0; i < 200; i++) {
    const a =
      (BigInt(next()) * 100000000n + BigInt(next())) % 100000000000000001n;
    const b =
      (BigInt(next()) * 100000000n + BigInt(next())) % 100000000000000001n;
    cases.push([String(a), String(b)]);
  }
  for (const [left, right] of cases)
    assert.equal(
      db.context.workspaceAddScaled_(left, right),
      String(BigInt(left) + BigInt(right)),
    );
  for (const value of ["0", "0.00000001", "1.25", "1000000000"])
    assert.equal(db.context.workspaceQuantity_(value, "l"), Number(value));
  for (const value of [
    "1000000000.00000001",
    "999999999.00000001",
    "-1",
    "0.000000001",
  ])
    assert.throws(
      () => db.context.workspaceQuantity_(value, "l"),
      /INVALID_QUANTITY/,
    );
  assert.equal(db.context.workspaceQuantity_("0.00000001", "pcs"), 0.00000001);
});

const unitChangeRequest = (db, product, unit = "pcs") => ({
  id: randomUUID(),
  action: "save",
  product: {
    ...product,
    unit,
    unitRecount: {
      confirmed: true,
      stockVersion: product.stockVersion,
      countVersion: product.countVersion,
      locations: [
        { zoneId: "fridge", value: "1,25", unit: "BASE" },
        { zoneId: "shelf", value: "0.5", unit: "BASE" },
      ],
      approx: false,
      low: true,
      expirationWarning: true,
    },
  },
});

test("historical unit changes require an explicitly confirmed fresh recount and preserve original event units", () => {
  const db = database();
  const original = db.load().products[0];
  assert.equal(original.hasStockHistory, false);
  db.call("workspaceCount", db.countRequest([db.item(original, "5")]));
  const counted = db.load().products[0];
  assert.equal(counted.hasStockHistory, true);
  const request = unitChangeRequest(db, counted);
  for (const recount of [
    undefined,
    { ...request.product.unitRecount, confirmed: false },
  ]) {
    assert.throws(
      () =>
        db.call("workspaceCatalog", {
          ...request,
          id: randomUUID(),
          product: { ...request.product, unitRecount: recount },
        }),
      /UNIT_RECOUNT_/,
    );
  }
  const oldRows = copy(db.sheets.get("Events").values);
  const result = db.call("workspaceCatalog", request);
  assert.equal(result.unitRecounted, true);
  assert.equal(result.product.unit, "pcs");
  assert.equal(result.product.last, 1.75);
  assert.equal(result.product.expirationWarning, true);
  assert.deepEqual(
    db.sheets.get("Events").values.slice(0, oldRows.length),
    oldRows,
  );
  const checks = copy(db.context.rows_("Events")).filter(
    (event) => event[3] === counted.id,
  );
  assert.deepEqual(
    checks.map((event) => event[13]),
    ["l", "pcs"],
  );
  assert.equal(checks[1][12], ""); // Never pretend the old unit is a new-unit delta.
  const unitBatch = db.context.v5Decode_(db.sheets.get("Events").values.at(-1));
  assert.equal(unitBatch.workspaceUnitChange.previousStock.unit, "l");
  assert.equal(unitBatch.workspaceUnitChange.previousStock.quantity, 5);
  assert.equal(db.load().products[0].unit, "pcs");
  assert.deepEqual(db.call("workspaceCatalog", request), result);
  assert.equal(db.sheets.get("Events").values.length, oldRows.length + 1);
  const stale = db.call(
    "workspaceCount",
    db.countRequest([db.item(counted, "99")]),
  );
  assert.equal(stale.conflicted.length, 1);
  assert.equal(db.load().products[0].last, 1.75);
});

test("unit changes accept decimal pieces but reject incomplete recounts, stale stock, wrong ownership and changed request bodies", () => {
  const db = database({ baseline: { P001: { q: 3 } } });
  const current = db.load().products[0];
  const request = unitChangeRequest(db, current);
  assert.throws(
    () =>
      db.call("workspaceCatalog", {
        ...request,
        product: {
          ...request.product,
          unitRecount: {
            ...request.product.unitRecount,
            locations: request.product.unitRecount.locations.slice(0, 1),
          },
        },
      }),
    /INVALID_ZONES/,
  );
  db.call("workspaceCount", db.countRequest([db.item(current, "2")]));
  assert.throws(() => db.call("workspaceCatalog", request), /STOCK_CONFLICT/);
  const fresh = unitChangeRequest(db, db.load().products[0]);
  db.call("workspaceCatalog", fresh);
  assert.throws(
    () => db.call("workspaceCatalog", fresh, "other"),
    /REQUEST_ID_REUSED/,
  );
  assert.throws(
    () =>
      db.call("workspaceCatalog", {
        ...fresh,
        product: { ...fresh.product, unit: "kg" },
      }),
    /REQUEST_ID_REUSED/,
  );
  const p = db.load().products[0];
  const result = db.call(
    "workspaceCount",
    db.countRequest([db.item(p, "0,125")]),
  );
  assert.equal(result.accepted[0].last, 0.125);
});

test("unit recount projection repairs interruptions after the authoritative envelope without replaying or restoring stale metadata", () => {
  const db = database({ baseline: { P001: { q: 3 } } });
  const request = unitChangeRequest(db, db.load().products[0]);
  let once = true;
  db.fault((sheet, action) => {
    if (once && sheet === "Events" && action === "append") {
      once = false;
      throw Error("lost event reply");
    }
  });
  assert.throws(() => db.call("workspaceCatalog", request), /lost event reply/);
  assert.equal(db.sheets.get("Products").values[1][4], "l");
  const projected = db.load().products[0];
  assert.equal(projected.unit, "pcs");
  assert.equal(projected.last, 1.75);
  db.fault(() => {});
  db.call("workspaceCatalog", {
    id: randomUUID(),
    action: "save",
    product: { ...projected, ru: "Newer metadata" },
  });
  const fresh = db.load().products[0];
  db.call("workspaceCount", db.countRequest([db.item(fresh, "4.5")]));
  const repaired = db.call("workspaceCatalog", request);
  assert.equal(repaired.state, "COMMITTED");
  assert.equal(db.load().products[0].ru, "Newer metadata");
  assert.equal(db.load().products[0].last, 4.5);
  assert.equal(db.sheets.get("Events").values.length, 3);
});

test("a unit plan interrupted before Events cannot overwrite a later stock change on any retry", () => {
  const db = database({ baseline: { P001: { q: 3 } } });
  const p = db.load().products[0];
  const request = unitChangeRequest(db, p);
  let once = true;
  db.fault((sheet, action) => {
    if (once && sheet === "WorkspaceOperations" && action === "append") {
      once = false;
      throw Error("lost plan reply");
    }
  });
  assert.throws(() => db.call("workspaceCatalog", request), /lost plan reply/);
  db.fault(() => {});
  db.call("workspaceCount", db.countRequest([db.item(p, "8")]));
  for (let attempt = 0; attempt < 2; attempt++)
    assert.throws(() => db.call("workspaceCatalog", request), /STOCK_CONFLICT/);
  assert.equal(db.load().products[0].unit, "l");
  assert.equal(db.load().products[0].last, 8);
});

test("unit row materialization faults and repeated unit changes keep a coherent projection and immutable unit chain", () => {
  const db = database({ baseline: { P001: { q: 3 } } });
  const request = unitChangeRequest(db, db.load().products[0]);
  let once = true;
  db.fault((sheet, action) => {
    if (once && sheet === "Products" && action === "set") {
      once = false;
      throw Error("lost row acknowledgment");
    }
  });
  assert.throws(
    () => db.call("workspaceCatalog", request),
    /lost row acknowledgment/,
  );
  assert.equal(db.load().products[0].unit, "pcs");
  assert.equal(db.load().products[0].last, 1.75);
  db.fault(() => {});
  db.call("workspaceCatalog", request);
  for (const unit of ["kg", "l"]) {
    const p = db.load().products[0];
    const next = unitChangeRequest(db, p, unit);
    db.call("workspaceCatalog", next);
    assert.equal(db.load().products[0].unit, unit);
    assert.equal(db.load().products[0].last, 1.75);
    db.call("workspaceCatalog", next);
  }
  assert.deepEqual(
    copy(db.context.rows_("Events")).map((event) => event[13]),
    ["pcs", "kg", "l"],
  );
  assert.equal(db.sheets.get("Events").values.length, 4);
});

test("expiration warning is immutable count metadata, survives older clients and explicitly clears only on a counted item", () => {
  const db = database();
  let p = db.load().products[0];
  assert.equal(p.expirationWarning, false);
  const first = db.call(
    "workspaceCount",
    db.countRequest([{ ...db.item(p, "1"), expirationWarning: true }]),
  );
  assert.equal(first.accepted[0].expirationWarning, true);
  p = db.load().products[0];
  assert.equal(p.expirationWarning, true);
  const oldClient = db.call(
    "workspaceCount",
    db.countRequest([db.item(p, "2")]),
  );
  assert.equal(oldClient.accepted[0].expirationWarning, true);
  p = db.load().products[0];
  const bad = db.call(
    "workspaceCount",
    db.countRequest([{ ...db.item(p, "3"), expirationWarning: "true" }]),
  );
  assert.equal(bad.failed[0].error, "INVALID_FLAGS");
  const blank = db.call(
    "workspaceCount",
    db.countRequest([{ ...db.item(p, ""), expirationWarning: false }]),
  );
  assert.equal(blank.accepted.length, 0);
  assert.equal(db.load().products[0].expirationWarning, true);
  const before = copy(db.sheets.get("Events").values);
  db.call(
    "workspaceCount",
    db.countRequest([{ ...db.item(p, "2"), expirationWarning: false }]),
  );
  assert.equal(db.load().products[0].expirationWarning, false);
  assert.deepEqual(
    db.sheets.get("Events").values.slice(0, before.length),
    before,
  );
});

test("zone sums carry exactly without arbitrary precision runtime support", () => {
  const db = database(),
    p = db.load().products[0];
  const input = db.item(p, "0.99999999");
  input.locations[1].value = "0.00000001";
  assert.equal(
    db.call("workspaceCount", db.countRequest([input])).accepted[0].last,
    1,
  );
  const maximum = db.item(db.load().products[0], "999999999");
  maximum.locations[1].value = "1";
  assert.equal(
    db.call("workspaceCount", db.countRequest([maximum])).accepted[0].last,
    1000000000,
  );
  const overflow = db.item(db.load().products[0], "1000000000");
  overflow.locations[1].value = "0.00000001";
  const result = db.call("workspaceCount", db.countRequest([overflow]));
  assert.equal(result.failed[0].error, "INVALID_QUANTITY");
  assert.equal(db.load().products[0].last, 1000000000);
});

test("workspace bootstrap exposes Telegram presence and permissions, never credentials", () => {
  const db = database();
  db.properties.set(
    "TELEGRAM_TOKEN",
    "private-integration-token-not-for-browser",
  );
  db.properties.set("TELEGRAM_CHAT_ID", "-100987654321");
  const owner = db.call("workspaceLoad", {}, "owner");
  assert.equal(owner.telegram.configured, true);
  assert.equal(owner.telegram.canTest, true);
  assert.equal(db.load().telegram.canTest, false);
  for (const secret of [
    "private-integration-token-not-for-browser",
    "-100987654321",
  ])
    assert.equal(JSON.stringify(owner).includes(secret), false);
});

test("Telegram test dispatch is owner-only, read-only-gated, replayable and isolated from stock", () => {
  const db = database();
  const request = { id: randomUUID(), language: "ru" };
  const beforeProducts = copy(db.sheets.get("Products").values);
  const beforeEvents = copy(db.sheets.get("Events").values);
  assert.throws(() => db.call("workspaceTelegramTest", request), /OWNER_ONLY/);
  const result = db.call("workspaceTelegramTest", request, "owner");
  assert.equal(result.state, "COMMITTED");
  assert.equal(result.notification.status, "NOT_CONFIGURED");
  assert.deepEqual(db.call("workspaceTelegramTest", request, "owner"), result);
  assert.equal(
    db.call("workspaceStatus", { id: request.id }, "owner").status,
    "COMMITTED",
  );
  assert.deepEqual(db.sheets.get("Products").values, beforeProducts);
  assert.deepEqual(db.sheets.get("Events").values, beforeEvents);
  db.properties.set("PWA_WRITES_ENABLED", "false");
  assert.throws(
    () =>
      db.call(
        "workspaceTelegramTest",
        { ...request, id: randomUUID() },
        "owner",
      ),
    /PWA_READ_ONLY/,
  );
});

test("one Russian RichMessage is delivered only after stock commits, and rejection never rolls inventory back", () => {
  const db = database();
  db.properties.set("TELEGRAM_TOKEN", "private-rich-integration-test");
  db.properties.set("TELEGRAM_CHAT_ID", "-100123456789");
  const request = db.countRequest([db.item(db.load().products[0], "7")], "ALL");
  const result = db.call("workspaceCount", request);
  assert.equal(result.state, "COMMITTED");
  assert.equal(result.notification.language, "ru");
  const eventRows = db.sheets.get("Events").values.length;
  let attempts = 0;
  db.context.UrlFetchApp = {
    fetch(url, options) {
      attempts++;
      assert.equal(db.load().products[0].last, 7);
      assert.ok(url.endsWith("/sendRichMessage"));
      const payload = JSON.parse(options.payload);
      assert.equal(payload.rich_message.skip_entity_detection, true);
      assert.ok(payload.rich_message.html.includes("Пересчитано сейчас: 7 л"));
      assert.equal(Object.hasOwn(payload, "text"), false);
      return {
        getResponseCode: () => 400,
        getContentText: () => JSON.stringify({ ok: false, error_code: 400 }),
      };
    },
  };
  assert.equal(db.call("workspaceNotify", { id: request.id }).status, "FAILED");
  assert.equal(attempts, 1);
  assert.equal(db.load().products[0].last, 7);
  assert.equal(db.sheets.get("Events").values.length, eventRows);
  assert.equal(
    db.call("workspaceStatus", { id: request.id }).status,
    "COMMITTED",
  );
});
