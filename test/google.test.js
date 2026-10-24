import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import {
  accountKey,
  saveRecord,
  readRecord,
  quantity,
  buildSubmission,
  changedDrafts,
  normalizeSnapshot,
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
  const context = vm.createContext({
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
  };
}
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
