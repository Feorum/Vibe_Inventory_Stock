import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";

const endpoint = "https://script.google.com/macros/s/WORKSPACE-TEST/exec";
const inner = "https://n-workspace-script.googleusercontent.com";
const origin = "http://127.0.0.1:3100";
const appPath = "/Vibe_Inventory_Stock/";
const email = "staff@example.test";
const password = "test-private-code-never-persist-this";
const template = await readFile(
  new URL("../../apps-script/PwaBridge.html", import.meta.url),
  "utf8",
);

// Only this in-memory fake database is mutated by these integration checks.
// The real iframe transport, CSP, rendering, and browser storage are exercised.
async function mockWorkspace(
  page,
  { owner = true, telegramConfigured = true } = {},
) {
  page.on("dialog", (dialog) => dialog.accept());
  const product = (id, ru, en, extra = {}) => ({
    id,
    ru,
    en,
    category: "Dairy",
    unit: "l",
    zones: ["fridge"],
    active: true,
    minimum: null,
    reminderHours: 24,
    stockVersion: `${id}-stock-1`,
    countVersion: `${id}-count-1`,
    catalogVersion: `${id}-catalog-1`,
    last: 5,
    lastCountedAt: "2026-10-28T12:00:00.000Z",
    approx: false,
    low: false,
    ...extra,
  });
  const backend = {
    timeZone: "Europe/Minsk",
    serverNow: new Date().toISOString(),
    zones: [
      { id: "fridge", ru: "Холодильник", en: "Refrigerator" },
      { id: "shelf", ru: "Полка", en: "Shelf" },
    ],
    databaseId: "safe-workspace-test-database",
    products: [
      product("P001", "Молоко", "Milk", { zones: ["fridge", "shelf"] }),
      product("P002", "Кофе", "Coffee", {
        unit: "kg",
        category: "Coffee",
        zones: ["shelf"],
      }),
      product("P003", "Стаканы", "Cups", {
        unit: "pcs",
        category: "Packaging",
        zones: ["shelf"],
        active: false,
      }),
    ],
    notes: [],
    categories: ["Dairy", "Coffee", "Packaging"],
    cards: [
      {
        id: "A1",
        name: "Existing A card",
        category: "A",
        note: "",
        size: "",
        by: email,
        authorName: "Test staff",
      },
      {
        id: "C2",
        name: "Existing C card",
        category: "C",
        note: "",
        size: "",
        by: email,
        authorName: "Test staff",
      },
      {
        id: "D1",
        name: "Existing D card",
        category: "D",
        note: "",
        size: "",
        by: email,
        authorName: "Test staff",
      },
    ],
    profile: { email, name: "Test staff" },
    requests: [],
    committed: new Map(),
    notifications: new Map(),
    saves: 0,
    telegramSends: 0,
    notificationFail: false,
    notificationUnknown: false,
    countResponseLost: false,
    failLoad: false,
    heldCount: null,
    heldLoad: null,
    telegram: {
      configured: telegramConfigured,
      tokenConfigured: telegramConfigured,
      chatConfigured: telegramConfigured,
      canTest: owner,
      writesEnabled: true,
    },
    telegramTests: new Map(),
    telegramTestSends: 0,
    telegramTestUnknown: false,
    telegramTestFail: false,
    telegramTestResponseLost: false,
  };
  const snapshot = () =>
    structuredClone({
      databaseId: backend.databaseId,
      timeZone: backend.timeZone,
      products: backend.products,
      zones: backend.zones,
      categories: backend.categories,
      notes: backend.notes,
      cards: backend.cards,
      profile: backend.profile,
      reminders: { configured: true },
      telegram: {
        ...backend.telegram,
        canTest: owner && backend.profile.email === email,
      },
      permissions: { write: true, manageReminders: owner },
    });
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
      const mock = `<script>window.google={script:{get run(){let success,failure;return {withSuccessHandler(fn){success=fn;return this},withFailureHandler(fn){failure=fn;return this},pwaDispatch(request){fetch('/rpc',{method:'POST',body:JSON.stringify(request)}).then(response=>response.json()).then(success).catch(failure)}}}}};</script>`;
      await route.fulfill({
        contentType: "text/html",
        body: template
          .replace(
            "<?!= configuration ?>",
            JSON.stringify({
              origin,
              channel: url.searchParams.get("channel"),
            }),
          )
          .replace("<body>", `<body>${mock}`),
      });
      return;
    }
    const request = route.request().postDataJSON();
    backend.requests.push(structuredClone(request));
    const body = request.body || {};
    let data;
    if (request.method === "ping")
      data = { protocol: 1, workspace: 1, writesEnabled: true };
    else if (request.method === "workspaceLogin") {
      if ((body.username || body.email) === "other@example.test")
        backend.profile = { email: "other@example.test", name: "Other staff" };
      else backend.profile = { email, name: "Test staff" };
      data = { ...backend.profile, token: "workspace-memory-token" };
    } else if (request.method === "logout") data = true;
    else if (request.token !== "workspace-memory-token") {
      await route.fulfill({ json: { ok: false, error: "SIGN_IN_REQUIRED" } });
      return;
    } else if (request.method === "workspaceLoad") {
      if (backend.heldLoad) await backend.heldLoad;
      if (backend.failLoad) {
        await route.fulfill({
          json: { ok: false, error: "GOOGLE_REQUEST_FAILED" },
        });
        return;
      }
      data = snapshot();
    } else if (request.method === "workspaceCount") {
      if (backend.heldCount) await backend.heldCount;
      if (backend.committed.has(body.id)) data = backend.committed.get(body.id);
      else {
        data = {
          id: body.id,
          state: "COMMITTED",
          accepted: [],
          failed: [],
          conflicted: [],
          notification: { status: "READY" },
        };
        for (const item of body.items) {
          const current = backend.products.find((p) => p.id === item.id);
          if (
            !current ||
            current.stockVersion !== item.stockVersion ||
            current.countVersion !== item.countVersion
          ) {
            data.conflicted.push({
              id: item.id,
              editVersion: item.editVersion,
              error: !current ? "PRODUCT_DELETED" : "CONFLICT",
              current,
            });
            continue;
          }
          current.last = item.locations.reduce(
            (sum, zone) => sum + Number(zone.value),
            0,
          );
          current.stockVersion = `${current.id}-stock-${backend.saves + 2}`;
          current.lastCountedAt = backend.serverNow;
          current.approx = item.approx;
          current.low = item.low;
          data.accepted.push({
            id: item.id,
            editVersion: item.editVersion,
            last: current.last,
            lastCountedAt: current.lastCountedAt,
            stockVersion: current.stockVersion,
            catalogVersion: current.catalogVersion,
            approx: current.approx,
            low: current.low,
          });
          backend.saves++;
        }
        backend.committed.set(body.id, structuredClone(data));
        backend.notifications.set(body.id, { status: "READY" });
      }
      if (backend.countResponseLost) {
        backend.countResponseLost = false;
        await route.fulfill({
          json: { ok: false, error: "GOOGLE_REQUEST_FAILED" },
        });
        return;
      }
    } else if (request.method === "workspaceStatus") {
      data = backend.telegramTests.has(body.id)
        ? { status: "COMMITTED", result: backend.telegramTests.get(body.id) }
        : backend.committed.has(body.id)
          ? {
              status: "COMMITTED",
              result: {
                ...backend.committed.get(body.id),
                notification: backend.notifications.get(body.id),
              },
            }
          : { status: "ABSENT" };
    } else if (request.method === "workspaceTelegramTest") {
      if (!owner || backend.profile.email !== email) {
        await route.fulfill({ json: { ok: false, error: "OWNER_ONLY" } });
        return;
      }
      let result = backend.telegramTests.get(body.id);
      if (
        !result ||
        ["READY", "FAILED", "NOT_CONFIGURED"].includes(
          result.notification.status,
        )
      ) {
        const state = !backend.telegram.configured
          ? "NOT_CONFIGURED"
          : backend.telegramTestUnknown
            ? "UNKNOWN"
            : backend.telegramTestFail
              ? "FAILED"
              : "SENT";
        result = {
          id: body.id,
          state: "COMMITTED",
          notification: {
            status: state,
            language: body.language,
            scope: "TEST",
            delivered: state === "SENT" ? 1 : 0,
            total: 1,
          },
        };
        backend.telegramTests.set(body.id, structuredClone(result));
        if (state === "SENT") backend.telegramTestSends++;
      }
      data = structuredClone(result);
      if (backend.telegramTestResponseLost) {
        backend.telegramTestResponseLost = false;
        await route.fulfill({
          json: { ok: false, error: "GOOGLE_REQUEST_FAILED" },
        });
        return;
      }
    } else if (request.method === "workspaceNotify") {
      if (backend.telegramTests.has(body.id)) {
        if (!owner || backend.profile.email !== email) {
          await route.fulfill({ json: { ok: false, error: "OWNER_ONLY" } });
          return;
        }
        const result = backend.telegramTests.get(body.id);
        if (!["SENT", "UNKNOWN"].includes(result.notification.status)) {
          result.notification.status = backend.telegramTestUnknown
            ? "UNKNOWN"
            : backend.telegramTestFail
              ? "FAILED"
              : "SENT";
          if (result.notification.status === "SENT")
            backend.telegramTestSends++;
        }
        await route.fulfill({ json: { ok: true, data: result.notification } });
        return;
      }
      const current = backend.notifications.get(body.id) || {
        status: "NOT_CONFIGURED",
      };
      if (current.status !== "SENT") {
        if (backend.notificationUnknown) current.status = "UNKNOWN";
        else if (backend.notificationFail) current.status = "FAILED";
        else {
          current.status = "SENT";
          backend.telegramSends++;
        }
      }
      backend.notifications.set(body.id, current);
      data = current;
    } else if (request.method === "workspaceCatalog") {
      const change = body.product;
      let current = backend.products.find((p) => p.id === change.id);
      if (current && current.catalogVersion !== change.catalogVersion) {
        await route.fulfill({ json: { ok: false, error: "CONFLICT" } });
        return;
      }
      if (body.action === "delete") {
        backend.products = backend.products.filter((p) => p.id !== change.id);
        data = { deleted: change.id };
      } else {
        if (!current) {
          current = product(
            `P${backend.products.length + 1}`,
            change.ru,
            change.en,
            { last: null, lastCountedAt: null },
          );
          backend.products.push(current);
        }
        const oldSpec = JSON.stringify([
          current.active,
          current.unit,
          current.zones,
        ]);
        Object.assign(current, change, {
          catalogVersion: `${body.id}-catalog`,
        });
        if (
          oldSpec !==
          JSON.stringify([current.active, current.unit, current.zones])
        )
          current.countVersion = `${body.id}-count`;
        data = { product: structuredClone(current) };
      }
    } else if (request.method === "workspaceTeam") {
      if (body.kind === "card") {
        const cardCode = String(body.code || "")
          .trim()
          .toUpperCase();
        const error = !/^[A-ZА-Я]{0,3}[1-9]\d{0,5}$/.test(cardCode)
          ? "INVALID_CARD_NUMBER"
          : backend.cards.some((card) => card.id === cardCode)
            ? "CARD_EXISTS"
            : null;
        if (error) {
          await route.fulfill({ json: { ok: false, error } });
          return;
        }
        body.code = cardCode;
      }
      if (body.kind === "note")
        backend.notes.push({
          id: body.id,
          text: body.text,
          by: backend.profile.email,
          authorName: backend.profile.name,
          created: new Date().toISOString(),
        });
      else
        backend.cards.push({
          id: body.code,
          name: body.name,
          size: body.size,
          category: body.category,
          note: body.note,
          by: email,
          authorName: "Test staff",
        });
      data = { ok: true };
    } else throw Error(`Unhandled workspace RPC ${request.method}`);
    await route.fulfill({ json: { ok: true, data } });
  });
  return backend;
}

