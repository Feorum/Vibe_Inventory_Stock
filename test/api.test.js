import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../server/database.js";
import { createApp } from "../server/app.js";

async function fixture(t, options = {}) {
  const db = openDatabase(":memory:");
  const app = createApp({ db, ...options });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(method !== "GET"
          ? { "Content-Type": "application/json", "X-Inventory-Request": "1" }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  }
  return { db, request, base };
}
const beans = {
  name: "House blend",
  category: "Coffee",
  unit: "kg",
  quantity: 2.5,
  minimum: 1,
};
const change = (quantity, type = "out", key = randomUUID()) => ({
  method: "POST",
  headers: { "Idempotency-Key": key },
  body: { type, quantity, note: "Morning shift" },
});

test("health, empty inventory, and app shell are available", async (t) => {
  const { request, base } = await fixture(t);
  assert.equal((await request("/api/health")).body.status, "ok");
  assert.deepEqual((await request("/api/items")).body.items, []);
  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /manifest.webmanifest/);
  assert.match(
    shell.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  assert.equal((await request("/api/not-real")).status, 404);
});

test("creating an item records its opening stock and detects case-insensitive duplicates", async (t) => {
  const { request } = await fixture(t);
  const created = await request("/api/items", { method: "POST", body: beans });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.quantity, 2.5);
  assert.equal(created.body.item.lowStock, false);
  const history = (await request("/api/movements")).body.movements;
  assert.equal(history.length, 1);
  assert.equal(history[0].type, "opening");
  assert.equal(history[0].balance, 2.5);
  const duplicate = await request("/api/items", {
    method: "POST",
    body: { ...beans, name: "house BLEND" },
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await request("/api/movements")).body.movements.length, 1);
});

test("stock in, out, and physical count produce exact balances and low-stock status", async (t) => {
  const { request } = await fixture(t);
  const id = (
    await request("/api/items", {
      method: "POST",
      body: { ...beans, quantity: 0.3, minimum: 0.1 },
    })
  ).body.item.id;
  let response = await request(`/api/items/${id}/movements`, change(0.1));
  assert.equal(response.body.item.quantity, 0.2);
  response = await request(`/api/items/${id}/movements`, change(0.1));
  assert.equal(response.body.item.quantity, 0.1);
  assert.equal(response.body.item.lowStock, true);
  response = await request(`/api/items/${id}/movements`, change(0.001, "in"));
  assert.equal(response.body.item.quantity, 0.101);
  response = await request(`/api/items/${id}/movements`, change(0, "count"));
  assert.equal(response.body.item.quantity, 0);
  assert.equal(response.body.movement.delta, -0.101);
});

test("insufficient stock rolls back both balance and audit trail", async (t) => {
  const { request, db } = await fixture(t);
  const id = (await request("/api/items", { method: "POST", body: beans })).body
    .item.id;
  assert.equal(
    (await request(`/api/items/${id}/movements`, change(3))).status,
    409,
  );
  assert.equal((await request("/api/items")).body.items[0].quantity, 2.5);
  assert.equal((await request("/api/movements")).body.movements.length, 1);
  assert.equal(db.isTransaction, false);
});

test("retries are idempotent and conflicting reuse is rejected", async (t) => {
  const { request } = await fixture(t);
  const id = (await request("/api/items", { method: "POST", body: beans })).body
    .item.id;
  const key = randomUUID();
  const first = await request(
    `/api/items/${id}/movements`,
    change(0.5, "out", key),
  );
  const retry = await request(
    `/api/items/${id}/movements`,
    change(0.5, "out", key),
  );
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.movement.id, first.body.movement.id);
  assert.equal(retry.body.item.quantity, 2);
  assert.equal(
    (await request(`/api/items/${id}/movements`, change(1, "out", key))).status,
    409,
  );
  assert.equal((await request("/api/movements")).body.movements.length, 2);
});

