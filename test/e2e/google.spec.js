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

async function mockGoogle(page, { writes = true } = {}) {
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
  };
  const backend = {
    product,
    session: null,
    committed: new Map(),
    submissions: 0,
    calls: [],
    dropSubmit: false,
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
      stock: { products: [{ ...product }] },
      catalog: [{ ...product }],
      profile: { email, name: "Test staff" },
      session: backend.session,
      zones: [
        { id: "fridge", ru: "Холодильник", en: "Refrigerator" },
        { id: "shelf", ru: "Полка", en: "Shelf" },
      ],
    });
    if (request.method === "ping")
      result = { protocol: 1, writesEnabled: writes };
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
  await page.locator('input[data-zone="fridge"]').fill("2.5");
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