async function login(page, username = email) {
  await page.locator("#endpoint").fill(endpoint);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
}
const card = (page, id) =>
  page.locator(`.product-card[data-product-id="${id}"]`);
async function openAdditional(page, id) {
  const details = card(page, id)
    .locator("details")
    .filter({
      has: page.getByLabel("Low", { exact: true }),
    });
  await expect(details).toHaveCount(1);
  if (!(await details.evaluate((element) => element.open)))
    await details.locator(":scope > summary").click();
  return details;
}
async function applyStockFilters(page, { zone, category } = {}) {
  await page.locator("#stock-filter-button").click();
  const sheet = page.locator('#workspace-dialog[data-kind="filters"]');
  await expect(sheet).toBeVisible();
  if (zone !== undefined)
    await sheet
      .getByRole("combobox", { name: "Location", exact: true })
      .selectOption(zone);
  if (category !== undefined)
    await sheet
      .getByRole("combobox", { name: "Category", exact: true })
      .selectOption(category);
  await sheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(sheet).not.toBeVisible();
}
async function resetStockFilters(page) {
  await page.locator("#stock-filter-button").click();
  const sheet = page.locator('#workspace-dialog[data-kind="filters"]');
  await sheet
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await sheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(sheet).not.toBeVisible();
}
async function openRecountMenu(page) {
  await page.locator("#recount-menu").click();
  const menu = page.locator('#workspace-dialog[data-kind="recount"]');
  await expect(menu).toBeVisible();
  return menu;
}
async function enterMilk(page, first = "1,25", second = "0") {
  await card(page, "P001").locator('[data-zone="fridge"]').fill(first);
  await card(page, "P001").locator('[data-zone="shelf"]').fill(second);
}
async function openConfirmation(page) {
  await page
    .getByRole("button", { name: "Synchronize quantity", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function send(page) {
  await openConfirmation(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send", exact: true })
    .click();
}

async function showCards(page) {
  await page.getByRole("tab", { name: "Yellow Cards", exact: true }).click();
}
async function expandCardGroup(page, category) {
  const group = page.locator(".card-group").filter({
    has: page.getByRole("heading", { name: category, exact: true }),
  });
  if (!(await group.evaluate((element) => element.open)))
    await group.locator(":scope > summary").click();
  return group;
}

test("session-free drafts survive all filters, navigation, refresh, reload, and offline use", async ({
  page,
  context,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await expect(page.locator("[data-view]")).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: /Start.*session/i }),
  ).toHaveCount(0);
  await enterMilk(page);
  await openAdditional(page, "P001");
  await card(page, "P001").getByLabel("Approximate", { exact: true }).check();
  await page.getByLabel("Search products", { exact: true }).fill("coffee");
  await expect(card(page, "P001")).toHaveCount(0);
  await expect(card(page, "P002")).toBeVisible();
  await resetStockFilters(page);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "1,25",
  );
  await page.locator('[data-view="team"]').click();
  await showCards(page);
  await expandCardGroup(page, "A");
  await expect(page.getByText(/Existing A card/)).toBeVisible();
  await page.locator('[data-view="stock"]').click();
  backend.products[1].last = 8;
  await page
    .getByRole("button", { name: "Synchronize database", exact: true })
    .click();
  await expect(card(page, "P001").locator('[data-zone="shelf"]')).toHaveValue(
    "0",
  );
  await page.reload();
  await login(page);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "1,25",
  );
  await expect(
    card(page, "P001").getByLabel("Approximate", { exact: true }),
  ).toBeChecked();
  await context.setOffline(true);
  await card(page, "P001").locator('[data-zone="fridge"]').fill("2,5");
  await page.locator('[data-view="catalog"]').click();
  await page.locator('[data-view="stock"]').click();
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "2,5",
  );
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page
    .getByRole("button", { name: "Use saved inventory offline", exact: true })
    .click();
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "2,5",
  );
  await context.setOffline(false);
  expect(backend.saves).toBe(0);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain(password);
  expect(storage).not.toContain("workspace-memory-token");
});

test("blank flags never become counts; zero and locale decimals save all entered products despite filters", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "1,25", "0");
  await openAdditional(page, "P001");
  await card(page, "P001").getByLabel("Approximate", { exact: true }).check();
  await openAdditional(page, "P002");
  await card(page, "P002").getByLabel("Low", { exact: true }).check();
  await card(page, "P003").locator('[data-zone="shelf"]').fill("0");
  await page.getByLabel("Search products", { exact: true }).fill("coffee");
  await openConfirmation(page);
  await page
    .getByRole("dialog")
    .getByLabel("Only items marked Low", { exact: true })
    .check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await expect.poll(() => backend.saves).toBe(2);
  const submitted = backend.requests.find(
    (r) => r.method === "workspaceCount",
  ).body;
  expect(submitted.items.map((p) => p.id)).toEqual(["P001", "P003"]);
  expect(submitted.items[0].locations.map((z) => z.value)).toEqual([
    "1.25",
    "0",
  ]);
  expect(submitted.items[0].approx).toBe(true);
  expect(submitted.notification.scope).toBe("LOW");
  expect(submitted.notification.language).toBe("ru");
  expect(submitted.notification.lowIds).toContain("P002");
  await resetStockFilters(page);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "",
  );
  await expect(card(page, "P003").locator('[data-zone="shelf"]')).toHaveValue(
    "",
  );
  await expect(
    card(page, "P002").getByLabel("Low", { exact: true }),
  ).toBeChecked();
});

test("edits made while a count is in flight survive its acknowledgment", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  let release;
  backend.heldCount = new Promise((resolve) => {
    release = resolve;
  });
  await page.goto(appPath);
  await login(page);
  await enterMilk(page);
  await send(page);
  await expect
    .poll(
      () =>
        backend.requests.filter((r) => r.method === "workspaceCount").length,
    )
    .toBe(1);
  await card(page, "P001").locator('[data-zone="fridge"]').fill("9");
  release();
  await expect.poll(() => backend.saves).toBe(1);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "9",
  );
  expect(backend.products[0].last).toBe(1.25);
});

test("remote count conflicts and remote deletion preserve local values for explicit resolution", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await enterMilk(page);
  backend.products[0].stockVersion = "other-user-count";
  await send(page);
  await expect.poll(() => backend.committed.size).toBe(1);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "1,25",
  );
  expect(backend.saves).toBe(0);
  await expect(
    page.getByRole("button", { name: /Review conflict/ }).first(),
  ).toBeVisible();
  backend.products = backend.products.filter((p) => p.id !== "P001");
  await page
    .getByRole("button", { name: "Synchronize database", exact: true })
    .click();
  const stored = await page.evaluate(() =>
    Object.values(localStorage).join(" "),
  );
  expect(stored).toContain("1,25");
  await expect(page.getByText(/deleted/i).first()).toBeVisible();
});

