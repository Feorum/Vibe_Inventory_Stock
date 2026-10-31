import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../apps-script/WorkspaceNotifications.gs", import.meta.url),
  "utf8",
);
const copy = (value) => JSON.parse(JSON.stringify(value));
const owner = "owner@example.test";
function harness(overrides = {}) {
  const properties = new Map(
    Object.entries({
      WORKSPACE_INSTALLED: "1",
      PWA_WRITES_ENABLED: "true",
      TELEGRAM_TOKEN: "FAKE_TOKEN_FOR_TESTS_ONLY",
      TELEGRAM_CHAT_ID: "FAKE_CHAT_FOR_TESTS_ONLY",
      ...overrides,
    }),
  );
  const operations = new Map(),
    calls = [],
    logs = [],
    owners = new Set([owner]);
  let locked = false,
    sheetAccesses = 0,
    editor = owner;
  let response = () => ({
    getResponseCode: () => 200,
    getContentText: () =>
      JSON.stringify({ ok: true, result: { message_id: 55 } }),
  });
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const context = vm.createContext({
    Date,
    Map,
    Set,
    JSON,
    BigInt: undefined,
    console: { log: (value) => logs.push(String(value)) },
    prop_: () => ({ getProperty: (name) => properties.get(name) || null }),
    workspaceManage_: (email) => owners.has(email),
    v4Owner_: () => {
      if (!owners.has(editor)) throw Error("OWNER_ONLY");
      return editor;
    },
    workspaceReady_: () => {
      if (properties.get("WORKSPACE_INSTALLED") !== "1")
        throw Error("WORKSPACE_NOT_INSTALLED");
    },
    workspaceId_: (id) => {
      if (typeof id !== "string" || !/^[-a-zA-Z0-9]{16,80}$/.test(id))
        throw Error("INVALID_ID");
      return id;
    },
    workspaceHash_: hash,
    workspacePrior_: (id, actor, kind, body) => {
      assert.equal(locked, true);
      const operation = operations.get(id);
      if (
        operation &&
        (operation.actor !== actor ||
          operation.kind !== kind ||
          operation.hash !== hash(body))
      )
        throw Error("REQUEST_ID_REUSED");
      return operation ? copy(operation) : null;
    },
    workspaceOperation_: (id) => {
      assert.equal(locked, true);
      return operations.has(id) ? copy(operations.get(id)) : null;
    },
    workspaceAppendOperation_: (id, actor, kind, fingerprint, result) => {
      assert.equal(locked, true);
      const operation = copy({ id, actor, kind, hash: fingerprint, result });
      operations.set(id, operation);
      return copy(operation);
    },
    workspaceWriteResult_: (operation, result) => {
      assert.equal(locked, true);
      operations.set(operation.id, copy({ ...operation, result }));
    },
    v3Lock_: (callback) => {
      assert.equal(locked, false, "must not nest native locks");
      locked = true;
      try {
        return callback();
      } finally {
        locked = false;
      }
    },
    book_: () => {
      sheetAccesses++;
      throw Error("Test notifications must not touch inventory sheets");
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        assert.equal(
          locked,
          false,
          "Telegram HTTP call must happen after releasing the sheet lock",
        );
        if (url.endsWith("/sendMessage"))
          assert.ok(
            [...operations.values()].some(
              (operation) => operation.result.notification.status === "UNKNOWN",
            ),
            "UNKNOWN journal must precede a non-idempotent HTTP send",
          );
        else
          assert.ok(
            url.endsWith("/getUpdates"),
            "discovery must not change bot configuration",
          );
        calls.push({ url, options });
        return response();
      },
    },
  });
  vm.runInContext(source, context);
  return {
    context,
    properties,
    operations,
    calls,
    logs,
    owners,
    setEditor: (email) => {
      editor = email;
    },
    request: (language = "en") => ({ id: randomUUID(), language }),
    setResponse: (next) => {
      response = next;
    },
    sheetAccesses: () => sheetAccesses,
  };
}

test("Telegram setup status exposes presence flags, never server credential values", () => {
  const h = harness();
  const status = copy(h.context.workspaceTelegramStatus_(owner));
  assert.deepEqual(status, {
    configured: true,
    tokenConfigured: true,
    chatConfigured: true,
    canTest: true,
    writesEnabled: true,
  });
  assert.equal(
    h.context.workspaceTelegramStatus_("staff@example.test").canTest,
    false,
  );
  assert.equal(h.context.workspaceTelegramStatus_(null).canTest, false);
  for (const value of [
    h.properties.get("TELEGRAM_TOKEN"),
    h.properties.get("TELEGRAM_CHAT_ID"),
  ])
    assert.equal(JSON.stringify(status).includes(value), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.operations.size, 0);
});

