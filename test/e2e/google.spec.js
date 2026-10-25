import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const endpoint = "https://script.google.com/macros/s/TEST-DEPLOYMENT/exec";
const inner = "https://n-test-script.googleusercontent.com";
const origin = "http://127.0.0.1:3100";
const path = "/Vibe_Inventory_Stock/";
const email = "staff@example.test";
const code = "test-private-code-never-persist-this";
const template = await readFile(
  new URL("../../apps-script/PwaBridge.html", import.meta.url),
  "utf8",
);

async function mockGoogle(page, { writes = true, owner = false } = {}) {
  const product = {
    id: "P001",
    ru: "Молоко",
    en: "Milk",
    category: "Молочные / Dairy",
    unit: "l",
    sleeve: false,
    last: 5,
    revision: "revision-1",
    zones: ["fridge", "shelf"],
    stale: false,
    legacyRevision: "legacy-1",
    version: "metadata-1",
    active: true,
    minimum: null,
    hours: 24,
  };
  const backend = {
    product,
    session: null,
    committed: new Map(),
    submissions: 0,
    calls: [],
    dropSubmit: false,
    catalog: [product],
    information: { cards: [], notes: [] },
    operations: new Map(),
    profile: { email, name: "Test staff" },
    settings: {
      canManage: owner,
      enabled: false,
      mode: "LOW",
      version: "settings-1",
    },
    history: { entries: [], revisions: [], more: false },
    dropFeature: false,
    effects: 0,
  };
  await page.route("https://script.google.com/**", async (route) => {
    const channel = new URL(route.request().url()).searchParams.get("channel");
    await route.fulfill({
      contentType: "text/html",
      body: `<iframe src="${inner}/bridge?channel=${channel}"></iframe>`,
    });
  });
  await page.route(`${inner}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/bridge") {
      const configuration = {
        origin,
        channel: url.searchParams.get("channel"),
      };
      const mock = `<script>window.google = { script: { get run() {
        let success, failure; return {
          withSuccessHandler(fn) { success = fn; return this; },
          withFailureHandler(fn) { failure = fn; return this; },
          pwaDispatch(request) { fetch('/rpc', { method: 'POST', body: JSON.stringify(request) })
            .then(response => response.json()).then(success).catch(failure); }
        }; } } };</script>`;
      await route.fulfill({
        contentType: "text/html",
        body: template
          .replace("<?!= configuration ?>", JSON.stringify(configuration))
          .replace("<body>", `<body>${mock}`),
      });
      return;
    }
    const request = route.request().postDataJSON();
    backend.calls.push(request.method);
    let result;
    const load = () => ({
      stock: {
        products: backend.catalog
          .filter((p) => p.active && !p.archived)
          .map((p) => ({ ...p })),
      },
      catalog: backend.catalog
        .filter((p) => !p.archived)
        .map((p) => ({ ...p })),
      profile: backend.profile,
      session:
        request.method === "start" ||
        request.body.sessionId === backend.session?.id
          ? backend.session
          : null,
      recent: backend.session ? [{ ...backend.session, items: undefined }] : [],
      zones: [
        { id: "fridge", ru: "Холодильник", en: "Refrigerator" },
        { id: "shelf", ru: "Полка", en: "Shelf" },
      ],
    });
    if (request.method === "ping")
      result = { protocol: 1, features: 2, writesEnabled: writes };
    else if (request.method === "login")
      result = { email, token: "memory-only-token" };
    else if (request.token !== "memory-only-token") {
      await route.fulfill({ json: { ok: false, error: "SIGN_IN_REQUIRED" } });
      return;
    } else if (request.method === "load") result = load();
    else if (request.method === "start") {
      backend.session ||= {
        id: request.body.id,
        by: email,
        status: "OPEN",
        items: [{ ...product, checked: false }],
        created: new Date().toISOString(),
      };
      result = load();
    } else if (request.method === "status")
      result = backend.committed.has(request.body.id)
        ? {
            status: "COMMITTED",
            result: backend.committed.get(request.body.id),
          }
        : { status: "ABSENT" };
    else if (request.method === "submit") {
      backend.lastCountRequest = request.body;
      const item = request.body.items[0];
      if (item.revision !== product.revision)
        result = { rejected: true, error: "CONFLICT" };
      else {
        result = { ok: true, saved: 1, status: "COMPLETE" };
        if (!backend.committed.has(request.body.id)) {
          backend.submissions++;
          backend.committed.set(request.body.id, result);
          product.last = item.locations.reduce(
            (sum, zone) => sum + Number(zone.value),
            0,
          );
          product.revision = "revision-after-count";
          backend.session.status = "COMPLETE";
        }
        if (backend.dropSubmit) {
          backend.dropSubmit = false;
          await route.abort();
          return;
        }
      }
    } else if (request.method === "information") result = backend.information;
    else if (request.method === "settings") result = backend.settings;
    else if (request.method === "history") result = backend.history;
    else if (request.method === "operationStatus")
      result = backend.operations.get(request.body.id) || { status: "ABSENT" };
    else if (request.method === "mutate") {
      const { id, kind, payload } = request.body;
      if (backend.operations.has(id)) result = backend.operations.get(id);
      else {
        let saved = { ok: true };
        if (kind === "movement") {
          const item = payload.items[0];
          product.last +=
            (payload.action === "WASTE" ? -1 : 1) * Number(item.value);
          product.revision += "-movement";
          product.legacyRevision += "-movement";
        } else if (kind === "catalog")
          for (const change of payload.changes) {
            let p = backend.catalog.find((p) => p.id === change.productId);
            if (change.action === "save") {
              if (!p) {
                p = { id: `P${backend.catalog.length + 1}`, last: null };
                backend.catalog.push(p);
              }
              Object.assign(p, change.product, {
                zones: change.zones,
                minimum: change.product.noMinimum
                  ? null
                  : change.product.minimum,
              });
            } else if (change.action === "active") p.active = change.active;
            else if (change.action === "archive") p.archived = true;
            p.version = `version-${id}`;
            p.revision = `revision-${id}`;
          }
        else if (kind === "reminder") {
          let note = backend.information.notes.find((n) => n.id === payload.id);
          if (!note) {
            note = { id: payload.id, authorName: "Test staff" };
            backend.information.notes.push(note);
          }
          Object.assign(note, payload, { version: `note-${id}` });
        } else if (kind === "card") {
          if (payload.action === "remove")
            backend.information.cards = backend.information.cards.filter(
              (c) => c.id !== payload.code,
            );
          else
            backend.information.cards.push({
              ...payload,
              id: payload.code,
              version: `card-${id}`,
            });
        } else if (kind === "profile") backend.profile.name = payload.name;
        else if (kind === "settings") {
          if (!owner) saved = { rejected: true, error: "OWNER_ONLY" };
          else
            Object.assign(backend.settings, payload, {
              version: `settings-${id}`,
            });
        } else if (kind === "correction") {
          if (payload.mode === "CURRENT")
            product.last = Number(payload.changes[0].value);
          backend.history.revisions.push({
            ...payload,
            operationId: id,
            corrections: payload.changes.map((c) => ({
              ...c,
              quantity: Number(c.value),
            })),
          });
        }
        backend.effects++;
        result = {
          status: saved.rejected ? "REJECTED" : "COMMITTED",
          result: saved,
        };
        backend.operations.set(id, result);
      }
      if (backend.dropFeature) {
        backend.dropFeature = false;
        await route.abort();
        return;
      }
    } else if (request.method === "logout") result = true;
    else throw Error(`Unexpected mocked method ${request.method}`);
    await route.fulfill({ json: { ok: true, data: result } });
  });
  return backend;
}
async function login(page) {
  await page.locator("#endpoint").fill(endpoint);
  await page.locator("#email").fill(email);
  await page.locator("#code").fill(code);
  await page.locator("#connect").click();
  await expect(page.locator("#message")).toContainText(
    "Synchronized from Google Sheets",
  );
}
async function startCount(page) {
  await page.locator("#start").click();
  await expect(page.locator("#message")).toContainText("Session opened");
  await page.locator('input[data-zone="fridge"]').fill("1.25");
  await page.locator('input[data-zone="shelf"]').fill("0");
}
test("Google mode reads live products in read-only mode without persisting credentials", async ({
  page,
}) => {
  const backend = await mockGoogle(page, { writes: false });
  await page.goto(path);
  await login(page);
  await expect(page.locator("#products")).toContainText("Milk");
  await expect(page.locator("#mode")).toContainText("Read-only");
  await expect(page.locator("#start")).toBeDisabled();
  await expect(page.locator("#code")).toHaveValue("");
  const saved = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(saved).not.toContain(code);
  expect(saved).not.toContain("memory-only-token");
  expect(backend.calls).not.toContain("start");
  const width = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  expect(width).toBe(true);
});

test("Google daily workflows record delivery/waste and recover a lost movement reply", async ({
  page,
}) => {
  const backend = await mockGoogle(page);
  await page.goto(path);
  await login(page);
  await page
    .getByRole("button", { name: "Record delivery", exact: true })
    .click();
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  backend.dropFeature = true;
  await page
    .locator("#feature-form")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.locator("#message")).toContainText(
    "GOOGLE_EXECUTION_FAILED",
  );
  expect(backend.product.last).toBe(7);
  await page.reload();
  await login(page);
  await page.locator("#retry").click();
  await expect(page.locator("#pending-panel")).toBeHidden();
  expect(backend.effects).toBe(1);
  await page.getByRole("button", { name: "Record waste", exact: true }).click();
  await page.getByLabel("Quantity", { exact: true }).fill("1");
  await page.getByLabel("Reason / note").fill("Expired milk");
  await page
    .locator("#feature-form")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.locator("#message")).toContainText(
    "Confirmed in Google Sheets",
  );
  expect(backend.product.last).toBe(6);
});

test("Google catalog, reminders, cards, profile and owner settings run from the new UI", async ({
  page,
}) => {
  const backend = await mockGoogle(page, { owner: true });
  await page.goto(path);
  await login(page);
  const save = async () => {
    await page
      .locator("#feature-form")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(page.locator("#feature-dialog")).not.toBeVisible();
    await expect(page.locator("#message")).toContainText(
      "Confirmed in Google Sheets",
    );
  };
  await page.locator('[data-view="catalog"]').click();
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  await page.getByLabel("Название RU").fill("Тестовый чай");
  await page.getByLabel("Name EN").fill("Test tea");
  await save();
  expect(backend.catalog).toHaveLength(2);
  await page.locator('[data-view="information"]').click();
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  await page.getByLabel("Text", { exact: true }).fill("Order oat milk");
  await save();
  await expect(page.locator("#feature-content")).toContainText(
    "Order oat milk",
  );
  await page.getByRole("button", { name: "Mark done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add yellow card", exact: true })
    .click();
  await page.getByLabel("Card number").fill("A99");
  await page.getByLabel("Name", { exact: true }).fill("Test pastry");
  await page.getByLabel("Category", { exact: true }).fill("A");
  await save();
  await expect(page.locator("#feature-content")).toContainText("A99");
  await page.locator('[data-view="profile"]').click();
  await page.getByRole("button", { name: "Change display name" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Coffee team");
  await save();
  expect(backend.profile.name).toBe("Coffee team");
  await page.getByRole("button", { name: "Telegram report settings" }).click();
  await page.getByLabel("Report content").selectOption("ALL");
  await save();
  expect(backend.settings.enabled).toBe(false);
  expect(backend.settings.mode).toBe("ALL");
  await page.getByRole("button", { name: "Switch to Russian" }).click();
  await expect(page.locator('[data-view="catalog"]')).toHaveText("Каталог");
});

test("Google history corrections preserve original rows and staff cannot see owner settings", async ({
  page,
}) => {
  const backend = await mockGoogle(page);
  backend.history.entries.push({
    id: "check-original",
    ru: "Молоко",
    en: "Milk",
    unit: "l",
    action: "CHECK",
    previous: 2,
    quantity: 5,
    authorName: "Test staff",
    at: new Date().toISOString(),
    sessionId: "original-session",
    editable: true,
    version: "entry-version",
  });
  await page.goto(path);
  await login(page);
  await page.locator('[data-view="history"]').click();
  await page.getByRole("button", { name: "Correct my entry" }).click();
  await page.getByLabel("Correct quantity").fill("4");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Count transcription error");
  await page
    .locator("#feature-form")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.locator("#feature-dialog")).not.toBeVisible();
  expect(backend.product.last).toBe(5);
  expect(backend.history.entries[0].quantity).toBe(5);
  expect(backend.history.revisions).toHaveLength(1);
  await page.locator('[data-view="profile"]').click();
  await expect(
    page.getByRole("button", { name: "Telegram report settings" }),
  ).toHaveCount(0);
});
test("Google mode drafts survive offline reload under the repository subpath", async ({
  page,
  context,
}) => {
  await mockGoogle(page);
  await page.goto(path);
  await login(page);
  await startCount(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await context.setOffline(true);
  await expect(page.locator("#submit")).toBeDisabled();
  await page.reload();
  await expect(page.locator('input[data-zone="fridge"]')).toHaveValue("1.25");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#clear-draft").click();
  await expect(page.locator('input[data-zone="fridge"]')).toHaveValue("");
  await page.locator('input[data-zone="fridge"]').fill("2.5");
  await page.locator('input[data-zone="shelf"]').fill("0");
  await expect(page.locator("#message")).toContainText("draft saved");
  await expect(page.locator("#submit")).toBeDisabled();
  await context.setOffline(false);
  await page.reload();
  await login(page);
  await expect(page.locator('input[data-zone="fridge"]')).toHaveValue("2.5");
  await page.locator("#submit").click();
  await expect(page.locator("#pending-panel")).toBeHidden();
  await expect(page.locator("#products")).toContainText("2.5 l");
});
test("Google mode confirms a lost-reply submission after reload without duplicating counts", async ({
  page,
}) => {
  const backend = await mockGoogle(page);
  await page.goto(path);
  await login(page);
  await startCount(page);
  backend.dropSubmit = true;
  await page.locator("#submit").click();
  await expect(page.locator("#message")).toContainText(
    "GOOGLE_EXECUTION_FAILED",
  );
  await expect(page.locator("#pending-panel")).toBeVisible();
  await expect(page.locator('input[data-zone="fridge"]')).toBeDisabled();
  expect(backend.submissions).toBe(1);
  await page.reload();
  await login(page);
  await expect(page.locator("#pending-panel")).toBeVisible();
  await page.locator("#retry").click();
  await expect(page.locator("#pending-panel")).toBeHidden();
  expect(backend.submissions).toBe(1);
  expect(backend.calls.filter((method) => method === "submit")).toHaveLength(1);
});
test("Google mode requires explicit review of a second-device change before submitting", async ({
  page,
}) => {
  const backend = await mockGoogle(page);
  await page.goto(path);
  await login(page);
  await startCount(page);
  backend.product.last = 9;
  backend.product.revision = "second-device-change";
  await page.locator("#refresh").click();
  await expect(page.locator("#conflicts-panel")).toBeVisible();
  await expect(page.locator("#submit")).toBeDisabled();
  await expect(page.locator('input[data-zone="fridge"]')).toHaveValue("1.25");
  await page
    .getByRole("button", { name: "I rechecked — keep entered count" })
    .click();
  await expect(page.locator("#conflicts-panel")).toBeHidden();
  await page.locator("#submit").click();
  await expect(page.locator("#products")).toContainText("1.25 l");
  expect(backend.submissions).toBe(1);
});

test("Google staged checklist changes travel in the same count envelope and cached information works offline", async ({
  page,
  context,
}) => {
  const backend = await mockGoogle(page);
  backend.information.notes.push({
    id: "offline-note",
    text: "Saved team reminder",
    done: false,
    version: "v1",
  });
  await page.goto(path);
  await login(page);
  await page.locator("#start").click();
  await expect(page.locator("#message")).toContainText("Session opened");
  await page.locator('[data-view="catalog"]').click();
  await page
    .getByRole("button", { name: "Stage status/zones with this count" })
    .click();
  await page
    .locator("#feature-form")
    .getByLabel("Холодильник / Refrigerator", { exact: true })
    .uncheck();
  await page
    .locator("#feature-form")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.locator("#feature-dialog")).not.toBeVisible();
  await page.locator('[data-view="stock"]').click();
  await expect(page.locator('input[data-zone="fridge"]')).toHaveCount(0);
  await page.locator('input[data-zone="shelf"]').fill("3");
  await page.locator("#submit").click();
  await expect(page.locator("#pending-panel")).toBeHidden();
  expect(backend.lastCountRequest.productChanges[0].zones).toEqual(["shelf"]);
  expect(backend.lastCountRequest.items[0].locations[0].value).toBe("3");
  await page.locator('[data-view="information"]').click();
  await expect(page.locator("#feature-content")).toContainText(
    "Saved team reminder",
  );
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await page.locator('[data-view="information"]').click();
  await expect(page.locator("#feature-content")).toContainText(
    "Saved team reminder",
  );
  await expect(
    page.getByRole("button", { name: "Add reminder", exact: true }),
  ).toBeDisabled();
});

test("Google sessions resume an owned checklist and UNKNOWN feature outcomes never auto-reexecute", async ({
  page,
}) => {
  const backend = await mockGoogle(page);
  await page.goto(path);
  await login(page);
  backend.session = {
    id: "existing-session-123456789",
    by: email,
    status: "OPEN",
    created: new Date().toISOString(),
    items: [{ ...backend.product, checked: false }],
  };
  await page.locator("#refresh").click();
  await page.locator('[data-view="sessions"]').click();
  await page.getByRole("button", { name: "Resume session" }).click();
  await expect(page.locator('input[data-zone="fridge"]')).toBeVisible();
  const pending = {
    id: "unknown-operation-123456789",
    kind: "profile",
    payload: { name: "Uncertain name" },
  };
  backend.operations.set(pending.id, { status: "UNKNOWN" });
  await page.evaluate((pending) => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("varka-google:https://"),
    );
    const record = JSON.parse(localStorage.getItem(key));
    record.featurePending = pending;
    localStorage.setItem(key, JSON.stringify(record));
  }, pending);
  await page.reload();
  await login(page);
  await page.locator("#retry").click();
  await expect(page.locator("#message")).toContainText(
    "still running or uncertain",
  );
  await expect(page.locator("#pending-panel")).toBeVisible();
  expect(backend.calls.filter((method) => method === "mutate")).toHaveLength(0);
});