test("a lost count response retries its original ID and Telegram failure never repeats the stock save", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  backend.countResponseLost = true;
  backend.notificationFail = true;
  await page.goto(appPath);
  await login(page);
  await enterMilk(page);
  await send(page);
  await expect.poll(() => backend.saves).toBe(1);
  await page.getByRole("button", { name: "Retry safely", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.requests.filter((r) => r.method === "workspaceNotify").length,
    )
    .toBeGreaterThan(0);
  expect(backend.saves).toBe(1);
  const countIds = backend.requests
    .filter((r) => r.method === "workspaceCount")
    .map((r) => r.body.id);
  expect(new Set(countIds).size).toBe(1);
  backend.notificationFail = false;
  await page.getByRole("button", { name: /Retry.*notification/i }).click();
  await expect.poll(() => backend.telegramSends).toBe(1);
  expect(backend.saves).toBe(1);
});

test("four-page mobile interface has no overflow, accessible names, visible inactive actions, and complete language switching", async ({
  page,
}) => {
  test.setTimeout(60000);
  const backend = await mockWorkspace(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(appPath);
  const audit = async () => {
    const report = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      report.violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  };
  await audit();
  await login(page);
  await expect(
    card(page, "P003").getByText("Inactive", { exact: true }),
  ).toBeVisible();
  await expect(
    card(page, "P003").getByRole("button", { name: "Activate", exact: true }),
  ).toHaveCount(0);
  await expect(
    card(page, "P001").getByText("Active", { exact: true }),
  ).toHaveCount(0);
  await audit();
  await enterMilk(page);
  await openConfirmation(page);
  await audit();
  await page.keyboard.press("Escape");
  await page.locator('[data-view="profile"]').click();
  await page
    .locator("#workspace")
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("ru");
  await expect(page.locator('[data-view="stock"]')).toHaveText("Склад");
  await expect(
    page.getByRole("button", { name: "Synchronize database", exact: true }),
  ).toHaveCount(0);
  await page.locator('[data-view="stock"]').click();
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "1,25",
  );
  await audit();
  expect(backend.saves).toBe(0);
});

test("the full catalog can be searched and location/category filters combine without a hidden item cap", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  const sample = backend.products[1];
  backend.products = Array.from({ length: 137 }, (_, index) => ({
    ...sample,
    id: `P${String(index + 1).padStart(3, "0")}`,
    ru: `Товар ${index + 1}`,
    en: index === 136 ? "Last catalog coffee" : `Product ${index + 1}`,
    category: index % 2 ? "Dairy" : "Coffee",
    zones: index % 3 ? ["fridge"] : ["shelf"],
  }));
  await page.goto(appPath);
  await login(page);
  await expect(page.locator(".product-card")).toHaveCount(137);
  await page
    .getByLabel("Search products", { exact: true })
    .fill("last catalog");
  await expect(card(page, "P137")).toBeVisible();
  await applyStockFilters(page, { zone: "fridge" });
  await expect(card(page, "P137")).toBeVisible();
  await applyStockFilters(page, { category: "Dairy" });
  await expect(page.locator(".product-card")).toHaveCount(0);
  await resetStockFilters(page);
  await expect(page.locator(".product-card")).toHaveCount(137);
  await page.locator('[data-view="catalog"]').click();
  await page
    .getByLabel("Search products", { exact: true })
    .fill("last catalog");
  await expect(page.locator(".product-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(page.locator(".product-card")).toHaveCount(137);
  await expect(page.locator("#message")).not.toHaveClass(/error/);
});

test("switching authenticated accounts and databases never loads another scope's draft", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "3,5", "0");
  await page.locator('[data-view="profile"]').click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await login(page, "other@example.test");
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "",
  );
  await page.locator('[data-view="profile"]').click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  backend.databaseId = "second-safe-workspace-database";
  await login(page);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "",
  );
});

test("a delayed count from a signed-out account cannot enter another account's screen or storage", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  let release;
  backend.heldCount = new Promise((resolve) => {
    release = resolve;
  });
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "7,25", "0");
  await send(page);
  await expect
    .poll(
      () =>
        backend.requests.filter((r) => r.method === "workspaceCount").length,
    )
    .toBe(1);
  await page.locator('[data-view="profile"]').click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await login(page, "other@example.test");
  release();
  await expect.poll(() => backend.saves).toBe(1);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "",
  );
  const otherData = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(
        ([key]) =>
          key.startsWith("varka-workspace:[") &&
          key.includes("other@example.test"),
      )
      .map(([, value]) => value)
      .join("\n"),
  );
  expect(otherData).not.toContain("7,25");
  expect(
    backend.requests.filter((r) => r.method === "workspaceNotify"),
  ).toHaveLength(0);
});

test("catalog conflicts keep form values, and reversible deactivation preserves an affected count draft", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "4,25", "0");
  await page.locator('[data-view="catalog"]').click();
  await card(page, "P001")
    .getByRole("button", { name: "Edit product", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await form.locator('[name="name"]').fill("Edited draft name");
  backend.products[0].catalogVersion = "another-editor-catalog";
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toBeVisible();
  await expect(form.locator('[name="name"]')).toHaveValue("Edited draft name");
  await expect(form.locator(".dialog-error")).toContainText(/changed|edited/i);
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Synchronize database", exact: true })
    .click();
  await card(page, "P001")
    .getByRole("button", { name: "Deactivate", exact: true })
    .click();
  await expect(
    card(page, "P001").getByText("Inactive", { exact: true }),
  ).toBeVisible();
  await page.locator('[data-view="stock"]').click();
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "4,25",
  );
  await expect(
    page.getByRole("button", { name: /Review conflict/ }).first(),
  ).toBeVisible();
  expect(backend.saves).toBe(0);
});

test("clear entered information clears every filtered local draft without changing recorded stock", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await enterMilk(page);
  await openAdditional(page, "P002");
  await card(page, "P002").getByLabel("Low", { exact: true }).check();
  await page.getByLabel("Search products", { exact: true }).fill("coffee");
  const menu = await openRecountMenu(page);
  await menu
    .getByRole("button", { name: "Clear entered information", exact: true })
    .click();
  await resetStockFilters(page);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "",
  );
  await expect(
    card(page, "P002").getByLabel("Low", { exact: true }),
  ).not.toBeChecked();
  expect(backend.products[0].last).toBe(5);
  expect(backend.saves).toBe(0);
});

test("an ambiguous Telegram outcome offers a status check without resending inventory or notification", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  backend.notificationUnknown = true;
  await page.goto(appPath);
  await login(page);
  await enterMilk(page);
  await send(page);
  await expect.poll(() => backend.notifications.size).toBe(1);
  await expect(page.locator("#notification-panel")).toContainText(
    /unconfirmed/i,
  );
  await expect(
    page.getByRole("button", { name: /Retry.*notification/i }),
  ).toHaveCount(0);
  const countId = backend.requests.find((r) => r.method === "workspaceCount")
    .body.id;
  backend.notifications.set(countId, { status: "SENT" });
  await page
    .getByRole("button", { name: "Check delivery status", exact: true })
    .click();
  await expect(page.locator("#notification-panel")).toContainText(
    "Telegram notification sent.",
  );
  expect(
    backend.requests.filter((r) => r.method === "workspaceNotify"),
  ).toHaveLength(1);
  expect(backend.saves).toBe(1);
});

test("Catalog adds, edits minimum and fixed reminders, and deletes only the confirmed selected product", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="catalog"]').click();
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.locator('[name="name"]').fill("Тестовый сироп");
  await form.locator('[name="englishName"]').fill("Test syrup");
  await form.locator('[name="category"]').selectOption("Coffee");
  await form.locator('[name="unit"]').selectOption("pcs");
  await form.locator('[name="minimum"]').fill("0,5");
  await form.getByRole("checkbox", { name: "Shelf", exact: true }).check();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.locator(".dialog-error")).toContainText("whole number");
  expect(
    backend.requests.filter((request) => request.method === "workspaceCatalog"),
  ).toHaveLength(0);
  await expect(form.locator('[name="name"]')).toHaveValue("Тестовый сироп");
  await form.locator('[name="unit"]').selectOption("l");
  await form.locator('[name="minimum"]').fill("2,5");
  await form.getByRole("checkbox", { name: "Shelf", exact: true }).check();
  await form.locator('[name="reminder"]').selectOption("off");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).not.toBeVisible();
  const added = backend.products.find((product) => product.en === "Test syrup");
  expect(added).toBeTruthy();
  expect(added.minimum).toBe(2.5);
  expect(added.reminderHours).toBeNull();
  await card(page, added.id)
    .getByRole("button", { name: "Edit product", exact: true })
    .click();
  await form.locator('[name="minimum"]').fill("3,25");
  await form.locator('[name="reminder"]').selectOption("interval");
  await form.locator('[name="interval"]').fill("2");
  await form.locator('[name="timeUnit"]').selectOption("days");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).not.toBeVisible();
  expect(added.minimum).toBe(3.25);
  expect(added.reminderHours).toBe(48);
  expect(added.last).toBeNull();
  await card(page, added.id)
    .getByRole("button", { name: "Delete product", exact: true })
    .click();
  await expect(card(page, added.id)).toHaveCount(0);
  expect(backend.products.some((product) => product.id === "P001")).toBe(true);
  expect(backend.saves).toBe(0);
});

