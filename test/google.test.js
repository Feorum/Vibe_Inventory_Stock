import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  accountKey,
  saveRecord,
  readRecord,
  quantity,
  buildSubmission,
  changedDrafts,
  normalizeSnapshot,
  effectiveSession,
} from "../google-pwa/model.js";
import {
  deploymentUrl,
  googleOrigin,
  GoogleTransport,
} from "../google-pwa/transport.js";

const spec = {
  id: "P001",
  ru: "Молоко",
  unit: "l",
  sleeve: false,
  zones: ["fridge", "shelf"],
  revision: "old",
  checked: false,
};
const session = {
  id: "session-1234567890123456",
  status: "OPEN",
  items: [spec],
};
const draft = () => ({
  revision: "old",
  zones: ["fridge", "shelf"],
  unit: "l",
  sleeve: false,
  countedAt: "2026-10-24T12:00:00.000Z",
  locations: {
    fridge: { value: "1,25", unit: "BASE" },
    shelf: { value: "0", unit: "BASE" },
  },
});

test("Google decimal validation preserves eight places, zero and whole sleeve pieces", () => {
  assert.equal(quantity("0.00000001", "l").scaled, 1n);
  assert.equal(quantity("0", "pcs").scaled, 0n);
  assert.equal(quantity("0.04", "pcs", true).scaled, 100000000n);
  for (const value of ["-1", "1e2", "1.000000001", "", "NaN", "1000000001"])
    assert.throws(() => quantity(value, "l"));
  assert.throws(() => quantity("0.1", "pcs"));
  assert.throws(() => quantity("0.01", "pcs", true));
});
test("Google submissions preserve revisions and all zones; blank never becomes zero", () => {
  const drafts = { P001: draft() };
  const request = buildSubmission(session, drafts, {
    id: "fixed-operation-12345678",
  });
  assert.equal(request.items[0].revision, "old");
  assert.equal(request.items[0].locations[0].value, "1.25");
  assert.equal(request.items[0].locations[1].value, "0");
  assert.equal(drafts.P001.locations.fridge.value, "1,25");
  drafts.P001.locations.shelf.value = "";
  assert.throws(
    () => buildSubmission(session, drafts, { keepCurrent: true }),
    /every storage zone/,
  );
  assert.throws(() => buildSubmission(session, {}), /at least one/);
  const larger = {
    ...session,
    items: [...session.items, { ...spec, id: "P002" }],
  };
  assert.throws(() => buildSubmission(larger, { P001: draft() }), /explicitly/);
  assert.equal(
    buildSubmission(larger, { P001: draft() }, { keepCurrent: true })
      .blankPolicy,
    "KEEP_CURRENT",
  );
  assert.throws(
    () => buildSubmission({ ...session, status: "COMPLETE" }, drafts),
    /online first/,
  );
});
test("Google draft validation rejects unsupported sleeve inputs and overflowing zone totals", () => {
  const entry = draft();
  entry.locations.fridge.unit = "SLEEVE_25";
  assert.throws(() => buildSubmission(session, { P001: entry }), /Unsupported/);
  entry.locations.fridge = { value: "1000000000", unit: "BASE" };
  entry.locations.shelf.value = "1";
  assert.throws(() => buildSubmission(session, { P001: entry }), /Combined/);
});
test("Google snapshot refresh detects changed revisions without rebasing drafts", () => {
  const snapshot = normalizeSnapshot({
    stock: { products: [{ ...spec, last: 1, revision: "new" }] },
    catalog: [{ ...spec }],
    session,
  });
  const drafts = { P001: draft() };
  assert.deepEqual(changedDrafts(snapshot, drafts), ["P001"]);
  assert.equal(drafts.P001.revision, "old");
  assert.deepEqual(snapshot.stock.products[0].zones, ["fridge", "shelf"]);
  snapshot.stock.products[0].revision = "old";
  assert.deepEqual(changedDrafts(snapshot, drafts), []);
  snapshot.session = { ...session, items: [{ ...spec, zones: ["shelf"] }] };
  assert.deepEqual(changedDrafts(snapshot, drafts), ["P001"]);
});
test("Google storage is account/deployment scoped and fails closed on quota errors", () => {
  assert.notEqual(
    accountKey("deployment-a", "staff@example.test"),
    accountKey("deployment-b", "staff@example.test"),
  );
  assert.notEqual(
    accountKey("deployment-a", "staff@example.test"),
    accountKey("deployment-a", "other@example.test"),
  );
  const map = new Map();
  const storage = {
    getItem: (key) => map.get(key),
    setItem: (key, value) => map.set(key, value),
  };
  saveRecord(storage, "x", { drafts: { P001: draft() } });
  assert.equal(readRecord(storage, "x").drafts.P001.revision, "old");
  assert.equal(readRecord(storage, "missing"), null);
  assert.throws(
    () =>
      saveRecord(
        {
          setItem() {
            throw Error("quota");
          },
        },
        "x",
        {},
      ),
    /quota/,
  );
});
test("Google transport restricts deployment URLs and exact Google frame origins", () => {
  assert.equal(
    deploymentUrl("https://script.google.com/macros/s/ABC-123/exec").hostname,
    "script.google.com",
  );
  for (const url of [
    "https://evil.test/macros/s/x/exec",
    "https://script.google.com/macros/s/x/dev",
    "https://script.google.com/macros/s/x/exec?token=secret",
    "https://script.google.com/macros/s/x/exec#secret",
  ])
    assert.throws(() => deploymentUrl(url));
  assert.equal(googleOrigin("https://script.googleusercontent.com"), true);
  assert.equal(
    googleOrigin("https://n-abc-123-script.googleusercontent.com"),
    true,
  );
  for (const origin of [
    "null",
    "http://script.googleusercontent.com",
    "https://script.googleusercontent.com.evil.test",
    "https://evil.googleusercontent.com",
    "https://script.google.com",
  ])
    assert.equal(googleOrigin(origin), false);
});

