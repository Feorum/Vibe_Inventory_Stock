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
    message.includes(`${uncommitted.id} · ${uncommitted.en}\nNot counted`),
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
  assert.ok(report.includes("Fresh recount: 1 l"));
  assert.ok(report.includes("Previously recorded: 2 l"));
  assert.equal(report.includes("Added later"), false);
  assert.equal(report.includes("Previously recorded: 9 l"), false);
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
  assert.ok(
    result.notification.messages[0].includes("Previously recorded: 123 l"),
  );
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
    result.notification.messages
      .join("\n")
      .includes("Previously recorded: 0.3 l"),
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
  assert.throws(
    () => db.context.workspaceQuantity_("0.00000001", "pcs"),
    /INVALID_QUANTITY/,
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