test("Team adds shared notes and schema-valid Yellow Cards, keeps failed fields, and localizes Russian forms", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="team"]').click();
  const form = page.getByRole("dialog");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await form.locator('[name="noteContent"]').fill("Check delivery on Monday");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Check delivery on Monday", { exact: true }),
  ).toBeVisible();
  expect(backend.notes[0].authorName).toBe("Test staff");
  expect(backend.notes[0].created).toBeTruthy();
  await showCards(page);
  await page
    .getByRole("button", { name: "Add Yellow Card", exact: true })
    .click();
  await form.locator('[name="cardCode"]').fill("A2");
  await form.locator('[name="cardName"]').fill("New A card");
  await form.locator('[name="cardCategory"]').fill("A");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#message")).toContainText("Yellow Card saved.");
  await expect(page.getByText(/New A card/)).toBeVisible();
  for (const section of ["A", "C", "D"])
    await expect(
      page.getByRole("heading", { name: section, exact: true }),
    ).toBeVisible();
  await page
    .getByRole("button", { name: "Add Yellow Card", exact: true })
    .click();
  await form.locator('[name="cardCode"]').fill("A1");
  await form.locator('[name="cardName"]').fill("Preserve this failed card");
  await form.locator('[name="cardCategory"]').fill("A");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.locator(".dialog-error")).toContainText("already exists");
  await expect(form.locator('[name="cardName"]')).toHaveValue(
    "Preserve this failed card",
  );
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator('[data-view="profile"]').click();
  await page
    .locator("#workspace")
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("ru");
  await page.locator('[data-view="team"]').click();
  await page
    .getByRole("button", { name: "Добавить жёлтую карточку", exact: true })
    .click();
  await form.locator('[name="cardCode"]').fill("A0");
  await form.locator('[name="cardName"]').fill("Русское название");
  await form.locator('[name="cardCategory"]').fill("A");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form.locator(".dialog-error")).toContainText("код");
  await expect(
    form.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  expect(backend.cards).toHaveLength(4);
});

test("Stock cannot change active status; Catalog retains Undo and safe directional swipes", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  const drag = async (target, dx, dy, pointerId) => {
    await target.dispatchEvent("pointerdown", {
      clientX: 150,
      clientY: 150,
      pointerId,
    });
    await target.dispatchEvent("pointerup", {
      clientX: 150 + dx,
      clientY: 150 + dy,
      pointerId,
    });
  };
  await expect(
    card(page, "P003").getByRole("button", { name: "Activate", exact: true }),
  ).toHaveCount(0);
  await expect(
    card(page, "P001").getByRole("button", { name: "Deactivate", exact: true }),
  ).toHaveCount(0);
  await drag(card(page, "P001").locator('[data-zone="fridge"]'), -110, 0, 1);
  await drag(card(page, "P003"), 110, 0, 2);
  expect(
    backend.requests.filter((request) => request.method === "workspaceCatalog"),
  ).toHaveLength(0);
  await page.locator('[data-view="catalog"]').click();
  await card(page, "P003")
    .getByRole("button", { name: "Activate", exact: true })
    .click();
  await expect(
    card(page, "P003").getByText("Active", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    card(page, "P003").getByText("Inactive", { exact: true }),
  ).toBeVisible();
  const before = backend.requests.filter(
    (request) => request.method === "workspaceCatalog",
  ).length;
  await drag(card(page, "P001"), -100, 120, 4);
  expect(
    backend.requests.filter((request) => request.method === "workspaceCatalog"),
  ).toHaveLength(before);
  await drag(card(page, "P003"), 110, 0, 5);
  await expect(
    card(page, "P003").getByText("Active", { exact: true }),
  ).toBeVisible();
  await drag(card(page, "P003"), -110, 0, 6);
  await expect(
    card(page, "P003").getByText("Inactive", { exact: true }),
  ).toBeVisible();
});

test("normal-flow search and a compact fixed save bar leave the header out of the counting view", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  const original = structuredClone(backend.products[0]);
  backend.products.push(
    ...Array.from({ length: 72 }, (_, index) => ({
      ...original,
      id: `PX${index + 1}`,
      ru: `Товар ${index + 1}`,
      en: `Scrollable product ${index + 1}`,
    })),
  );
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "6,25", "0");
  const originalWidth = page.viewportSize().width;
  for (const width of new Set([320, 390, originalWidth])) {
    await page.setViewportSize({ width, height: 740 });
    await page.evaluate(() => window.scrollTo(0, 2200));
    const toolbar = page.getByLabel("Search products", { exact: true });
    await expect(toolbar).toBeVisible();
    await expect(
      page.locator("#count-bar input, #count-bar select"),
    ).toHaveCount(0);
    await expect
      .poll(async () => {
        const header = await page.locator("header").boundingBox();
        const filter = await toolbar.boundingBox();
        const dock = await page.locator("#count-bar").boundingBox();
        const nav = await page.locator("#navigation").boundingBox();
        const sync = await page.locator("#synchronize-quantity").boundingBox();
        return Boolean(
          header &&
          header.y + header.height <= 0 &&
          filter &&
          dock &&
          nav &&
          sync &&
          filter.y + filter.height <= 0 &&
          dock.height < 110 &&
          dock.y > 740 * 0.5 &&
          dock.y + dock.height <= nav.y + 2 &&
          sync.y >= dock.y - 1 &&
          sync.y + sync.height <= dock.y + dock.height + 1,
        );
      })
      .toBe(true);
    const sync = await page.locator("#synchronize-quantity").boundingBox();
    expect(sync.height).toBeGreaterThanOrEqual(44);
    expect(sync.height).toBeLessThan(75);
    expect(sync.width).toBeLessThan(width * 0.9);
    expect(sync.y + sync.height).toBeLessThanOrEqual(740);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    const last = card(page, "PX72");
    const lastBounds = await last.boundingBox();
    const dockBounds = await page.locator("#count-bar").boundingBox();
    expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(
      dockBounds.y + 2,
    );
    await last.locator('[data-zone="shelf"]').click();
    await expect(last.locator('[data-zone="shelf"]')).toBeFocused();
  }
  await page.getByLabel("Search products", { exact: true }).fill("milk");
  await applyStockFilters(page, { zone: "fridge", category: "Dairy" });
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "6,25",
  );
  await resetStockFilters(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(card(page, "P001")).toBeVisible();
  const cardSize = await card(page, "P001").boundingBox();
  expect(cardSize.height).toBeLessThan(350);
  expect(cardSize.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: test.info().outputPath("compact-counting-320.png"),
  });
  await page.locator('[data-view="profile"]').click();
  await page
    .locator("#workspace")
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("ru");
  await page.locator('[data-view="stock"]').click();
  await expect(page.locator("#synchronize-quantity")).toContainText(
    "Сохранить пересчёт",
  );
  await page.evaluate(() => (document.documentElement.style.zoom = "2"));
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        right: element.getBoundingClientRect().right,
        width: element.getBoundingClientRect().width,
      }))
      .filter((element) => element.right > innerWidth + 1)
      .slice(0, 12),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    JSON.stringify(overflow),
  ).toBe(true);
  for (const field of await page
    .locator("#count-bar input, #count-bar select, #synchronize-quantity")
    .all()) {
    const bounds = await field.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(-1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(321);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(740);
  }
  expect(backend.saves).toBe(0);
});

test("full-width tappable quantity fields preserve zero and larger decimal drafts across refresh and reload", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(appPath);
  await login(page);
  for (const input of await page.locator(".product-card [data-zone]").all()) {
    const bounds = await input.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    const parent = await input.locator("..").boundingBox();
    expect(Math.abs(parent.width - bounds.width)).toBeLessThanOrEqual(2);
    expect(
      await input.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
    expect(await input.evaluate((element) => element.maxLength)).toBe(-1);
    await expect(input).toHaveAttribute("inputmode", "decimal");
  }
  await enterMilk(page, "123", "0");
  await card(page, "P002").locator('[data-zone="shelf"]').fill("0");
  await card(page, "P003").locator('[data-zone="shelf"]').fill("999");
  await card(page, "P001").locator('[data-zone="fridge"]').fill("1234,5678");
  await page
    .getByRole("button", { name: "Synchronize database", exact: true })
    .click();
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "1234,5678",
  );
  await page.reload();
  await login(page);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "1234,5678",
  );
  await expect(card(page, "P002").locator('[data-zone="shelf"]')).toHaveValue(
    "0",
  );
  await expect(card(page, "P003").locator('[data-zone="shelf"]')).toHaveValue(
    "999",
  );
  await send(page);
  await expect.poll(() => backend.saves).toBe(3);
  expect(backend.products[0].last).toBe(1234.5678);
  expect(backend.products[1].last).toBe(0);
  expect(backend.products[2].last).toBe(999);
});