test("Google transport pins the inner Window and rejects forged response origins/channels", async () => {
  const originalWindow = globalThis.window,
    originalDocument = globalThis.document;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    body: { append() {} },
  };
  const transport = new GoogleTransport(
    "https://script.google.com/macros/s/TEST/exec",
    { timeout: 500 },
  );
  try {
    const sent = [];
    const peer = { postMessage: (...args) => sent.push(args) };
    const impostor = { postMessage() {} };
    const ready = {
      protocol: "varka-google-1",
      type: "ready",
      channel: transport.channel,
    };
    transport.receive({
      origin: "https://evil.test",
      source: peer,
      data: ready,
    });
    transport.receive({
      origin: "https://script.googleusercontent.com",
      source: peer,
      data: { ...ready, channel: "wrong" },
    });
    assert.equal(transport.peer, undefined);
    transport.receive({
      origin: "https://n-test-script.googleusercontent.com",
      source: peer,
      data: ready,
    });
    transport.receive({
      origin: "https://script.googleusercontent.com",
      source: impostor,
      data: ready,
    });
    assert.equal(transport.peer, peer);
    const call = transport.call("load", {}, "token");
    await Promise.resolve();
    assert.equal(sent[0][1], "https://n-test-script.googleusercontent.com");
    const response = {
      ...ready,
      type: "response",
      id: sent[0][0].id,
      result: { ok: true, data: { read: true } },
    };
    transport.receive({
      origin: "https://n-test-script.googleusercontent.com",
      source: impostor,
      data: response,
    });
    transport.receive({
      origin: "https://evil.test",
      source: peer,
      data: response,
    });
    assert.equal(transport.pending.size, 1);
    transport.receive({
      origin: "https://n-test-script.googleusercontent.com",
      source: peer,
      data: response,
    });
    assert.equal((await call).read, true);
    assert.equal(transport.pending.size, 0);
  } finally {
    transport.destroy();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

const bridgeSource = await readFile(
  new URL("../apps-script/PwaBridge.gs", import.meta.url),
  "utf8",
);
function bridge(properties = {}) {
  const calls = [];
  const journal = [
    ["ID", "Actor", "Request SHA256", "Kind", "Created", "State", "Result"],
  ];
  const sheet = {
    getDataRange: () => ({ getValues: () => journal.map((row) => [...row]) }),
    appendRow: (row) => journal.push([...row]),
    getLastRow: () => journal.length,
    getRange: (row, column, height, width) => ({
      getValues: () =>
        journal
          .slice(row - 1, row - 1 + height)
          .map((r) => r.slice(column - 1, column - 1 + width)),
      setValues: (values) => {
        for (let i = 0; i < height; i++)
          for (let j = 0; j < width; j++)
            journal[row - 1 + i][column - 1 + j] = values[i][j];
      },
    }),
  };
  const context = vm.createContext({
    webAuth_: (token) => {
      if (token !== "session") throw Error("SIGN_IN_REQUIRED");
      return "staff@example.test";
    },
    v3Id_: (id) => {
      if (!/^[-a-zA-Z0-9]{16,80}$/.test(id || "")) throw Error("INVALID_ID");
      return id;
    },
    v3Lock_: (callback) => callback(),
    book_: () => ({ getSheetByName: () => sheet }),
    SpreadsheetApp: { flush() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_algorithm, value) => [
        ...createHash("sha256").update(value, "utf8").digest(),
      ],
    },
    webSave: (...args) => {
      calls.push(["movement", ...args]);
      return { saved: 1 };
    },
    webV8SyncProducts: (...args) => {
      calls.push(["catalog", ...args]);
      return { ok: true, ids: { created: "P135" } };
    },
    webV6Note: (...args) => {
      calls.push(["reminder", ...args]);
      return { ok: true };
    },
    webV6Card: (...args) => {
      calls.push(["card", ...args]);
      return { ok: true };
    },
    webV6SaveProfile: (...args) => {
      calls.push(["profile", ...args]);
      return { name: "New name" };
    },
    webV10SaveSettings: (...args) => {
      calls.push(["settings", ...args]);
      throw Error("OWNER_ONLY");
    },
    webV9CorrectSession: (...args) => {
      calls.push(["correction", ...args]);
      return { ok: true };
    },
    webV6Expand: (...args) => {
      calls.push(["expand", ...args]);
      return { ok: true };
    },
    webV6Information: (...args) => {
      calls.push(["information", ...args]);
      return { cards: [], notes: [] };
    },
    webV4History: (...args) => {
      calls.push(["history", ...args]);
      return { entries: [], revisions: [] };
    },
    webV10Settings: (...args) => {
      calls.push(["readSettings", ...args]);
      return { canManage: false };
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) =>
          ({ PWA_ORIGIN: "https://feorum.github.io", ...properties })[key],
      }),
    },
    webLogin: (...args) => {
      calls.push(["login", ...args]);
      return { token: "test", email: args[0] };
    },
    webLogout: (token) => {
      calls.push(["logout", token]);
      return true;
    },
    webV8Load: (token, body) => {
      calls.push(["load", token, body]);
      return { loaded: new Date("2026-10-24T12:00:00Z") };
    },
    webV5Start: (token, body) => {
      calls.push(["start", token, body]);
      return { session: { id: body.id } };
    },
    webV5Submit: (token, body) => {
      calls.push(["submit", token, body]);
      return { ok: true };
    },
    webV9SubmissionStatus: (token, body) => {
      calls.push(["status", token, body]);
      return { status: "ABSENT" };
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
      createTemplateFromFile(name) {
        const template = {
          name,
          evaluate() {
            return {
              setTitle() {
                return this;
              },
              setXFrameOptionsMode() {
                return template;
              },
            };
          },
        };
        return template;
      },
    },
  });
  vm.runInContext(bridgeSource, context);
  return {
    dispatch: (request) => context.pwaDispatch(request),
    page: (e) => context.pwaPage_(e),
    calls,
    journal,
    context,
  };
}