test("owner Telegram test is explicit, localized and separate from inventory", () => {
  for (const language of ["en", "ru"]) {
    const h = harness(),
      request = h.request(language);
    const result = h.context.workspaceTelegramTest_(owner, request);
    assert.equal(result.id, request.id);
    assert.equal(result.state, "COMMITTED");
    assert.equal(result.notification.status, "SENT");
    assert.equal(result.notification.scope, "TEST");
    assert.equal(result.notification.delivered, 1);
    assert.equal(result.notification.messages, undefined);
    const payload = JSON.parse(h.calls[0].options.payload);
    assert.equal(payload.chat_id, h.properties.get("TELEGRAM_CHAT_ID"));
    assert.equal(payload.parse_mode, undefined);
    assert.match(
      payload.text,
      language === "ru" ? /Проверка Telegram/ : /Telegram test/,
    );
    assert.doesNotMatch(
      payload.text,
      language === "ru"
        ? /Inventory|The bot|test notification/
        : /Остатки|склада|уведомление/,
    );
    assert.equal(h.operations.get(request.id).kind, "telegramTest");
    assert.equal(h.sheetAccesses(), 0);
  }
});

test("confirmed Telegram test retries do not duplicate messages and IDs bind actor/body/kind", () => {
  const h = harness(),
    request = h.request();
  const first = copy(h.context.workspaceTelegramTest_(owner, request));
  assert.deepEqual(
    copy(h.context.workspaceTelegramTest_(owner, request)),
    first,
  );
  assert.equal(h.context.workspaceDeliver_(request.id, owner).status, "SENT");
  assert.equal(h.calls.length, 1);
  assert.equal(h.operations.size, 1);
  assert.throws(
    () =>
      h.context.workspaceTelegramTest_(owner, { ...request, language: "ru" }),
    /REQUEST_ID_REUSED/,
  );
  h.owners.add("other@example.test");
  assert.throws(
    () => h.context.workspaceTelegramTest_("other@example.test", request),
    /REQUEST_ID_REUSED/,
  );
  h.operations.get(request.id).kind = "count";
  assert.throws(
    () => h.context.workspaceTelegramTest_(owner, request),
    /REQUEST_ID_REUSED/,
  );
});

test("missing Telegram configuration reports separately and can retry the same prepared test after setup", () => {
  for (const name of ["TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID"]) {
    const h = harness({ [name]: "" }),
      request = h.request();
    assert.equal(h.context.workspaceTelegramStatus_(owner).configured, false);
    assert.equal(
      h.context.workspaceTelegramTest_(owner, request).notification.status,
      "NOT_CONFIGURED",
    );
    assert.equal(h.calls.length, 0);
    h.properties.set(name, "FAKE_SETUP_VALUE_FOR_TESTS_ONLY");
    assert.equal(
      h.context.workspaceTelegramTest_(owner, request).notification.status,
      "SENT",
    );
    assert.equal(h.calls.length, 1);
    assert.equal(h.operations.size, 1);
  }
});

test("staff, unauthenticated identities, lost owner permission and read-only mode cannot send setup tests", () => {
  const h = harness(),
    request = h.request();
  for (const actor of [null, "", "staff@example.test"])
    assert.throws(
      () => h.context.workspaceTelegramTest_(actor, request),
      /OWNER_ONLY/,
    );
  assert.equal(h.operations.size, 0);
  h.properties.set("PWA_WRITES_ENABLED", "false");
  assert.throws(
    () => h.context.workspaceTelegramTest_(owner, request),
    /PWA_READ_ONLY/,
  );
  assert.equal(h.operations.size, 0);
  h.properties.set("PWA_WRITES_ENABLED", "true");
  h.context.workspaceTelegramTest_(owner, request);
  h.owners.delete(owner);
  assert.throws(
    () => h.context.workspaceTelegramTest_(owner, request),
    /OWNER_ONLY/,
  );
  assert.throws(
    () => h.context.workspaceDeliver_(request.id, owner),
    /OWNER_ONLY/,
  );
  h.owners.add(owner);
  h.properties.set("PWA_WRITES_ENABLED", "false");
  assert.throws(
    () => h.context.workspaceDeliver_(request.id, owner),
    /PWA_READ_ONLY/,
  );
  assert.equal(h.calls.length, 1);
});

