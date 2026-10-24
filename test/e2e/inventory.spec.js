import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page
    .getByLabel("Access code", { exact: true })
    .fill("browser-test-password");
  await page
    .getByRole("button", { name: "Open inventory", exact: true })
    .click();
  await expect(page.getByText("Café connected", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
  });
});
async function addProduct(page, name, { sleeve = false, zones = false } = {}) {
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name (RU)", { exact: true }).fill(name);
  await dialog.getByLabel("Name (EN)", { exact: true }).fill(name);
  await dialog
    .getByLabel("Unit", { exact: true })
    .selectOption(sleeve ? "pcs" : "kg");
  await dialog.getByLabel("No minimum threshold").uncheck();
  await dialog.getByLabel("Minimum", { exact: true }).fill("1");
  if (sleeve) {
    await dialog.getByLabel("Cups/lids: sleeves of 25").check();
    await dialog.getByLabel("Packaging / notes").fill("250 ml cups");
  }
  if (zones) {
    await dialog.getByLabel("Refrigerator", { exact: true }).check();
    await dialog.getByLabel("Shelf", { exact: true }).check();
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("searchbox").fill(name);
  await expect(
    page.locator(".catalog-row").filter({ hasText: name }),
  ).toBeVisible();
}
async function beginCount(page, name) {
  await page.getByRole("button", { name: "Count", exact: true }).click();
  await page
    .getByRole("button", { name: "Start inventory", exact: true })
    .click();
  const row = page.locator(".count-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  return row;
}
async function submitCount(page) {
  await page.getByLabel("Keep blank items unchanged", { exact: false }).check();
  await page
    .getByRole("button", { name: "Submit inventory", exact: true })
    .click();
  await expect(page.locator("#count-workspace")).toBeHidden();
}

test("count, record waste, and inspect original audit history at each screen size", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const name = `Beans ${info.project.name}`;
  await addProduct(page, name);
  const row = await beginCount(page, name);
  await row.getByLabel("Quantity (kg)", { exact: true }).fill("2.5");
  await submitCount(page);
  await page.getByRole("button", { name: "Stock", exact: true }).click();
  const stock = page.locator(".stock-row").filter({ hasText: name });
  await expect(stock.locator(".quantity-value")).toHaveText("2.5 kg");
  await stock.getByRole("button", { name: "Waste", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Quantity", { exact: true }).fill("1.75");
  await dialog.getByLabel("Reason", { exact: true }).fill("Breakfast service");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(stock.locator(".quantity-value")).toHaveText("0.75 kg");
  await expect(stock).toContainText("Running low");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page
      .locator(".history-row")
      .filter({ hasText: name })
      .filter({ hasText: "Breakfast service" }),
  ).toContainText("−1.75 kg");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("inventory-history.png"),
    fullPage: true,
  });
});

test("zone counts and configured sleeves produce a single café balance", async ({
  page,
}, info) => {
  const name = `Cups ${info.project.name}`;
  await addProduct(page, name, { sleeve: true, zones: true });
  const row = await beginCount(page, name);
  await row.getByLabel("Refrigerator", { exact: true }).fill("2");
  await row
    .getByRole("combobox", { name: "Refrigerator · Unit" })
    .selectOption("SLEEVE_25");
  await row.getByLabel("Shelf", { exact: true }).fill("3");
  await expect(row.locator(".count-total")).toHaveText("53 pcs");
  await submitCount(page);
  await page.getByRole("button", { name: "Stock", exact: true }).click();
  await expect(
    page
      .locator(".stock-row")
      .filter({ hasText: name })
      .locator(".quantity-value"),
  ).toHaveText("53 pcs");
});