test("PWA features journal replays exactly once and rejects actor/body/kind changes", () => {
  const runtime = bridge({ PWA_WRITES_ENABLED: "true" });
  const body = {
    id: "feature-operation-123456789",
    kind: "profile",
    payload: { name: "Виталий" },
  };
  const request = { method: "mutate", token: "session", body };
  assert.equal(runtime.dispatch(request).data.status, "COMMITTED");
  assert.equal(runtime.dispatch(request).data.status, "COMMITTED");
  assert.equal(runtime.calls.filter((call) => call[0] === "profile").length, 1);
  assert.equal(
    runtime.dispatch({
      ...request,
      body: { ...body, payload: { name: "Фёдор" } },
    }).error,
    "REQUEST_ID_REUSED",
  );
  assert.equal(
    runtime.dispatch({ ...request, body: { ...body, kind: "reminder" } }).error,
    "REQUEST_ID_REUSED",
  );
  runtime.context.webAuth_ = () => "other@example.test";
  assert.equal(
    runtime.dispatch({
      method: "operationStatus",
      token: "session",
      body: { id: body.id },
    }).error,
    "OWN_ENTRIES_ONLY",
  );
});
test("PWA features never repeat an uncertain mutation and preserve business rejections", () => {
  const runtime = bridge({ PWA_WRITES_ENABLED: "true" });
  let effects = 0;
  runtime.context.webSave = () => {
    effects++;
    throw Error("COMMIT_UNCONFIRMED");
  };
  const body = {
    id: "uncertain-operation-123456",
    kind: "movement",
    payload: { action: "RECEIVE", items: [{ id: "P001" }] },
  };
  assert.equal(
    runtime.dispatch({ method: "mutate", token: "session", body }).data.status,
    "UNKNOWN",
  );
  assert.equal(
    runtime.dispatch({ method: "mutate", token: "session", body }).data.status,
    "UNKNOWN",
  );
  assert.equal(effects, 1);
  runtime.context.webV6Note = () => {
    throw Error("CONFLICT");
  };
  assert.equal(
    runtime.dispatch({
      method: "mutate",
      token: "session",
      body: {
        id: "conflicting-operation-12345",
        kind: "reminder",
        payload: {},
      },
    }).data.status,
    "REJECTED",
  );
});
test("PWA features gate mutations, constrain stock actions and preserve owner-only settings", () => {
  const readOnly = bridge();
  assert.equal(
    readOnly.dispatch({ method: "mutate", token: "session", body: {} }).error,
    "PWA_READ_ONLY",
  );
  assert.equal(readOnly.journal.length, 1);
  const runtime = bridge({ PWA_WRITES_ENABLED: "true" });
  assert.equal(
    runtime.dispatch({ method: "mutate", token: "wrong", body: {} }).error,
    "SIGN_IN_REQUIRED",
  );
  assert.equal(
    runtime.dispatch({
      method: "mutate",
      token: "session",
      body: { id: "invalid-kind-123456789", kind: "installV5" },
    }).error,
    "METHOD_NOT_ALLOWED",
  );
  const result = runtime.dispatch({
    method: "mutate",
    token: "session",
    body: {
      id: "invalid-count-123456789",
      kind: "movement",
      payload: { action: "CHECK", items: [{}] },
    },
  });
  assert.equal(result.data.status, "REJECTED");
  assert.equal(
    runtime.calls.filter((call) => call[0] === "movement").length,
    0,
  );
  const settings = runtime.dispatch({
    method: "mutate",
    token: "session",
    body: {
      id: "owner-setting-123456789",
      kind: "settings",
      payload: { enabled: true },
    },
  });
  assert.equal(settings.data.status, "REJECTED");
  assert.equal(settings.data.result.error, "OWNER_ONLY");
});