test("ordinary search remains editable with a short keyboard viewport and never enters the save bar", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(appPath);
  await login(page);
  const search = page.getByLabel("Search products", { exact: true });
  await search.focus();
  await page.setViewportSize({ width: 320, height: 400 });
  await search.fill("milk");
  await expect(search).toBeFocused();
  await expect(page.locator("#count-bar input, #count-bar select")).toHaveCount(
    0,
  );
  const bounds = await search.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(400);
  await expect(card(page, "P001")).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(1);
  await resetStockFilters(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await enterMilk(page, "7,5", "0");
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "7,5",
  );
  expect(backend.saves).toBe(0);
});

test("Team separates notes from compact searchable category groups and preserves collapse choices", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.setViewportSize({ width: 320, height: 740 });
  backend.notes = [
    {
      id: "note-1",
      text: "This shared note must stay separate",
      created: "2026-10-31T10:00:00Z",
      authorName: "Test author",
    },
  ];
  backend.cards[0].size = "250 ml";
  backend.cards[0].note = "Need oat-safe packaging";
  backend.cards.push({
    id: "A2",
    name: "Second A row",
    category: "A",
    size: "350 ml",
    note: "",
    authorName: "Test staff",
  });
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="team"]').click();
  await expect(
    page.getByRole("tab", { name: "Shared notes", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("This shared note must stay separate", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search cards", exact: true }),
  ).toHaveCount(0);
  await showCards(page);
  await page.getByRole("tab", { name: "Yellow Cards", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("tab", { name: "Shared notes", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Yellow Cards", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByText("This shared note must stay separate", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add note", exact: true }),
  ).toHaveCount(0);
  const groupA = await expandCardGroup(page, "A");
  await expect(groupA.locator(".yellow-card-row")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("team-cards-320.png") });
  for (const summary of await groupA.locator(".yellow-card-summary").all()) {
    const bounds = await summary.boundingBox();
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeLessThan(85);
  }
  await groupA.locator(":scope > summary").click();
  await expect(groupA).not.toHaveAttribute("open", "");
  const search = page.getByRole("searchbox", {
    name: "Search cards",
    exact: true,
  });
  await search.fill("oat-safe");
  await expect(page.locator(".yellow-card-row")).toHaveCount(1);
  await expect(
    page.getByText("Existing A card", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".card-group")
      .filter({ has: page.getByRole("heading", { name: "A", exact: true }) }),
  ).toHaveAttribute("open", "");
  await search.fill("C2");
  await expect(page.locator(".yellow-card-row")).toHaveCount(1);
  await expect(
    page.getByText("Existing C card", { exact: true }),
  ).toBeVisible();
  await search.fill("350 ml");
  await expect(page.getByText("Second A row", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Clear card search", exact: true })
    .click();
  const restoredA = page
    .locator(".card-group")
    .filter({ has: page.getByRole("heading", { name: "A", exact: true }) });
  await expect(restoredA).not.toHaveAttribute("open", "");
  await search.fill("no such card");
  await expect(page.locator(".yellow-card-row")).toHaveCount(0);
  await expect(
    page.getByText(/No.*cards.*match|No matching.*cards/i),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Shared notes", exact: true }).click();
  await expect(
    page.getByText("This shared note must stay separate", { exact: true }),
  ).toBeVisible();
  await showCards(page);
  await expect(
    page.getByRole("searchbox", { name: "Search cards", exact: true }),
  ).toHaveValue("no such card");
  await page
    .getByRole("button", { name: "Clear card search", exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 740 });
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    report.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Tips are off by default, persist per account and workbook, and never discard counting drafts", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await expect(page.locator("[data-tip]:visible")).toHaveCount(0);
  await enterMilk(page, "3,75", "0");
  await page.locator('[data-view="profile"]').click();
  const tips = page.getByRole("checkbox", { name: "Tips", exact: true });
  await expect(tips).not.toBeChecked();
  await tips.check();
  await expect(page.locator("[data-tip]:visible").first()).toBeVisible();
  await page.locator('[data-view="stock"]').click();
  await expect(page.locator("[data-tip]:visible").first()).toBeVisible();
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "3,75",
  );
  await page
    .getByRole("button", { name: "Synchronize database", exact: true })
    .click();
  await page.reload();
  await login(page);
  await page.locator('[data-view="profile"]').click();
  await expect(
    page.getByRole("checkbox", { name: "Tips", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await login(page, "other@example.test");
  await page.locator('[data-view="profile"]').click();
  await expect(
    page.getByRole("checkbox", { name: "Tips", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  backend.databaseId = "another-tips-database";
  await login(page);
  await page.locator('[data-view="profile"]').click();
  await expect(
    page.getByRole("checkbox", { name: "Tips", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  backend.databaseId = "safe-workspace-test-database";
  await login(page);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "3,75",
  );
  await page.locator('[data-view="profile"]').click();
  await expect(
    page.getByRole("checkbox", { name: "Tips", exact: true }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: "Tips", exact: true }).uncheck();
  await page.locator('[data-view="stock"]').click();
  await expect(page.locator("[data-tip]:visible")).toHaveCount(0);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "3,75",
  );
  expect(backend.saves).toBe(0);
});

test("owner Telegram setup exposes no credentials and test retry cannot repeat a stock save", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  backend.telegramTestFail = true;
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "8,5", "0");
  await page.locator('[data-view="profile"]').click();
  const panel = page.locator("#telegram-settings");
  await expect(panel).toBeVisible();
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
  await page
    .getByRole("button", { name: "Send test notification", exact: true })
    .click();
  await expect.poll(() => backend.telegramTests.size).toBe(1);
  await expect(page.locator("#telegram-test-retry")).toBeVisible();
  expect(backend.saves).toBe(0);
  expect(backend.notifications.size).toBe(0);
  backend.telegramTestFail = false;
  await page
    .getByRole("button", { name: "Retry test notification only", exact: true })
    .click();
  await expect.poll(() => backend.telegramTestSends).toBe(1);
  const first = backend.requests.find(
    (r) => r.method === "workspaceTelegramTest",
  );
  const retry = backend.requests.find((r) => r.method === "workspaceNotify");
  expect(retry.body.id).toBe(first.body.id);
  await page.locator('[data-view="stock"]').click();
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "8,5",
  );
  expect(
    backend.requests.filter((r) => r.method === "workspaceCount"),
  ).toHaveLength(0);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain(password);
  expect(storage).not.toContain("workspace-memory-token");
});

test("missing Telegram setup and staff permissions cannot send a test message", async ({
  page,
}) => {
  const backend = await mockWorkspace(page, {
    owner: false,
    telegramConfigured: false,
  });
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="profile"]').click();
  const panel = page.locator("#telegram-settings");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/not configured|missing|owner/i);
  await expect(
    page.getByRole("button", { name: "Send test notification", exact: true }),
  ).toHaveCount(0);
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
  expect(backend.telegramTestSends).toBe(0);
  expect(
    backend.requests.filter((r) => r.method === "workspaceTelegramTest"),
  ).toHaveLength(0);
});

test("an owner with missing Telegram properties sees setup guidance but cannot send a bot test", async ({
  page,
}) => {
  const backend = await mockWorkspace(page, { telegramConfigured: false });
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="profile"]').click();
  const panel = page.locator("#telegram-settings");
  await expect(panel).toContainText("TELEGRAM_TOKEN");
  await expect(panel).toContainText("TELEGRAM_CHAT_ID");
  await expect(
    page.getByRole("button", { name: "Send test notification", exact: true }),
  ).toBeDisabled();
  await expect(panel.locator("input")).toHaveCount(0);
  expect(backend.telegramTestSends).toBe(0);
});

test("an unconfirmed Telegram test reply is checked without resending the bot message", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  backend.telegramTestUnknown = true;
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="profile"]').click();
  await page
    .getByRole("button", { name: "Send test notification", exact: true })
    .click();
  await expect.poll(() => backend.telegramTests.size).toBe(1);
  await expect(page.locator("#telegram-test-check")).toBeVisible();
  const [id, result] = [...backend.telegramTests.entries()][0];
  result.notification.status = "SENT";
  backend.telegramTests.set(id, result);
  await page
    .getByRole("button", { name: "Check delivery status", exact: true })
    .click();
  await expect(page.locator("#telegram-test-check")).toHaveCount(0);
  expect(backend.telegramTestSends).toBe(0);
  expect(
    backend.requests.filter((r) => r.method === "workspaceTelegramTest"),
  ).toHaveLength(1);
  expect(
    backend.requests.filter((r) => r.method === "workspaceNotify"),
  ).toHaveLength(0);
  expect(backend.saves).toBe(0);
});

test("a lost Telegram test response resumes its original request without delivering a duplicate message", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  backend.telegramTestResponseLost = true;
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="profile"]').click();
  await page
    .getByRole("button", { name: "Send test notification", exact: true })
    .click();
  await expect.poll(() => backend.telegramTestSends).toBe(1);
  await expect(
    page.getByRole("button", { name: "Retry safely", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry safely", exact: true }).click();
  await expect(page.locator("#telegram-settings")).toContainText(
    "Telegram test message delivered.",
  );
  const requests = backend.requests.filter(
    (request) => request.method === "workspaceTelegramTest",
  );
  expect(requests).toHaveLength(2);
  expect(new Set(requests.map((request) => request.body.id)).size).toBe(1);
  expect(backend.telegramTestSends).toBe(1);
  expect(backend.saves).toBe(0);
});

test("filter sheet applies transactionally, restores focus, supports category objects and removable chips", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  backend.categories = [
    { id: "Dairy", name: "Dairy products" },
    { id: "Coffee", name: "Coffee products" },
  ];
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "2,5", "0");
  const trigger = page.locator("#stock-filter-button");
  await trigger.click();
  const sheet = page.locator('#workspace-dialog[data-kind="filters"]');
  await expect(sheet).toHaveClass(/bottom-sheet/);
  await sheet
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption({ label: "Coffee products" });
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(page.locator(".product-card:visible")).toHaveCount(3);
  await applyStockFilters(page, { zone: "fridge", category: "Dairy" });
  await expect(trigger).toBeFocused();
  await expect(page.locator(".product-card:visible")).toHaveCount(1);
  await expect(
    page.locator('#selected-stock-filters [data-filter="zone"]'),
  ).toContainText("Refrigerator");
  await page.locator('#selected-stock-filters [data-filter="zone"]').click();
  await expect(
    page.locator('#selected-stock-filters [data-filter="zone"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('#selected-stock-filters [data-filter="category"]'),
  ).toHaveCount(1);
  await page.getByLabel("Search products", { exact: true }).fill("milk");
  await page.getByLabel("Only unchecked", { exact: true }).check();
  await trigger.click();
  await sheet
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(page.getByLabel("Search products", { exact: true })).toHaveValue(
    "milk",
  );
  await expect(
    page.getByLabel("Only unchecked", { exact: true }),
  ).toBeChecked();
  await resetStockFilters(page);
  await expect(page.getByLabel("Search products", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByLabel("Only unchecked", { exact: true }),
  ).not.toBeChecked();
  await expect(page.locator(".product-card:visible")).toHaveCount(3);
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "2,5",
  );
  // Apply after an intervening refresh must update the current, not detached list.
  backend.categories = undefined;
  const refreshed = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes('"method":"workspaceLoad"') &&
      response.request().method() === "POST",
  );
  await page.locator("#refresh").click();
  await refreshed;
  let releaseLoad;
  backend.heldLoad = new Promise((resolve) => (releaseLoad = resolve));
  const secondRefresh = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes('"method":"workspaceLoad"') &&
      response.request().method() === "POST",
  );
  await page.locator("#refresh").click();
  await trigger.click();
  await sheet
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption("Coffee");
  // The app allows the pending background read to finish while a sheet is open.
  releaseLoad();
  await secondRefresh;
  await expect(page.locator("#refresh")).not.toBeDisabled();
  await expect(page.locator("#message")).toContainText("Database refreshed");
  await sheet
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(card(page, "P002")).toBeVisible();
  await expect(card(page, "P001")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(backend.saves).toBe(0);
});

test("unchecked progress preserves typing focus, distinguishes zero and incomplete flags, and never narrows saving", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await expect(page.locator("#count-progress")).toHaveText("0 of 3 ready");
  await openAdditional(page, "P002");
  await card(page, "P002").getByLabel("Low", { exact: true }).check();
  await expect(
    card(page, "P002").locator(".additional-indicator"),
  ).toContainText("1 selected");
  await page.getByLabel("Only unchecked", { exact: true }).check();
  const first = card(page, "P001").locator('[data-zone="fridge"]');
  const second = card(page, "P001").locator('[data-zone="shelf"]');
  await first.fill("0");
  await expect(page.locator("#count-progress")).toHaveText("0 of 3 ready");
  await second.fill("0");
  await expect(page.locator("#count-progress")).toHaveText("1 of 3 ready");
  await expect(second).toBeFocused();
  await second.pressSequentially("123");
  await expect(second).toHaveValue("0123");
  await expect(second).toBeFocused();
  await second.fill("0");
  const coffee = card(page, "P002").locator('[data-zone="shelf"]');
  await coffee.fill("1,25");
  await expect(coffee).toBeFocused();
  await expect(card(page, "P001")).not.toBeVisible();
  await expect(page.locator("#count-progress")).toHaveText("2 of 3 ready");
  const cups = card(page, "P003").locator('[data-zone="shelf"]');
  await cups.fill("-1");
  await expect(coffee).not.toBeVisible();
  await expect(page.locator("#count-progress")).toHaveText("2 of 3 ready");
  await cups.fill("0.5");
  await expect(page.locator("#count-progress")).toHaveText("2 of 3 ready");
  await cups.fill("");
  await page.getByLabel("Search products", { exact: true }).fill("cups");
  await openConfirmation(page);
  await expect(
    page.getByRole("dialog").locator(".summary > div").first(),
  ).toHaveText("2Entered");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await expect.poll(() => backend.saves).toBe(2);
  const submitted = backend.requests.find(
    (request) => request.method === "workspaceCount",
  ).body;
  expect(submitted.items.map((item) => item.id).sort()).toEqual([
    "P001",
    "P002",
  ]);
  expect(backend.products[0].last).toBe(0);
  expect(backend.products[1].last).toBe(1.25);
  expect(backend.products[2].last).toBe(5);
});