test("Telegram setup request validation occurs before journaling or external requests", () => {
  const h = harness();
  for (const body of [
    null,
    {},
    { id: randomUUID(), language: "de" },
    { id: "bad", language: "en" },
  ])
    assert.throws(
      () => h.context.workspaceTelegramTest_(owner, body),
      /INVALID_REQUEST|INVALID_ID/,
    );
  h.properties.set("WORKSPACE_INSTALLED", "");
  assert.throws(
    () => h.context.workspaceTelegramTest_(owner, h.request()),
    /WORKSPACE_NOT_INSTALLED/,
  );
  assert.equal(h.operations.size, 0);
  assert.equal(h.calls.length, 0);
});

test("a definite Telegram rejection supports an idempotent notification-only retry", () => {
  const h = harness(),
    request = h.request();
  h.setResponse(() => ({
    getResponseCode: () => 403,
    getContentText: () =>
      JSON.stringify({ ok: false, description: "bot cannot send" }),
  }));
  assert.equal(
    h.context.workspaceTelegramTest_(owner, request).notification.status,
    "FAILED",
  );
  assert.equal(h.operations.size, 1);
  h.setResponse(() => ({
    getResponseCode: () => 200,
    getContentText: () =>
      JSON.stringify({ ok: true, result: { message_id: 99 } }),
  }));
  assert.equal(h.context.workspaceDeliver_(request.id, owner).status, "SENT");
  assert.equal(h.calls.length, 2);
  assert.equal(
    h.context.workspaceTelegramTest_(owner, request).notification.status,
    "SENT",
  );
  assert.equal(h.calls.length, 2);
  assert.equal(h.sheetAccesses(), 0);
});

test("ambiguous Telegram setup delivery never auto-resends or leaks the fetch URL/token", () => {
  const h = harness(),
    request = h.request();
  h.setResponse(() => {
    throw Error(
      "timeout fetching https://api.telegram.org/bot" +
        h.properties.get("TELEGRAM_TOKEN") +
        "/sendMessage",
    );
  });
  const result = h.context.workspaceTelegramTest_(owner, request);
  assert.equal(result.notification.status, "UNKNOWN");
  assert.equal(result.notification.error, "TELEGRAM_DELIVERY_UNKNOWN");
  assert.equal(
    h.context.workspaceTelegramTest_(owner, request).notification.status,
    "UNKNOWN",
  );
  assert.equal(
    h.context.workspaceDeliver_(request.id, owner).status,
    "UNKNOWN",
  );
  assert.equal(h.calls.length, 1);
  assert.equal(
    JSON.stringify(result).includes(h.properties.get("TELEGRAM_TOKEN")),
    false,
  );
  assert.equal(JSON.stringify(result).includes("api.telegram.org"), false);
});

test("an in-flight duplicate Telegram test sees UNKNOWN rather than sending another message", () => {
  const h = harness(),
    request = h.request();
  let concurrent;
  h.setResponse(() => {
    concurrent = h.context.workspaceTelegramTest_(owner, request);
    return {
      getResponseCode: () => 200,
      getContentText: () =>
        JSON.stringify({ ok: true, result: { message_id: 90 } }),
    };
  });
  assert.equal(
    h.context.workspaceTelegramTest_(owner, request).notification.status,
    "SENT",
  );
  assert.equal(concurrent.notification.status, "UNKNOWN");
  assert.equal(h.calls.length, 1);
  assert.equal(h.operations.size, 1);
});

test("a lost delivery journal acknowledgment cannot cause a known-sent Telegram test to resend", () => {
  const h = harness(),
    request = h.request();
  const write = h.context.workspaceWriteResult_;
  h.context.workspaceWriteResult_ = (operation, result) => {
    if (result.notification.status === "SENT")
      throw Error("Journal interrupted after Telegram sent");
    write(operation, result);
  };
  assert.throws(
    () => h.context.workspaceTelegramTest_(owner, request),
    /Journal interrupted/,
  );
  assert.equal(
    h.context.workspaceTelegramTest_(owner, request).notification.status,
    "UNKNOWN",
  );
  assert.equal(h.calls.length, 1);
});