test("PWA operation reservation is outside legacy locks and an in-flight duplicate cannot execute twice", () => {
  const runtime = bridge({ PWA_WRITES_ENABLED: "true" });
  let locked = false,
    writes = 0;
  runtime.context.v3Lock_ = (fn) => {
    assert.equal(locked, false);
    locked = true;
    try {
      return fn();
    } finally {
      locked = false;
    }
  };
  const body = {
    id: "concurrent-feature-12345678",
    kind: "profile",
    payload: { name: "Name" },
  };
  runtime.context.webV6SaveProfile = () => {
    assert.equal(locked, false);
    writes++;
    assert.equal(
      runtime.dispatch({ method: "mutate", token: "session", body }).data
        .status,
      "UNKNOWN",
    );
    return { name: "Name" };
  };
  assert.equal(
    runtime.dispatch({ method: "mutate", token: "session", body }).data.status,
    "COMMITTED",
  );
  assert.equal(writes, 1);
});

test("PWA features require journal installation before performing a mutation", () => {
  const runtime = bridge({ PWA_WRITES_ENABLED: "true" });
  runtime.context.book_ = () => ({ getSheetByName: () => null });
  const result = runtime.dispatch({
    method: "mutate",
    token: "session",
    body: {
      id: "missing-install-123456789",
      kind: "profile",
      payload: { name: "Name" },
    },
  });
  assert.match(result.error, /^PWA_FEATURES_NOT_INSTALLED/);
  assert.equal(runtime.calls.length, 0);
});