test("compact delivered notices dismiss per request while later failures and unknown deliveries remain visible", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "3", "0");
  await send(page);
  const notices = page.locator("#notification-panel");
  await expect(notices).toContainText("Telegram notification sent.");
  await expect(notices).toHaveClass(/notification-compact/);
  await notices
    .getByRole("button", {
      name: "Dismiss delivered notification",
      exact: true,
    })
    .click();
  await expect(notices).not.toBeVisible();
  await page.reload();
  await login(page);
  await expect(notices).not.toBeVisible();
  backend.notificationFail = true;
  await enterMilk(page, "4", "0");
  await send(page);
  await expect(notices).toContainText("Telegram failed");
  await expect(
    notices.getByRole("button", {
      name: "Dismiss delivered notification",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.locator('[data-view="team"]').click();
  await expect(
    notices.getByRole("button", {
      name: "Retry notification only",
      exact: true,
    }),
  ).toBeVisible();
  await page.locator('[data-view="stock"]').click();
  backend.notificationFail = false;
  backend.notificationUnknown = true;
  await enterMilk(page, "5", "0");
  await send(page);
  await expect(notices).toContainText("Telegram delivery is unconfirmed");
  await expect(
    notices.getByRole("button", { name: "Check delivery status", exact: true }),
  ).toBeVisible();
  await expect(
    notices.getByRole("button", {
      name: "Retry notification only",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await login(page);
  await expect(notices).toContainText("Telegram failed");
  await expect(notices).toContainText("Telegram delivery is unconfirmed");
  expect(backend.saves).toBe(3);
  expect(backend.telegramSends).toBe(1);
});

test("compact Russian cards expose full timestamps, selected flags, safe backup menu and keyboard clearance", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="profile"]').click();
  await page
    .locator("#workspace")
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("ru");
  await page.locator('[data-view="stock"]').click();
  await expect(page.locator("#refresh")).toHaveText("Обновить");
  const milk = card(page, "P001");
  await expect(milk.locator(".quantity-caption").first()).toHaveText(
    "Холодильник, л",
  );
  await expect(milk.getByText("Активен", { exact: true })).toHaveCount(0);
  const recorded = milk.locator(".recorded-details");
  await expect(recorded.locator("summary")).toContainText("Последний остаток:");
  await recorded.locator("summary").click();
  await expect(recorded.locator("p")).toContainText("2026");
  const additional = milk.locator(".additional-controls");
  await additional.locator("summary").click();
  await milk.getByLabel("Примерно", { exact: true }).check();
  await expect(additional.locator("summary")).toContainText("Выбрано: 1");
  await page.screenshot({
    path: test.info().outputPath("compact-counting-390-ru.png"),
  });
  await page.locator("#stock-filter-button").click();
  await page.screenshot({
    path: test.info().outputPath("compact-filters-390-ru.png"),
  });
  await page.keyboard.press("Escape");
  await page.locator("#recount-menu").click();
  const menu = page.locator('#workspace-dialog[data-kind="recount"]');
  const downloadReady = page.waitForEvent("download");
  await menu
    .getByRole("button", {
      name: "Скачать резервную копию пересчёта",
      exact: true,
    })
    .click();
  expect((await downloadReady).suggestedFilename()).toMatch(/\.json$/);
  const field = milk.locator('[data-zone="fridge"]');
  await field.focus();
  await page.setViewportSize({ width: 390, height: 400 });
  await field.fill("123");
  await expect(field).toBeFocused();
  await expect(page.locator("#count-bar")).not.toBeVisible();
  await expect(page.locator("#navigation")).not.toBeVisible();
  const bounds = await field.boundingBox();
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(400);
  expect(backend.saves).toBe(0);
});

test("count feedback distinguishes partial drafts, shows totals and local errors, and Next keeps draft values", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  const milk = card(page, "P001");
  const fridge = milk.locator('[data-zone="fridge"]');
  const shelf = milk.locator('[data-zone="shelf"]');
  await fridge.fill("1,25");
  await expect(milk.locator(".count-feedback")).toContainText(
    "Filled 1 of 2 locations",
  );
  await expect(milk).not.toHaveClass(/draft-complete/);
  await expect(fridge).toHaveAttribute("enterkeyhint", "next");
  await fridge.press("Enter");
  await expect(shelf).toBeFocused();
  await shelf.fill("-1");
  await expect(shelf).toHaveAttribute("aria-invalid", "true");
  await expect(shelf).toHaveValue("-1");
  await expect(shelf.locator("..").locator(".field-error")).toContainText(
    "nonnegative",
  );
  await shelf.fill("2.25");
  await expect(shelf).not.toHaveAttribute("aria-invalid", "true");
  await expect(milk).toHaveClass(/draft-complete/);
  await expect(milk.locator(".count-feedback")).toContainText("In draft");
  await expect(milk.locator(".count-feedback")).toContainText("3.5 l");
  await page.locator('[data-view="catalog"]').click();
  await page.locator('[data-view="stock"]').click();
  await expect(fridge).toHaveValue("1,25");
  await expect(shelf).toHaveValue("2.25");
  await openConfirmation(page);
  await expect(page.getByRole("dialog")).toContainText(
    "Entered 1 of 3 products. The rest will remain unchanged.",
  );
  expect(backend.saves).toBe(0);
});

test("capture reproducible mobile comparison screenshots", async ({
  page,
}, testInfo) => {
  const phase = process.env.VARKA_CAPTURE_PHASE;
  test.skip(
    !["before", "after"].includes(phase) || testInfo.project.name !== "desktop",
    "Opt-in mobile comparison artifacts",
  );
  await page.clock.setFixedTime(new Date("2026-11-03T12:00:00.000Z"));
  await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await page.locator('[data-view="profile"]').click();
  await page
    .locator("#workspace")
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("ru");
  await page.locator('[data-view="stock"]').click();
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `artifacts/mobile-v44/${phase}-${width}.png`,
    });
    if (phase === "after") {
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "24px"),
      );
      await page.screenshot({
        path: `artifacts/mobile-v44/after-${width}-large-text.png`,
      });
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    }
  }
  if (phase === "after") {
    await page.setViewportSize({ width: 390, height: 844 });
    await enterMilk(page, "1,25", "2.25");
    await page.locator("#view-heading").focus();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "artifacts/mobile-v44/after-390-draft.png" });
    await card(page, "P001").locator('[data-zone="fridge"]').focus();
    await page.setViewportSize({ width: 390, height: 400 });
    await expect(page.locator("#count-bar")).not.toBeVisible();
    await page.screenshot({
      path: "artifacts/mobile-v44/after-390-keyboard.png",
    });
  }
});