test("owner chat discovery returns only distinct safe chat metadata, without acknowledging updates", () => {
  const h = harness({ TELEGRAM_CHAT_ID: "", WORKSPACE_INSTALLED: "" });
  const privateChat = {
    id: 112233,
    type: "private",
    first_name: "PRIVATE_FIRST_NAME",
    last_name: "PRIVATE_LAST_NAME",
    username: "PRIVATE_USER_NAME",
  };
  const group = { id: -100445566, type: "supergroup", title: "Café team" };
  const channel = { id: -100778899, type: "channel", title: "Café reports" };
  h.setResponse(() => ({
    getResponseCode: () => 200,
    getContentText: () =>
      JSON.stringify({
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              chat: privateChat,
              text: "PRIVATE_MESSAGE_TEXT",
              from: { id: 999, first_name: "PRIVATE_AUTHOR" },
            },
          },
          {
            update_id: 2,
            message: { chat: group, text: "PRIVATE_GROUP_TEXT" },
          },
          {
            update_id: 3,
            edited_message: { chat: group, text: "PRIVATE_EDITED_TEXT" },
          },
          {
            update_id: 4,
            channel_post: { chat: channel, text: "PRIVATE_CHANNEL_TEXT" },
          },
          {
            update_id: 5,
            callback_query: {
              message: { chat: group },
              data: "PRIVATE_CALLBACK",
            },
          },
          {
            update_id: 6,
            message: { chat: { id: "invalid", type: "private" } },
          },
        ],
      }),
  }));
  const chats = copy(h.context.listWorkspaceTelegramChats());
  assert.deepEqual(chats, [
    { id: "112233", type: "private", title: "Private chat" },
    { id: "-100445566", type: "supergroup", title: "Café team" },
    { id: "-100778899", type: "channel", title: "Café reports" },
  ]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url.endsWith("/getUpdates"), true);
  assert.equal(h.calls[0].url.includes("?"), false);
  assert.equal(h.calls[0].options.method, "get");
  assert.equal(h.calls[0].options.payload, undefined);
  assert.doesNotMatch(
    JSON.stringify([chats, h.logs]),
    /PRIVATE_|update_id|callback|text|from|FAKE_TOKEN/,
  );
  assert.equal(h.operations.size, 0);
  assert.equal(h.sheetAccesses(), 0);
});

test("chat discovery requires editor owner access before reading the bot", () => {
  const h = harness();
  for (const editor of [null, "", "staff@example.test"]) {
    h.setEditor(editor);
    assert.throws(() => h.context.listWorkspaceTelegramChats(), /OWNER_ONLY/);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.length, 0);
  h.setEditor(owner);
  h.properties.delete("TELEGRAM_TOKEN");
  assert.throws(
    () => h.context.listWorkspaceTelegramChats(),
    /TELEGRAM_TOKEN_MISSING/,
  );
  assert.equal(h.calls.length, 0);
});

test("chat discovery preserves existing webhook/polling integrations and sanitizes failures", () => {
  const h = harness();
  h.setResponse(() => ({
    getResponseCode: () => 409,
    getContentText: () =>
      JSON.stringify({ ok: false, description: "PRIVATE_WEBHOOK_DETAIL" }),
  }));
  assert.throws(
    () => h.context.listWorkspaceTelegramChats(),
    /^Error: TELEGRAM_UPDATES_UNAVAILABLE$/,
  );
  h.setResponse(() => {
    throw Error(
      "fetch https://api.telegram.org/bot" +
        h.properties.get("TELEGRAM_TOKEN") +
        "/getUpdates failed",
    );
  });
  assert.throws(
    () => h.context.listWorkspaceTelegramChats(),
    /^Error: TELEGRAM_CHAT_DISCOVERY_FAILED$/,
  );
  for (const response of [
    {
      getResponseCode: () => 401,
      getContentText: () =>
        JSON.stringify({
          ok: false,
          description: h.properties.get("TELEGRAM_TOKEN"),
        }),
    },
    {
      getResponseCode: () => 200,
      getContentText: () => "<html>PRIVATE_ERROR</html>",
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: {} }),
    },
  ]) {
    h.setResponse(() => response);
    assert.throws(
      () => h.context.listWorkspaceTelegramChats(),
      /^Error: TELEGRAM_CHAT_DISCOVERY_FAILED$/,
    );
  }
  assert.equal(h.logs.length, 0);
  assert.ok(h.calls.every((call) => call.url.endsWith("/getUpdates")));
  assert.equal(h.operations.size, 0);
});

test("empty chat discovery does not invent a destination or send a notification", () => {
  const h = harness({ TELEGRAM_CHAT_ID: "" });
  h.setResponse(() => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ ok: true, result: [] }),
  }));
  assert.deepEqual(copy(h.context.listWorkspaceTelegramChats()), []);
  assert.deepEqual(h.logs, ["[]"]);
  assert.equal(h.properties.get("TELEGRAM_CHAT_ID"), "");
  assert.equal(h.operations.size, 0);
  assert.equal(h.calls.length, 1);
});