test("PWA feature installer is owner-only, backs up before creating the journal and preserves existing rows", () => {
  const runtime = bridge();
  const events = [],
    tables = new Map();
  let owner = false;
  runtime.context.v4Owner_ = () => {
    if (!owner) throw Error("OWNER_ONLY");
  };
  runtime.context.prop_ = () => ({
    setProperty: (name, value) => events.push(["property", name, value]),
  });
  runtime.context.book_ = () => ({
    getSheetByName: (name) => tables.get(name),
    copy: () => {
      events.push(["backup"]);
      return { getId: () => "backup-id" };
    },
  });
  runtime.context.v3Sheet_ = (name, headers) => {
    events.push(["create", name]);
    const rows = [headers];
    tables.set(name, {
      getRange: () => ({ getValues: () => [rows[0]] }),
      rows,
    });
  };
  assert.throws(() => runtime.context.installPwaFeatures(), /OWNER_ONLY/);
  assert.equal(events.length, 0);
  owner = true;
  assert.equal(runtime.context.installPwaFeatures().ok, true);
  assert.equal(events[0][0], "backup");
  const rows = tables.get("PwaOperations").rows;
  rows.push(["existing-operation"]);
  assert.equal(runtime.context.installPwaFeatures().ok, true);
  assert.equal(events.filter((e) => e[0] === "backup").length, 1);
  assert.equal(rows[1][0], "existing-operation");
  rows[0] = ["unexpected-header"];
  assert.throws(
    () => runtime.context.installPwaFeatures(),
    /PWA_OPERATIONS_LAYOUT_CONFLICT/,
  );
});