async function historicalFilters(page, options = {}) {
  await page.locator("#stock-filter-button").click();
  const sheet = page.locator('#workspace-dialog[data-kind="filters"]');
  await expect(
    sheet.getByText(/Saved count dates are recorded per product/),
  ).toBeVisible();
  for (const key of ["lastCounted", "sort"])
    if (options[key] !== undefined)
      await sheet.locator(`[name="${key}"]`).selectOption(options[key]);
  for (const key of ["dateFrom", "dateTo"])
    if (options[key] !== undefined)
      await sheet.locator(`[name="${key}"]`).fill(options[key]);
  await sheet.locator('button[type="submit"]').click();
  await expect(sheet).not.toBeVisible();
}
const visibleStockIds = (page) =>
  page
    .locator(".stock-product-list .product-card:visible")
    .evaluateAll((cards) => cards.map((element) => element.dataset.productId));
function historicalFixture(backend) {
  backend.timeZone = "Europe/Minsk";
  backend.serverNow = "2026-11-03T00:15:00.000Z";
  backend.products[0].lastCountedAt = "2026-11-02T22:30:00.000Z"; // Nov 3 in café, Nov 2 in UTC.
  backend.products[1].lastCountedAt = "2026-11-02T20:59:00.000Z";
  backend.products[2].lastCountedAt = null;
  const original = backend.products[1];
  for (const [id, name, date] of [
    ["P004", "Delta", "2026-10-27T21:30:00.000Z"], // Oct 28 local: 6 days, not 7.
    ["P005", "Echo", "2026-10-26T21:30:00.000Z"], // Oct 27 local: 7 days.
    ["P006", "Foxtrot", "2026-10-03T22:00:00.000Z"], // Oct 4 local: 30 days.
    ["P007", "Golf", "2026-10-03T20:00:00.000Z"], // Oct 3 local: 31 days.
  ])
    backend.products.push({
      ...original,
      id,
      en: name,
      ru: name,
      stockVersion: `${id}-stock-1`,
      countVersion: `${id}-count-1`,
      catalogVersion: `${id}-catalog-1`,
      lastCountedAt: date,
    });
}

test("saved count date filters use café calendar days, missing dates, inclusive ranges and stable sorting", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-03T00:15:00.000Z"));
  const backend = await mockWorkspace(page);
  historicalFixture(backend);
  await page.goto(appPath);
  await login(page);
  await historicalFilters(page, { lastCounted: "TODAY" });
  expect(await visibleStockIds(page)).toEqual(["P001"]);
  await expect(page.locator("#selected-stock-filters")).toContainText("Today");
  await page
    .locator('#selected-stock-filters [data-filter="lastCounted"]')
    .click();
  await expect(page.locator(".product-card")).toHaveCount(7);
  await historicalFilters(page, { lastCounted: "YESTERDAY" });
  expect(await visibleStockIds(page)).toEqual(["P002"]);
  await historicalFilters(page, { lastCounted: "DAYS_7" });
  expect((await visibleStockIds(page)).sort()).toEqual([
    "P005",
    "P006",
    "P007",
  ]);
  await historicalFilters(page, { lastCounted: "DAYS_30" });
  expect((await visibleStockIds(page)).sort()).toEqual(["P006", "P007"]);
  await historicalFilters(page, { lastCounted: "NEVER" });
  expect(await visibleStockIds(page)).toEqual(["P003"]);
  await historicalFilters(page, {
    lastCounted: "RANGE",
    dateFrom: "2026-10-27",
    dateTo: "2026-10-28",
  });
  expect((await visibleStockIds(page)).sort()).toEqual(["P004", "P005"]);
  await page.locator("#stock-filter-button").click();
  const sheet = page.locator('#workspace-dialog[data-kind="filters"]');
  await sheet.locator('[name="dateFrom"]').fill("2026-11-03");
  await sheet.locator('[name="dateTo"]').fill("2026-11-02");
  await sheet.locator('button[type="submit"]').click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".dialog-error")).not.toHaveText("");
  await expect(sheet.locator('[name="dateFrom"]')).toHaveValue("2026-11-03");
  await page.keyboard.press("Escape");
  expect((await visibleStockIds(page)).sort()).toEqual(["P004", "P005"]);
  await historicalFilters(page, { lastCounted: "ALL", sort: "OLDEST" });
  expect(await visibleStockIds(page)).toEqual([
    "P003",
    "P007",
    "P006",
    "P005",
    "P004",
    "P002",
    "P001",
  ]);
  await historicalFilters(page, { sort: "NEWEST" });
  expect(await visibleStockIds(page)).toEqual([
    "P001",
    "P002",
    "P004",
    "P005",
    "P006",
    "P007",
    "P003",
  ]);
  await historicalFilters(page, { sort: "NAME" });
  expect(await visibleStockIds(page)).toEqual([
    "P002",
    "P003",
    "P004",
    "P005",
    "P006",
    "P007",
    "P001",
  ]);
  await historicalFilters(page, { lastCounted: "TODAY" });
  await applyStockFilters(page, { zone: "shelf", category: "Dairy" });
  await page.getByLabel("Search products", { exact: true }).fill("milk");
  expect(await visibleStockIds(page)).toEqual(["P001"]);
  await page.locator('[data-view="profile"]').click();
  await page.locator('[data-view="stock"]').click();
  await expect(page.getByLabel("Search products", { exact: true })).toHaveValue(
    "milk",
  );
  await expect(page.locator("#selected-stock-filters")).toContainText("Today");
  await historicalFilters(page, { lastCounted: "NEVER" });
  await expect(page.locator(".stock-empty")).toContainText(/filter/i);
  const emptyReset = page
    .locator(".stock-empty")
    .getByRole("button", { name: "Reset filters", exact: true });
  await emptyReset.click();
  await expect(page.locator(".product-card")).toHaveCount(7);
  await expect(page.locator("#selected-stock-filters")).toBeHidden();
  expect(backend.saves).toBe(0);
});