test("simultaneous stock requests cannot overdraw an item", async (t) => {
  const { request } = await fixture(t);
  const id = (
    await request("/api/items", {
      method: "POST",
      body: { ...beans, quantity: 1 },
    })
  ).body.item.id;
  const results = await Promise.all([
    request(`/api/items/${id}/movements`, change(0.75)),
    request(`/api/items/${id}/movements`, change(0.75)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal((await request("/api/items")).body.items[0].quantity, 0.25);
});

test("invalid units, numbers, names, movement types and missing request keys are rejected", async (t) => {
  const { request } = await fixture(t);
  for (const invalid of [
    { name: "" },
    { quantity: -1 },
    { quantity: "4" },
    { quantity: 0.0001 },
    { quantity: 1000001 },
    { minimum: -1 },
    { category: "Unknown" },
    { unit: "bag" },
  ]) {
    assert.equal(
      (
        await request("/api/items", {
          method: "POST",
          body: { ...beans, ...invalid },
        })
      ).status,
      400,
    );
  }
  const id = (await request("/api/items", { method: "POST", body: beans })).body
    .item.id;
  assert.equal(
    (
      await request(`/api/items/${id}/movements`, {
        method: "POST",
        body: { quantity: 1, type: "in" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(`/api/items/${id}/movements`, change(0))).status,
    400,
  );
  assert.equal(
    (await request(`/api/items/${id}/movements`, change(1, "invalid"))).status,
    400,
  );
  assert.equal(
    (await request("/api/items/999/movements", change(1))).status,
    404,
  );
  assert.equal(
    (await request("/api/items/not-an-id/movements", change(1))).status,
    400,
  );
});

test("JSON errors and cross-origin mutations are rejected", async (t) => {
  const { request, base } = await fixture(t);
  assert.equal(
    (
      await request("/api/items", {
        method: "POST",
        body: beans,
        headers: { Origin: "https://other-shop.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/items", {
        method: "POST",
        body: beans,
        headers: { "X-Inventory-Request": "" },
      })
    ).status,
    403,
  );
  const invalid = await fetch(`${base}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Inventory-Request": "1" },
    body: "{bad",
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /JSON/);
});

test("shared-password login protects the API, uses HttpOnly cookies, and logout revokes access", async (t) => {
  const { request } = await fixture(t, { password: "test-shop-passphrase" });
  assert.equal((await request("/api/items")).status, 401);
  assert.equal((await request("/api/session")).body.authenticated, false);
  assert.equal(
    (
      await request("/api/session", {
        method: "POST",
        body: { password: "wrong" },
      })
    ).status,
    401,
  );
  const login = await request("/api/session", {
    method: "POST",
    body: { password: "test-shop-passphrase" },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const headers = { Cookie: cookie.split(";")[0] };
  assert.equal((await request("/api/items", { headers })).status, 200);
  assert.equal(
    (await request("/api/session", { method: "DELETE", headers, body: {} }))
      .status,
    200,
  );
  assert.equal((await request("/api/items", { headers })).status, 401);
});

test("failed password attempts are rate-limited", async (t) => {
  const { request } = await fixture(t, { password: "test-shop-passphrase" });
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await request("/api/session", {
          method: "POST",
          body: { password: "wrong" },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await request("/api/session", {
        method: "POST",
        body: { password: "test-shop-passphrase" },
      })
    ).status,
    429,
  );
});

test("production requires a password and marks sessions Secure", async (t) => {
  const db = openDatabase(":memory:");
  assert.throws(() => createApp({ db, production: true }), /APP_PASSWORD/);
  db.close();
  const { request } = await fixture(t, {
    password: "test-shop-passphrase",
    production: true,
  });
  const login = await request("/api/session", {
    method: "POST",
    body: { password: "test-shop-passphrase" },
  });
  assert.match(login.headers.get("set-cookie"), /__Host-inventory_session=/);
  assert.match(login.headers.get("set-cookie"), /; Secure/);
});

test("SQLite data and audit history survive close/reopen and migrations are repeatable", () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-stock-db-test-"));
  try {
    const file = join(directory, "stock.sqlite");
    let db = openDatabase(file);
    db.prepare(
      "INSERT INTO items(name,category,unit,quantity_milli,minimum_milli) VALUES(?,?,?,?,?)",
    ).run("Beans", "Coffee", "kg", 1250, 500);
    db.prepare(
      "INSERT INTO movements(item_id,type,delta_milli,balance_milli) VALUES(1,'opening',1250,1250)",
    ).run();
    db.close();
    db = openDatabase(file);
    assert.equal(
      db.prepare("SELECT quantity_milli FROM items").get().quantity_milli,
      1250,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM movements").get().n, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n,
      1,
    );
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("online backup captures committed WAL data and refuses to overwrite an existing backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "daily-stock-backup-test-"));
  const source = join(directory, "source.sqlite");
  const destination = join(directory, "backup.sqlite");
  const db = openDatabase(source);
  try {
    db.prepare(
      "INSERT INTO items(name,category,unit,quantity_milli,minimum_milli) VALUES(?,?,?,?,?)",
    ).run("Fresh beans", "Coffee", "kg", 4500, 1000);
    const command = () =>
      spawnSync(process.execPath, ["scripts/backup.js", destination], {
        encoding: "utf8",
        env: { ...process.env, DATABASE_PATH: source },
      });
    const result = command();
    assert.equal(result.status, 0, result.stderr);
    const saved = openDatabase(destination);
    assert.equal(
      saved.prepare("SELECT quantity_milli FROM items").get().quantity_milli,
      4500,
    );
    saved.close();
    const duplicate = command();
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /never overwritten/);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