test("offline snapshots remain readable and drafts survive offline reloads without stock writes", async ({
  page,
  context,
}, info) => {
  const name = `Offline ${info.project.name}`;
  await addProduct(page, name);
  const row = await beginCount(page, name);
  await row.getByLabel("Quantity (kg)", { exact: true }).fill("3.125");
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText("Offline · drafts only", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Count", exact: true }).click();
  const restored = page.locator(".count-row").filter({ hasText: name });
  await expect(
    restored.getByLabel("Quantity (kg)", { exact: true }),
  ).toHaveValue("3.125");
  await restored.getByLabel("Quantity (kg)", { exact: true }).fill("3.5");
  await expect(
    page.getByRole("button", { name: "Submit inventory", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Count", exact: true }).click();
  await expect(
    page
      .locator(".count-row")
      .filter({ hasText: name })
      .getByLabel("Quantity (kg)", { exact: true }),
  ).toHaveValue("3.5");
  await context.setOffline(false);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Café connected", { exact: true })).toBeVisible();
  await submitCount(page);
});

test("text is safely rendered and locking revokes access and clears snapshots", async ({
  page,
}, info) => {
  const name = `<img src=x onerror=alert(1)> ${info.project.name}`;
  await addProduct(page, name);
  await expect(page.locator(".catalog-row img")).toHaveCount(0);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await expect(page.getByLabel("Access code", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(async () =>
      (await caches.keys()).includes("varka-data-v2"),
    ),
  ).toBe(false);
  expect((await page.request.get("/api/varka/bootstrap")).status()).toBe(401);
});

test("reminders and both UI languages work", async ({ page }, info) => {
  const content = `Order beans ${info.project.name}`;
  await page.getByRole("button", { name: "Information", exact: true }).click();
  await page
    .locator("#view-information article")
    .first()
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Note", { exact: true })
    .fill(content);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(
    page.locator(".information-row").filter({ hasText: content }),
  ).toBeVisible();
  await page.getByRole("button", { name: "RU", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Остатки", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Напоминания", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stock", exact: true }),
  ).toBeVisible();
});

test("PWA assets and mobile layouts are available", async ({ page }) => {
  const response = await page.request.get("/manifest.webmanifest");
  const manifest = await response.json();
  expect(manifest.short_name).toBe("VARKA");
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons)
    expect((await page.request.get(icon.src)).ok()).toBe(true);
  expect((await page.request.get("/icons/apple-touch-icon.png")).ok()).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("an uncertain submission recovers after reload without duplicating stock events", async ({
  page,
}, info) => {
  const name = `Retry ${info.project.name}`;
  await addProduct(page, name);
  const row = await beginCount(page, name);
  await row.getByLabel("Quantity (kg)", { exact: true }).fill("7.25");
  await page.getByLabel("Keep blank items unchanged", { exact: false }).check();
  await page.route(
    "**/api/varka/sessions/*/submit",
    async (route) => {
      await route.fetch(); // Commit successfully, but hide the response from the page.
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "Submit inventory", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry safely", exact: true }),
  ).toBeVisible();
  await expect(row.getByLabel("Quantity (kg)", { exact: true })).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retry safely", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry safely", exact: true }).click();
  await expect(page.locator("#pending")).toBeHidden();
  const result = await (await page.request.get("/api/varka/history")).json();
  const records = result.entries.filter(
    (entry) => entry.ru === name && entry.action === "CHECK",
  );
  expect(records).toHaveLength(1);
  expect(records[0].quantity).toBe("7.25");
});

test("owner provisions individual staff access without storing the code in browser storage", async ({
  page,
}, info) => {
  const email = `staff-${info.project.name}@example.test`;
  const code = "staff-browser-code-12345";
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("button", { name: "Staff access", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  await dialog.getByLabel("Display name", { exact: true }).fill("Barista");
  await dialog
    .getByLabel("New access code (12+ characters)", { exact: true })
    .fill(code);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(
    await page.evaluate(
      (secret) =>
        Object.values(localStorage).some((value) => value.includes(secret)),
      code,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  await page
    .locator("#login-panel")
    .getByLabel("Email", { exact: true })
    .fill(email);
  await page.getByLabel("Access code", { exact: true }).fill(code);
  await page
    .getByRole("button", { name: "Open inventory", exact: true })
    .click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.locator("#owner-settings")).toBeHidden();
  expect((await page.request.get("/api/varka/admin/users")).status()).toBe(403);
});