test("A legacy catalog response failure after a durable plan is UNKNOWN, not a false rollback", () => {
  const runtime = bridge({ PWA_WRITES_ENABLED: "true" });
  let effects = 0;
  runtime.context.webV8SyncProducts = () => {
    effects++;
    throw Error("INVALID_STORED_ZONES");
  };
  // The mock sheet includes the reserved operation ID, standing in for an
  // existing ProductSync plan. The real adapter reads that separate legacy sheet.
  const body = {
    id: "catalog-postwrite-123456789",
    kind: "catalog",
    payload: { changes: [] },
  };
  assert.equal(
    runtime.dispatch({ method: "mutate", token: "session", body }).data.status,
    "UNKNOWN",
  );
  assert.equal(
    runtime.dispatch({ method: "mutate", token: "session", body }).data.status,
    "UNKNOWN",
  );
  assert.equal(effects, 1);
});
test("PWA features use fixed read adapters and durable IDs for all original workflow adapters", () => {
  const runtime = bridge({ PWA_WRITES_ENABLED: "true" });
  for (const method of ["information", "history", "settings"])
    assert.equal(
      runtime.dispatch({ method, token: "session", body: {} }).ok,
      true,
    );
  for (const kind of [
    "catalog",
    "reminder",
    "card",
    "profile",
    "correction",
    "expand",
  ]) {
    const id = `feature-${kind}-1234567890123456`;
    assert.equal(
      runtime.dispatch({
        method: "mutate",
        token: "session",
        body: { id, kind, payload: { sessionId: "s", text: "test" } },
      }).data.status,
      "COMMITTED",
    );
    assert.equal(
      runtime.dispatch({
        method: "operationStatus",
        token: "session",
        body: { id },
      }).data.status,
      "COMMITTED",
    );
  }
  assert.equal(
    runtime.calls.find((call) => call[0] === "catalog")[2].id,
    "feature-catalog-1234567890123456",
  );
  assert.equal(
    runtime.calls.find((call) => call[0] === "card")[2].operationId,
    "feature-card-1234567890123456",
  );
});
test("PWA count models stage activation/zones atomically and support explicit incomplete close", () => {
  const catalog = [
    {
      id: "P002",
      ru: "Чашки",
      unit: "pcs",
      sleeve: 25,
      last: null,
      revision: "new-r",
      version: "new-v",
      zones: [],
    },
  ];
  const changes = [
    { id: "P001", active: false, version: "v1", zones: [] },
    { id: "P002", active: true, version: "new-v", zones: ["shelf"] },
  ];
  const merged = effectiveSession(session, changes, [{ ...spec }, ...catalog]);
  assert.deepEqual(
    merged.items.map((p) => p.id),
    ["P002"],
  );
  assert.equal(merged.items[0].sleeve, true);
  const drafts = {
    P002: {
      ...draft(),
      revision: "new-r",
      locations: { shelf: { value: "1", unit: "SLEEVE_25" } },
    },
  };
  const request = buildSubmission(merged, drafts, { productChanges: changes });
  assert.equal(request.productChanges, changes);
  assert.equal(request.items[0].locations[0].unit, "SLEEVE_25");
  assert.throws(
    () =>
      buildSubmission(
        merged,
        {},
        { productChanges: changes, keepCurrent: true },
      ),
    /Activation requires/,
  );
  const larger = {
    ...session,
    items: [...session.items, { ...spec, id: "P003" }],
  };
  assert.equal(
    buildSubmission(larger, { P001: draft() }, { incomplete: true }).incomplete,
    true,
  );
});
test("Apps Script bridge is read-only by default, with explicit dispatch and no generic RPC", () => {
  const runtime = bridge();
  assert.equal(runtime.dispatch({ method: "ping" }).data.writesEnabled, false);
  for (const method of ["start", "submit"])
    assert.equal(
      runtime.dispatch({ method, token: "x", body: { id: "a" } }).error,
      "PWA_READ_ONLY",
    );
  assert.equal(runtime.calls.length, 0);
  assert.equal(
    runtime.dispatch({ method: "installV5" }).error,
    "METHOD_NOT_ALLOWED",
  );
  assert.equal(
    runtime.dispatch({ method: "load", body: { extra: "x".repeat(60000) } })
      .error,
    "INVALID_REQUEST",
  );
});
test("Apps Script bridge delegates authentication and preserves locked legacy operations", () => {
  const runtime = bridge({ PWA_WRITES_ENABLED: "true" });
  assert.equal(
    runtime.dispatch({ method: "login", body: { email: "a", code: "code" } })
      .data.token,
    "test",
  );
  assert.equal(
    runtime.dispatch({
      method: "load",
      token: "session",
      body: { sessionId: "id", suspendExpansion: false },
    }).data.loaded,
    "2026-10-24T12:00:00.000Z",
  );
  const load = runtime.calls.find((call) => call[0] === "load");
  assert.equal(load[2].suspendExpansion, true);
  runtime.dispatch({
    method: "start",
    token: "session",
    body: { id: "original-id" },
  });
  const body = { id: "original-operation", sessionId: "id", items: [] };
  runtime.dispatch({ method: "submit", token: "session", body });
  assert.equal(runtime.calls.find((call) => call[0] === "submit")[2], body);
  runtime.dispatch({
    method: "status",
    token: "session",
    body: { id: body.id },
  });
  assert.equal(runtime.calls.at(-1)[0], "status");
});
test("Apps Script bridge requires exact HTTPS frontend configuration and a random channel", () => {
  for (const origin of [
    "",
    "http://feorum.github.io",
    "https://feorum.github.io/",
    "https://feorum.github.io/path",
    "https://evil.test<script>",
  ])
    assert.equal(
      bridge({ PWA_ORIGIN: origin }).dispatch({ method: "ping" }).ok,
      false,
    );
  const runtime = bridge();
  assert.throws(
    () => runtime.page({ parameter: { channel: "bad" } }),
    /INVALID_CHANNEL/,
  );
  const template = runtime.page({ parameter: { channel: "a".repeat(32) } });
  assert.equal(template.name, "PwaBridge");
  assert.equal(
    JSON.parse(template.configuration).origin,
    "https://feorum.github.io",
  );
});
