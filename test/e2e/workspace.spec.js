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
      products: backend.products,
      zones: [
        { id: "fridge", ru: "Холодильник", en: "Refrigerator" },
        { id: "shelf", ru: "Полка", en: "Shelf" },
      ],
      categories: ["Dairy", "Coffee", "Packaging"],
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
          current.lastCountedAt = new Date().toISOString();
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
  await card(page, "P001").getByLabel("Approximate", { exact: true }).check();
  await page.getByLabel("Search products", { exact: true }).fill("coffee");
  await expect(card(page, "P001")).toHaveCount(0);
  await expect(card(page, "P002")).toBeVisible();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
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
  await card(page, "P001").getByLabel("Approximate", { exact: true }).check();
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
  expect(submitted.notification.lowIds).toContain("P002");
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
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
  ).toBeVisible();
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
  await page
    .getByRole("combobox", { name: "Location", exact: true })
    .selectOption("fridge");
  await expect(card(page, "P137")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption("Dairy");
  await expect(page.locator(".product-card")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(page.locator(".product-card")).toHaveCount(137);
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
  await card(page, "P002").getByLabel("Low", { exact: true }).check();
  await page.getByLabel("Search products", { exact: true }).fill("coffee");
  await page
    .getByRole("button", { name: "Clear entered information", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
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
  await expect(page.locator("#message")).toHaveText("Yellow Card saved.");
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

test("status actions support Undo and directional swipes without treating quantity drags or scrolling as status changes", async ({
  page,
}) => {
  const backend = await mockWorkspace(page);
  await page.goto(appPath);
  await login(page);
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
  await drag(card(page, "P001").locator('[data-zone="fridge"]'), -110, 0, 3);
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

test("compact stock filters remain reachable while scrolling and the sync control keeps a touch-sized compact target", async ({
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
  for (const width of new Set([320, originalWidth])) {
    await page.setViewportSize({ width, height: 740 });
    await page.evaluate(() => window.scrollTo(0, 2200));
    const toolbar = page.locator(".stock-filters");
    await expect(toolbar).toBeVisible();
    if (width === 320) {
      const toolbarSize = await toolbar.boundingBox();
      const searchSize = await page
        .getByLabel("Search products", { exact: true })
        .boundingBox();
      const locationSize = await page
        .getByRole("combobox", { name: "Location", exact: true })
        .boundingBox();
      expect(toolbarSize.height).toBeLessThan(180);
      expect(searchSize.y).toBeLessThan(locationSize.y);
    }
    await expect
      .poll(async () => {
        const header = await page.locator("header").boundingBox();
        const filter = await toolbar.boundingBox();
        return Boolean(
          filter &&
          filter.y >= header.y + header.height - 2 &&
          filter.y + filter.height < 740,
        );
      })
      .toBe(true);
    for (const field of [
      page.getByLabel("Search products", { exact: true }),
      page.getByRole("combobox", { name: "Location", exact: true }),
      page.getByRole("combobox", { name: "Category", exact: true }),
    ]) {
      const bounds = await field.boundingBox();
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThan(740);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
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
  }
  await page.getByLabel("Search products", { exact: true }).fill("milk");
  await page
    .getByRole("combobox", { name: "Location", exact: true })
    .selectOption("fridge");
  await page
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption("Dairy");
  await expect(card(page, "P001").locator('[data-zone="fridge"]')).toHaveValue(
    "6,25",
  );
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(card(page, "P001")).toBeVisible();
  const cardSize = await card(page, "P001").boundingBox();
  expect(cardSize.height).toBeLessThan(350);
  expect(cardSize.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: test.info().outputPath("stock-compact-320.png"),
  });
  await page.evaluate(() => (document.documentElement.style.zoom = "2"));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
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