test("historical filters never change draft scope or dates; only accepted counts advance saved dates", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-03T00:15:00.000Z"));
  const backend = await mockWorkspace(page);
  historicalFixture(backend);
  backend.notificationFail = true;
  const initialDates = Object.fromEntries(
    backend.products.map((product) => [product.id, product.lastCountedAt]),
  );
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "1,25", "0");
  await card(page, "P005").locator('[data-zone="shelf"]').fill("0");
  await expect(page.locator("#count-progress")).toHaveText("2 of 7 ready");
  await historicalFilters(page, { lastCounted: "TODAY" });
  expect(await visibleStockIds(page)).toEqual(["P001"]);
  expect(
    Object.fromEntries(
      backend.products.map((product) => [product.id, product.lastCountedAt]),
    ),
  ).toEqual(initialDates);
  await page.locator("#refresh").click();
  await expect(page.locator("#refresh")).not.toBeDisabled();
  expect(await visibleStockIds(page)).toEqual(["P001"]);
  await expect(page.locator("#count-progress")).toHaveText("2 of 7 ready");
  await send(page);
  await expect.poll(() => backend.saves).toBe(2);
  const submitted = backend.requests.find(
    (request) => request.method === "workspaceCount",
  ).body;
  expect(submitted.items.map((item) => item.id).sort()).toEqual([
    "P001",
    "P005",
  ]);
  await expect(page.locator("#notification-panel")).toContainText(
    "Telegram failed",
  );
  expect(
    backend.products.find((product) => product.id === "P001").lastCountedAt,
  ).toBe(backend.serverNow);
  expect(
    backend.products.find((product) => product.id === "P005").lastCountedAt,
  ).toBe(backend.serverNow);
  for (const product of backend.products.filter(
    (product) => !["P001", "P005"].includes(product.id),
  ))
    expect(product.lastCountedAt).toBe(initialDates[product.id]);
  expect((await visibleStockIds(page)).sort()).toEqual(["P001", "P005"]);
  await expect(page.locator(".stock-product-list")).not.toContainText(
    "Inventory saved",
  );
  backend.notificationFail = false;
  await page
    .getByRole("button", { name: "Retry notification only", exact: true })
    .click();
  await expect.poll(() => backend.telegramSends).toBe(1);
  for (const product of backend.products.filter(
    (product) => !["P001", "P005"].includes(product.id),
  ))
    expect(product.lastCountedAt).toBe(initialDates[product.id]);
  expect(backend.saves).toBe(2);
});

test("mobile cards fit 360, 390 and 430 pixels in both languages with enlarged text and keyboard clearance", async ({
  page,
}) => {
  test.setTimeout(90000);
  const backend = await mockWorkspace(page);
  backend.products[0].en =
    "Long product name for refrigerated café milk and plant-based ingredients";
  backend.products[0].ru =
    "Очень длинное название молока и растительных ингредиентов для кофейни";
  backend.zones[0].en = "Refrigerator with a long storage location name";
  backend.zones[0].ru = "Холодильник с длинным названием места хранения";
  await page.setViewportSize({ width: 430, height: 844 });
  await page.goto(appPath);
  await login(page);
  await expect(page.locator(".stock-product-list")).not.toContainText(
    "Inventory saved",
  );
  await expect(page.locator("#stock-progress")).toHaveCount(0);
  await expect(page.locator("#count-progress")).not.toHaveAttribute(
    "aria-hidden",
    "true",
  );
  const assertLayout = async () => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const singleInput = await card(page, "P002")
      .locator("input[data-zone]")
      .boundingBox();
    const singleGrid = await card(page, "P002")
      .locator(".quantity-grid")
      .boundingBox();
    expect(Math.abs(singleInput.width - singleGrid.width)).toBeLessThanOrEqual(
      1,
    );
    for (const input of await page
      .locator(".stock-product-list input[data-zone]")
      .all()) {
      const bounds = await input.boundingBox();
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        page.viewportSize().width + 1,
      );
      expect(
        await input.evaluate((element) =>
          parseFloat(getComputedStyle(element).fontSize),
        ),
      ).toBeGreaterThanOrEqual(16);
      const caption = await input
        .locator("..")
        .locator(".quantity-caption")
        .boundingBox();
      expect(caption.y + caption.height).toBeLessThanOrEqual(bounds.y + 1);
    }
  };
  for (const language of ["en", "ru"]) {
    if (language === "ru") {
      await page.locator('[data-view="profile"]').click();
      await page
        .locator("#workspace")
        .getByRole("combobox", { name: "Language", exact: true })
        .selectOption("ru");
      await page.locator('[data-view="stock"]').click();
    }
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await assertLayout();
      if (width === 430) {
        const fields = await card(page, "P001")
          .locator("input[data-zone]")
          .all();
        const [first, second] = await Promise.all(
          fields.map((input) => input.boundingBox()),
        );
        expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
      }
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "24px";
      });
      await assertLayout();
      const fields = await card(page, "P001").locator("input[data-zone]").all();
      const [first, second] = await Promise.all(
        fields.map((input) => input.boundingBox()),
      );
      expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
      expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`mobile-${width}-${language}-large-text.png`),
      });
      if (width !== 430) {
        await page.locator("#stock-filter-button").click();
        const sheet = page.locator('#workspace-dialog[data-kind="filters"]');
        await sheet.locator('[name="lastCounted"]').selectOption("RANGE");
        await sheet.locator('[name="dateFrom"]').fill("2026-10-01");
        await sheet.locator('[name="dateTo"]').fill("2026-11-03");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        for (const field of await sheet.locator("input,select,button").all()) {
          if (!(await field.isVisible())) continue;
          const bounds = await field.boundingBox();
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
        }
        await sheet.locator('button[type="submit"]').scrollIntoViewIfNeeded();
        await page.screenshot({
          path: test
            .info()
            .outputPath(`mobile-${width}-${language}-large-date-sheet.png`),
        });
        await page.keyboard.press("Escape");
      }
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "";
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      const last = card(page, "P003");
      await expect
        .poll(async () => {
          await page.evaluate(() =>
            window.scrollTo(0, document.documentElement.scrollHeight),
          );
          const lastBounds = await last.boundingBox();
          const barBounds = await page.locator("#count-bar").boundingBox();
          return lastBounds.y + lastBounds.height <= barBounds.y + 2;
        })
        .toBe(true);
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const firstInput = card(page, "P001").locator('[data-zone="fridge"]');
  await firstInput.fill("1,25");
  await page.setViewportSize({ width: 390, height: 400 });
  await expect(firstInput).toBeFocused();
  await expect(page.locator("#count-bar")).not.toBeVisible();
  await expect(page.locator("#navigation")).not.toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await firstInput.boundingBox();
      return bounds.y >= 0 && bounds.y + bounds.height <= 400;
    })
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("mobile-keyboard-390-ru.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await firstInput.evaluate((element) => element.blur());
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    report.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  expect(backend.saves).toBe(0);
});

test("navigation and filter dialogs retain counting scroll and invalid local draft values", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  const sample = backend.products[1];
  backend.products.push(
    ...Array.from({ length: 25 }, (_, index) => ({
      ...sample,
      id: `SCROLL${index}`,
      en: `Scroll product ${String(index).padStart(2, "0")}`,
      ru: `Товар ${index}`,
    })),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appPath);
  await login(page);
  const draft = card(page, "SCROLL10").locator('[data-zone="shelf"]');
  await draft.fill("-2");
  await draft.evaluate((element) => element.blur());
  await page.evaluate(() => window.scrollTo(0, 1400));
  const position = await page.evaluate(() => window.scrollY);
  await page.locator('[data-view="catalog"]').click();
  await page.locator('[data-view="stock"]').click();
  await expect
    .poll(() => page.evaluate(() => Math.abs(window.scrollY - 1400)))
    .toBeLessThan(5);
  await expect(draft).toHaveValue("-2");
  await expect(draft).toHaveAttribute("aria-invalid", "true");
  await expect(draft.locator("..").locator(".field-error")).not.toHaveText("");
  await page
    .locator("#stock-filter-button")
    .evaluate((element) => element.click());
  const sheet = page.locator('#workspace-dialog[data-kind="filters"]');
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(() =>
      page.evaluate(
        (expected) => Math.abs(window.scrollY - expected),
        position,
      ),
    )
    .toBeLessThan(5);
  await page
    .locator("#stock-filter-button")
    .evaluate((element) => element.click());
  await sheet.locator('button[type="submit"]').click();
  await expect
    .poll(() =>
      page.evaluate(
        (expected) => Math.abs(window.scrollY - expected),
        position,
      ),
    )
    .toBeLessThan(5);
  await expect(draft).toHaveValue("-2");
  expect(backend.saves).toBe(0);
});

test("old successes do not survive reload or linger, but failed Telegram delivery remains actionable", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-03T12:00:00.000Z") });
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
  await enterMilk(page, "1", "0");
  await send(page);
  await expect(page.locator("#notification-panel")).toContainText(
    "Telegram notification sent.",
  );
  await page.reload();
  await login(page);
  await expect(page.locator("#notification-panel")).not.toBeVisible();
  await enterMilk(page, "2", "0");
  await send(page);
  await expect(page.locator("#notification-panel")).toContainText(
    "Telegram notification sent.",
  );
  await page.clock.fastForward(11000);
  await expect(page.locator("#notification-panel")).not.toBeVisible();
  await expect(page.locator("#message")).toHaveText("");
  backend.notificationFail = true;
  await enterMilk(page, "3", "0");
  await send(page);
  await expect(page.locator("#notification-panel")).toContainText(
    "Telegram failed",
  );
  await page.clock.fastForward(11000);
  await expect(
    page.getByRole("button", { name: "Retry notification only", exact: true }),
  ).toBeVisible();
  expect(backend.saves).toBe(3);
});
