import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  storageKey,
  decimalValue,
  quantityInput,
  createDraft,
  editDraft,
  draftState,
  conflicts,
  countingProgress,
  filterProducts,
  countDateKey,
  validateCountDateFilter,
  buildSubmission,
  applyAcknowledgment,
  mergeSnapshot,
} from "../google-pwa/workspace-model.js";

const product = (overrides = {}) => ({
  id: "P001",
  ru: "Молоко",
  en: "Milk",
  category: "Dairy",
  unit: "l",
  zones: ["fridge", "shelf"],
  active: true,
  stockVersion: "stock-1",
  catalogVersion: "catalog-1",
  countVersion: "count-1",
  last: "4",
  lastCountedAt: "2026-10-20T12:00:00Z",
  low: false,
  ...overrides,
});
const snapshot = (products = [product()]) => ({
  databaseId: "sheet-a",
  products,
});
const entered = (p = product(), version = "edit-1") =>
  editDraft(
    p,
    null,
    {
      locations: {
        fridge: { value: "1,25" },
        shelf: { value: "0" },
      },
      approx: true,
      low: true,
    },
    { editVersion: version, now: "2026-10-30T08:00:00Z" },
  );

test("saved count calendar dates use the café timezone and never invent missing history", () => {
  assert.equal(
    countDateKey("2026-11-02T21:00:00Z", "Europe/Minsk"),
    "2026-11-03",
  );
  assert.equal(
    countDateKey("2026-11-02T20:59:59.999Z", "Europe/Minsk"),
    "2026-11-02",
  );
  assert.equal(
    countDateKey("2026-01-01T00:30:00Z", "America/New_York"),
    "2025-12-31",
  );
  for (const value of [
    null,
    undefined,
    "",
    "invalid",
    "2026-02-30T12:00:00Z",
    "2026-11-03T00:30:00",
    "2026-11-03",
    "0",
    0,
    false,
    new Date(NaN),
  ])
    assert.equal(countDateKey(value, "Europe/Minsk"), null, String(value));
  assert.throws(
    () => countDateKey("2026-11-03T12:00:00Z", "Invalid/Zone"),
    /INVALID_TIME_ZONE/,
  );
});

test("saved date filtering is identical under different device timezones and rejects ambiguous history", () => {
  const moduleUrl = new URL("../google-pwa/workspace-model.js", import.meta.url)
    .href;
  const code = `
    import { countDateKey, filterProducts } from ${JSON.stringify(moduleUrl)};
    const products = [
      { id: 'today', lastCountedAt: '2026-11-02T22:30:00Z' },
      { id: 'offset', lastCountedAt: '2026-11-03T01:30:00+03:00' },
      { id: 'ambiguous', lastCountedAt: '2026-11-03T00:30:00' },
      { id: 'date-only', lastCountedAt: '2026-11-03' },
      { id: 'never', lastCountedAt: null }
    ];
    const options = { timeZone: 'Europe/Minsk', now: '2026-11-02T22:45:00Z' };
    console.log(JSON.stringify({
      keys: products.map(p => countDateKey(p.lastCountedAt, options.timeZone)),
      today: filterProducts(products, { lastCounted: 'TODAY' }, options).map(p => p.id),
      never: filterProducts(products, { lastCounted: 'NEVER' }, options).map(p => p.id)
    }));
  `;
  for (const deviceTimezone of ["UTC", "Pacific/Honolulu", "Asia/Tokyo"]) {
    const result = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
        encoding: "utf8",
        env: { ...process.env, TZ: deviceTimezone },
      }),
    );
    assert.deepEqual(
      result,
      {
        keys: ["2026-11-03", "2026-11-03", null, null, null],
        today: ["today", "offset"],
        never: ["ambiguous", "date-only", "never"],
      },
      deviceTimezone,
    );
  }
});

test("today and yesterday cross midnight in the café, not the device timezone", () => {
  const products = [
    product({ id: "today", lastCountedAt: "2026-11-02T21:00:00Z" }),
    product({ id: "yesterday", lastCountedAt: "2026-11-02T20:59:59.999Z" }),
    product({ id: "zero", last: 0, lastCountedAt: "2026-11-02T22:00:00Z" }),
    product({ id: "never", lastCountedAt: null }),
    product({ id: "invalid", lastCountedAt: "bad" }),
  ];
  const options = { timeZone: "Europe/Minsk", now: "2026-11-02T22:30:00Z" };
  assert.deepEqual(
    filterProducts(products, { lastCounted: "TODAY" }, options).map(
      (p) => p.id,
    ),
    ["today", "zero"],
  );
  assert.deepEqual(
    filterProducts(products, { lastCounted: "YESTERDAY" }, options).map(
      (p) => p.id,
    ),
    ["yesterday"],
  );
  assert.deepEqual(
    filterProducts(products, { lastCounted: "NEVER" }, options).map(
      (p) => p.id,
    ),
    ["never", "invalid"],
  );
  assert.deepEqual(
    filterProducts(products, { lastCounted: "ALL" }, options).map((p) => p.id),
    products.map((p) => p.id),
  );
});

test("7 and 30 day filters use calendar-day age, including DST and leap-year boundaries", () => {
  const products = [
    product({ id: "seven", lastCountedAt: "2026-03-03T04:59:59Z" }), // Mar 2 23:59 EST.
    product({ id: "six", lastCountedAt: "2026-03-03T05:00:00Z" }),
    product({ id: "thirty", lastCountedAt: "2026-02-07T17:00:00Z" }),
    product({ id: "future", lastCountedAt: "2026-03-10T04:30:00Z" }),
    product({ id: "never", lastCountedAt: null }),
  ];
  const options = { timeZone: "America/New_York", now: "2026-03-09T04:30:00Z" };
  // Spring forward makes seven calendar days less than 7*24 elapsed hours.
  assert.deepEqual(
    filterProducts(products, { lastCounted: "DAYS_7" }, options).map(
      (p) => p.id,
    ),
    ["seven", "thirty"],
  );
  assert.deepEqual(
    filterProducts(products, { lastCounted: "DAYS_30" }, options).map(
      (p) => p.id,
    ),
    ["thirty"],
  );
  const leap = [
    product({ id: "leap", lastCountedAt: "2024-02-29T20:00:00Z" }),
    product({ id: "march", lastCountedAt: "2024-03-01T20:00:00Z" }),
  ];
  assert.deepEqual(
    filterProducts(
      leap,
      { lastCounted: "DAYS_30" },
      { timeZone: "UTC", now: "2024-03-30T00:00:00Z" },
    ).map((p) => p.id),
    ["leap"],
  );
  const newYear = [product({ lastCountedAt: "2025-12-31T20:59:00Z" })];
  assert.equal(
    filterProducts(
      newYear,
      { lastCounted: "DAYS_7" },
      { timeZone: "Europe/Minsk", now: "2026-01-06T21:00:00Z" },
    ).length,
    1,
  );
});

test("custom count ranges are inclusive café calendar dates and validate actual dates", () => {
  const products = [
    product({ id: "before", lastCountedAt: "2026-11-01T20:59:59Z" }),
    product({ id: "start", lastCountedAt: "2026-11-01T21:00:00Z" }),
    product({ id: "end", lastCountedAt: "2026-11-03T20:59:59.999Z" }),
    product({ id: "after", lastCountedAt: "2026-11-03T21:00:00Z" }),
    product({ id: "never", lastCountedAt: null }),
  ];
  const filters = {
    lastCounted: "RANGE",
    dateFrom: "2026-11-02",
    dateTo: "2026-11-03",
  };
  assert.equal(validateCountDateFilter(filters), true);
  assert.deepEqual(
    filterProducts(products, filters, { timeZone: "Europe/Minsk" }).map(
      (p) => p.id,
    ),
    ["start", "end"],
  );
  assert.equal(
    validateCountDateFilter({
      ...filters,
      dateFrom: "2024-02-29",
      dateTo: "2024-02-29",
    }),
    true,
  );
  for (const invalid of [
    { dateFrom: "2026-11-04" },
    { dateFrom: "" },
    { dateTo: undefined },
    { dateFrom: "2026-02-29" },
    { dateFrom: "2026-04-31" },
    { dateFrom: "2026-2-03" },
    { dateFrom: "2026-13-01" },
    { dateFrom: "0000-01-01" },
  ]) {
    assert.throws(
      () => validateCountDateFilter({ ...filters, ...invalid }),
      /INVALID_DATE_RANGE/,
    );
    assert.throws(
      () => filterProducts(products, { ...filters, ...invalid }),
      /INVALID_DATE_RANGE/,
    );
  }
});

test("saved count dates combine with search, location and category using AND without changing drafts", () => {
  const products = [
    product({ id: "milk", lastCountedAt: "2026-11-02T22:00:00Z" }),
    product({
      id: "other-zone",
      zones: ["freezer"],
      lastCountedAt: "2026-11-02T22:00:00Z",
    }),
    product({
      id: "other-category",
      category: "Other",
      lastCountedAt: "2026-11-02T22:00:00Z",
    }),
    product({ id: "yesterday", lastCountedAt: "2026-11-01T22:00:00Z" }),
  ];
  const original = structuredClone(products);
  const drafts = { milk: entered(products[0]) };
  drafts.milk = editDraft(
    products[0],
    drafts.milk,
    { locations: { fridge: { value: "0" } } },
    { now: "2026-12-01T12:00:00Z" },
  );
  assert.deepEqual(
    filterProducts(
      products,
      {
        search: "milk",
        zone: "fridge",
        category: "Dairy",
        lastCounted: "TODAY",
      },
      { timeZone: "Europe/Minsk", now: "2026-11-02T22:30:00Z" },
    ).map((p) => p.id),
    ["milk"],
  );
  assert.deepEqual(products, original);
  assert.equal(drafts.milk.countedAt, "2026-12-01T12:00:00Z");
  assert.equal(products[0].lastCountedAt, "2026-11-02T22:00:00Z");
  assert.equal(buildSubmission(snapshot(products), drafts).items.length, 1);
});

test("history sorting puts never counted first for oldest, last for newest, and breaks ties by localized name and ID", () => {
  const products = [
    product({
      id: "old-b",
      en: "Zulu",
      ru: "Альфа",
      lastCountedAt: "2026-01-01T13:00:00Z",
    }),
    product({ id: "never-b", en: "Beta", lastCountedAt: null }),
    product({
      id: "old-a",
      en: "Alpha",
      ru: "Яблоко",
      lastCountedAt: "2026-01-01T13:00:00Z",
    }),
    product({ id: "new", en: "Newest", lastCountedAt: "2026-11-01T13:00:00Z" }),
    product({ id: "never-a", en: "Alpha", lastCountedAt: "invalid" }),
    product({
      id: "old-a2",
      en: "Alpha",
      ru: "Яблоко",
      lastCountedAt: "2026-01-01T13:00:00Z",
    }),
  ];
  const original = structuredClone(products);
  const options = { timeZone: "Europe/Minsk", language: "en" };
  assert.deepEqual(
    filterProducts(products, { sort: "OLDEST" }, options).map((p) => p.id),
    ["never-a", "never-b", "old-a", "old-a2", "old-b", "new"],
  );
  assert.deepEqual(
    filterProducts(products, { sort: "NEWEST" }, options).map((p) => p.id),
    ["new", "old-a", "old-a2", "old-b", "never-a", "never-b"],
  );
  assert.deepEqual(
    filterProducts(products, { sort: "NAME" }, options).map((p) => p.id),
    ["never-a", "old-a", "old-a2", "never-b", "new", "old-b"],
  );
  const dated = products.filter((p) => p.id.startsWith("old"));
  assert.deepEqual(
    filterProducts(
      dated,
      { sort: "OLDEST" },
      { ...options, language: "ru" },
    ).map((p) => p.id),
    ["old-b", "old-a", "old-a2"],
  );
  assert.deepEqual(
    filterProducts(products).map((p) => p.id),
    products.map((p) => p.id),
  );
  assert.deepEqual(products, original);
});

test("workspace storage is scoped to database, endpoint and authenticated account", () => {
  const key = storageKey("sheet-a", "Staff@Example.test", "https://endpoint-a");
  assert.equal(
    key,
    storageKey("sheet-a", "staff@example.test", "https://endpoint-a"),
  );
  assert.notEqual(
    key,
    storageKey("sheet-b", "staff@example.test", "https://endpoint-a"),
  );
  assert.notEqual(
    key,
    storageKey("sheet-a", "other@example.test", "https://endpoint-a"),
  );
  assert.notEqual(
    key,
    storageKey("sheet-a", "staff@example.test", "https://endpoint-b"),
  );
  assert.notEqual(storageKey("a:b", "c"), storageKey("a", "b:c"));
  assert.throws(() => storageKey("", "staff@example.test"), /NO_SNAPSHOT/);
});

test("workspace quantity preserves zero and exact decimals without floating point", () => {
  assert.equal(quantityInput("0", "pcs").scaled, 0n);
  assert.equal(quantityInput("1,25000001", "l").scaled, 125000001n);
  assert.equal(quantityInput(".5", "kg").value, "0.5");
  assert.equal(quantityInput("1.", "l").value, "1");
  assert.equal(quantityInput("0001.2500", "l").value, "1.25");
  assert.equal(decimalValue(1n), "0.00000001");
  assert.equal(decimalValue(-125000000n), "-1.25");
  for (const value of [
    "",
    "-1",
    "1e2",
    "NaN",
    "1.000000001",
    "1,2.3",
    "1 2",
    "Infinity",
  ])
    assert.throws(() => quantityInput(value, "l"), /INVALID_QUANTITY/);
  assert.throws(() => quantityInput("1000000001", "l"), /QUANTITY_RANGE/);
  assert.throws(() => quantityInput("0,5", "pcs"), /WHOLE_PIECES_REQUIRED/);
});

test("new Telegram submission snapshots are Russian even when the interface is English", () => {
  const p = product(),
    drafts = { [p.id]: entered(p) };
  for (const language of ["en", "ru", undefined]) {
    const options = { language, scope: "ALL" };
    const request = buildSubmission(snapshot([p]), drafts, options);
    assert.equal(request.notification.language, "ru");
    assert.equal(options.language, language);
    assert.equal(request.items[0].locations[0].value, "1.25");
    assert.equal(drafts[p.id].locations.fridge.value, "1,25");
  }
});

test("blank quantities with Approximate and Low flags are not completed counts", () => {
  const p = product();
  const draft = editDraft(p, null, { approx: true, low: true });
  const state = draftState(p, draft);
  assert.equal(state.entered, false);
  assert.equal(state.complete, false);
  const request = buildSubmission(
    snapshot(),
    { P001: draft },
    { id: "blank-flags" },
  );
  assert.deepEqual(request.items, []);
  assert.equal(request.summary.entered, 0);
  assert.equal(request.summary.uncounted, 1);
  assert.deepEqual(request.notification.lowIds, ["P001"]);
});

test("per-location draft requires all assigned zones, preserving explicit zero", () => {
  const p = product();
  let draft = editDraft(p, null, { locations: { fridge: { value: "0" } } });
  assert.equal(draftState(p, draft).error, "INCOMPLETE_LOCATIONS");
  assert.throws(
    () => buildSubmission(snapshot(), { P001: draft }),
    /INCOMPLETE_LOCATIONS/,
  );
  draft = editDraft(p, draft, { locations: { shelf: { value: "0" } } });
  const state = draftState(p, draft);
  assert.equal(state.complete, true);
  assert.equal(state.total, 0n);
  assert.deepEqual(
    state.locations.map((x) => x.value),
    ["0", "0"],
  );
});

test("counting progress needs complete valid current drafts, not recorded quantities or flags", () => {
  const products = [
    product({ id: "blank" }),
    product({ id: "flags" }),
    product({ id: "partial" }),
    product({ id: "invalid" }),
    product({ id: "zero" }),
    product({ id: "decimal", active: false }),
    product({ id: "pieces", unit: "pcs" }),
  ];
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const drafts = {
    flags: editDraft(byId.flags, null, { low: true, approx: true }),
    partial: editDraft(byId.partial, null, {
      locations: { fridge: { value: "0" } },
    }),
    invalid: editDraft(byId.invalid, entered(byId.invalid), {
      locations: { shelf: { value: "-1" } },
    }),
    zero: editDraft(byId.zero, null, {
      locations: { fridge: { value: "0" }, shelf: { value: "0" } },
    }),
    decimal: entered(byId.decimal),
    pieces: entered(byId.pieces),
  };
  const before = structuredClone(drafts);
  assert.deepEqual(countingProgress(snapshot(products), drafts), {
    total: 7,
    entered: 2,
    uncounted: 5,
    uncheckedIds: ["blank", "flags", "partial", "invalid", "pieces"],
  });
  assert.deepEqual(drafts, before);
  assert.deepEqual(countingProgress(snapshot(products)), {
    total: 7,
    entered: 0,
    uncounted: 7,
    uncheckedIds: products.map((p) => p.id),
  });
  assert.deepEqual(countingProgress(null), {
    total: 0,
    entered: 0,
    uncounted: 0,
    uncheckedIds: [],
  });
});

test("counting progress exposes stale drafts and excludes tombstones without losing their data", () => {
  const old = product({ id: "stale" });
  const deleted = product({ id: "deleted", deleted: true });
  const unassigned = product({ id: "unassigned", zones: [] });
  const current = product({ id: "current" });
  const drafts = {
    stale: entered(old),
    deleted: entered(deleted),
    orphan: entered(product({ id: "orphan" })),
    unassigned: editDraft(unassigned, null, {
      locations: { unassigned: { value: "0,5" } },
    }),
    current: entered(current),
  };
  const before = structuredClone(drafts);
  for (const change of [
    { stockVersion: "new-stock" },
    { active: false },
    { zones: ["fridge"] },
    { unit: "pcs" },
  ]) {
    const data = snapshot([
      { ...old, ...change },
      deleted,
      unassigned,
      current,
    ]);
    assert.deepEqual(countingProgress(data, drafts), {
      total: 3,
      entered: 2,
      uncounted: 1,
      uncheckedIds: ["stale"],
    });
  }
  assert.deepEqual(drafts, before);
});

test("progress and unchecked visibility do not narrow the full-catalog submission", () => {
  const p1 = product({ id: "first" });
  const p2 = product({ id: "second", category: "Other" });
  const p3 = product({ id: "blank" });
  const data = snapshot([p1, p2, p3]);
  const drafts = { first: entered(p1), second: entered(p2) };
  const progress = countingProgress(data, drafts);
  const visible = filterProducts(data.products, { category: "Dairy" }).filter(
    (p) => progress.uncheckedIds.includes(p.id),
  );
  assert.deepEqual(
    visible.map((p) => p.id),
    ["blank"],
  );
  const request = buildSubmission(data, drafts);
  assert.deepEqual(
    request.items.map((item) => item.id),
    ["first", "second"],
  );
  assert.equal(request.summary.entered, progress.entered);
  assert.equal(request.summary.uncounted, progress.uncounted);
});

test("unassigned products support one explicit total input", () => {
  const p = product({ zones: [] });
  const draft = editDraft(p, null, {
    locations: { unassigned: { value: "2,5" } },
  });
  const state = draftState(p, draft);
  assert.equal(state.totalValue, "2.5");
  assert.deepEqual(state.locations, [
    { zoneId: "unassigned", value: "2.5", unit: "BASE" },
  ]);
});

test("individual valid locations cannot overflow their combined total", () => {
  const draft = entered();
  draft.locations.fridge.value = "1000000000";
  draft.locations.shelf.value = "0.1";
  assert.equal(draftState(product(), draft).error, "QUANTITY_RANGE");
});

test("edits preserve original versions and removed locations until explicit resolution", () => {
  const old = entered();
  const current = product({
    zones: ["freezer"],
    stockVersion: "stock-2",
    countVersion: "count-2",
    active: false,
  });
  const edited = editDraft(
    current,
    old,
    { low: false },
    { editVersion: "edit-2" },
  );
  assert.equal(edited.stockVersion, "stock-1");
  assert.equal(edited.countVersion, "count-1");
  assert.equal(edited.active, true);
  assert.deepEqual(edited.zones, ["fridge", "shelf"]);
  assert.equal(edited.locations.fridge.value, "1,25");
  assert.equal(old.low, true);
  assert.equal(edited.low, false);
  assert.equal(draftState(current, edited).complete, true);
  assert.equal(
    conflicts(snapshot([current]), { P001: edited })[0].reason,
    "COUNT_SPEC_CONFLICT",
  );
});

test("name/category metadata edits do not invalidate a stock draft", () => {
  const current = product({
    en: "New milk",
    category: "Refrigerated",
    catalogVersion: "catalog-2",
  });
  assert.deepEqual(conflicts(snapshot([current]), { P001: entered() }), []);
  assert.equal(
    buildSubmission(snapshot([current]), { P001: entered() }).items.length,
    1,
  );
});

test("remote counts, deactivation, deletion and unit/location changes are explicit conflicts", () => {
  const draft = entered();
  for (const change of [
    { active: false },
    { unit: "pcs" },
    { zones: ["fridge"] },
    { countVersion: "count-2" },
  ]) {
    const current = snapshot([product(change)]);
    assert.equal(
      conflicts(current, { P001: draft })[0].reason,
      "COUNT_SPEC_CONFLICT",
    );
    assert.throws(
      () => buildSubmission(current, { P001: draft }),
      /COUNT_SPEC_CONFLICT/,
    );
  }
  assert.equal(
    conflicts(snapshot([product({ stockVersion: "stock-2" })]), {
      P001: draft,
    })[0].reason,
    "STOCK_CONFLICT",
  );
  assert.equal(
    conflicts(snapshot([]), { P001: draft })[0].reason,
    "PRODUCT_DELETED",
  );
  assert.throws(
    () => buildSubmission(snapshot([]), { P001: draft }),
    /PRODUCT_DELETED/,
  );
  assert.equal(draft.locations.fridge.value, "1,25");
});

test("search and category/location filters compose over the entire catalog including inactive", () => {
  const products = Array.from({ length: 350 }, (_, index) =>
    product({
      id: `P${index}`,
      en: `Coffee ${index}`,
      category: index % 2 ? "Coffee" : "Dairy",
      zones: index % 3 ? ["shelf"] : ["fridge"],
      active: index !== 349,
    }),
  );
  assert.equal(filterProducts(products).length, 350);
  assert.equal(
    filterProducts(products, {
      search: "Coffee 349",
      category: "Coffee",
      zone: "shelf",
    })[0].id,
    "P349",
  );
  assert.equal(
    filterProducts(products, { search: "Coffee 349", category: "Dairy" })
      .length,
    0,
  );
  assert.equal(filterProducts(products, {}).length, 350);
  assert.equal(
    filterProducts([product({ zones: [] })], { zone: "unassigned" }).length,
    1,
  );
});

test("submission and notification scopes never depend on the visible filtered subset", () => {
  const p2 = product({ id: "P002", active: false, low: true });
  const all = snapshot([product(), p2, product({ id: "P003", last: null })]);
  const drafts = { P001: entered(), P002: entered(p2, "edit-2") };
  const visible = filterProducts(all.products, { search: "No match" });
  assert.equal(visible.length, 0);
  for (const scope of ["ALL", "ENTERED", "LOW"]) {
    const request = buildSubmission(all, drafts, {
      scope,
      language: "ru",
      id: `operation-${scope}`,
    });
    assert.equal(request.items.length, 2);
    assert.deepEqual(request.notification.lowIds, ["P001", "P002"]);
    assert.equal(request.notification.language, "ru");
    assert.deepEqual(request.summary, {
      entered: 2,
      uncounted: 1,
      low: 2,
      inactive: 1,
      inactiveEntered: 1,
    });
  }
});

test("stable submission snapshot is independent from later edits and refreshes", () => {
  const all = snapshot();
  const drafts = { P001: entered() };
  const request = buildSubmission(all, drafts, { id: "immutable-request" });
  drafts.P001.locations.fridge.value = "99";
  drafts.P001.low = false;
  all.products[0].last = "100";
  assert.equal(request.items[0].locations[0].value, "1.25");
  assert.equal(request.items[0].low, true);
  assert.deepEqual(request.notification.lowIds, ["P001"]);
  assert.equal(request.notification.products[0].last, "4");
  assert.equal(request.notification.products[0].low, true);
  assert.equal(request.notification.products[0].approx, true);
  all.products[0].en = "Renamed later";
  all.products[0].active = false;
  all.products.push(product({ id: "P002" }));
  assert.equal(request.notification.products[0].en, "Milk");
  assert.equal(request.notification.products[0].active, true);
  assert.equal(request.notification.products.length, 1);
});

test("report snapshot freezes uncounted quantities and flags without adding stock writes", () => {
  const all = snapshot([
    product({ id: "P001", last: "9", low: false }),
    product({ id: "P002", active: false, last: null, lastCountedAt: null }),
  ]);
  const flags = editDraft(all.products[0], null, { low: true, approx: true });
  const request = buildSubmission(all, { P001: flags }, { scope: "ALL" });
  assert.equal(request.items.length, 0);
  assert.equal(request.notification.products.length, 2);
  assert.equal(request.notification.products[0].last, "9");
  assert.equal(
    request.notification.products[0].lastCountedAt,
    "2026-10-20T12:00:00Z",
  );
  assert.equal(request.notification.products[0].low, true);
  assert.equal(request.notification.products[1].active, false);
  assert.equal(request.notification.products[1].last, null);
  assert.deepEqual(request.notification.lowIds, ["P001"]);
  assert.equal(request.summary.entered, 0);
  assert.equal(request.summary.uncounted, 2);
});

test("successful acknowledgment clears only accepted matching draft versions", () => {
  const p2 = product({ id: "P002" });
  const record = {
    snapshot: snapshot([product(), p2]),
    drafts: { P001: entered(), P002: entered(p2, "edit-2") },
  };
  record.pending = buildSubmission(record.snapshot, record.drafts, {
    id: "pending-1",
  });
  const result = {
    status: "COMMITTED",
    accepted: [
      {
        id: "P001",
        editVersion: "edit-1",
        last: "1.25",
        stockVersion: "stock-2",
        lastCountedAt: "2026-10-30T09:00:00Z",
        low: true,
        approx: true,
      },
    ],
    failed: [{ id: "P002", error: "INVALID_QUANTITY" }],
    notification: { status: "READY" },
  };
  const next = applyAcknowledgment(record, result);
  assert.equal(next.pending, null);
  assert.equal(next.drafts.P001, undefined);
  assert.equal(next.drafts.P002.editVersion, "edit-2");
  assert.equal(next.snapshot.products[0].last, "1.25");
  assert.equal(next.snapshot.products[0].stockVersion, "stock-2");
  assert.equal(next.notification.status, "READY");
  assert.ok(record.drafts.P001);
});

test("newer edits made during submission survive acknowledgment with own baseline advanced", () => {
  const record = { snapshot: snapshot(), drafts: { P001: entered() } };
  record.pending = buildSubmission(record.snapshot, record.drafts, {
    id: "pending-1",
  });
  record.drafts.P001 = editDraft(
    product(),
    record.drafts.P001,
    { locations: { fridge: { value: "9" } } },
    { editVersion: "edit-newer" },
  );
  const next = applyAcknowledgment(record, {
    status: "COMMITTED",
    accepted: [
      {
        id: "P001",
        editVersion: "edit-1",
        last: "1.25",
        stockVersion: "stock-2",
      },
    ],
  });
  assert.equal(next.drafts.P001.editVersion, "edit-newer");
  assert.equal(next.drafts.P001.locations.fridge.value, "9");
  assert.equal(next.drafts.P001.stockVersion, "stock-2");
  assert.deepEqual(conflicts(next.snapshot, next.drafts), []);
});

test("acknowledgment never restores stale catalog metadata or rebases an unrelated remote version", () => {
  const record = { snapshot: snapshot(), drafts: { P001: entered() } };
  record.pending = buildSubmission(record.snapshot, record.drafts, {
    id: "pending-1",
  });
  record.snapshot.products[0].en = "New name";
  record.snapshot.products[0].active = false;
  record.drafts.P001.editVersion = "edit-newer";
  record.drafts.P001.stockVersion = "remote-version";
  const next = applyAcknowledgment(record, {
    accepted: [
      {
        id: "P001",
        editVersion: "edit-1",
        last: "1.25",
        stockVersion: "stock-2",
        en: "Old name",
        active: true,
      },
    ],
  });
  assert.equal(next.snapshot.products[0].en, "New name");
  assert.equal(next.snapshot.products[0].active, false);
  assert.equal(next.drafts.P001.stockVersion, "remote-version");
});

test("unknown submission outcome preserves immutable request and all drafts", () => {
  const record = { snapshot: snapshot(), drafts: { P001: entered() } };
  record.pending = buildSubmission(record.snapshot, record.drafts);
  assert.deepEqual(
    applyAcknowledgment(record, { status: "UNKNOWN", accepted: [] }),
    record,
  );
  assert.deepEqual(
    applyAcknowledgment(record, {
      state: "PREPARED",
      accepted: [
        { id: "P001", editVersion: "edit-1", stockVersion: "not-written" },
      ],
    }),
    record,
  );
  assert.deepEqual(
    applyAcknowledgment(record, {
      status: "PREPARED",
      accepted: [
        { id: "P001", editVersion: "edit-1", stockVersion: "not-written" },
      ],
    }),
    record,
  );
});

test("delayed acknowledgment cannot roll back a newer refresh from another user", () => {
  const record = { snapshot: snapshot(), drafts: { P001: entered() } };
  record.pending = buildSubmission(record.snapshot, record.drafts);
  record.snapshot.products[0].stockVersion = "remote-after-commit";
  record.snapshot.products[0].last = "20";
  const next = applyAcknowledgment(record, {
    accepted: [
      {
        id: "P001",
        editVersion: "edit-1",
        stockVersion: "own-commit",
        last: "1.25",
      },
    ],
  });
  assert.equal(next.snapshot.products[0].last, "20");
  assert.equal(next.snapshot.products[0].stockVersion, "remote-after-commit");
  assert.equal(next.drafts.P001, undefined);
});

test("refresh, offline serialization and navigation do not rewrite any local work", () => {
  const record = {
    snapshot: snapshot(),
    drafts: { P001: entered() },
    view: "stock",
    notification: { status: "UNKNOWN" },
  };
  record.pending = buildSubmission(record.snapshot, record.drafts);
  const serialized = JSON.parse(JSON.stringify(record));
  serialized.view = "catalog";
  const refreshed = mergeSnapshot(
    serialized,
    snapshot([product({ stockVersion: "remote-new" })]),
  );
  assert.deepEqual(refreshed.drafts, record.drafts);
  assert.deepEqual(refreshed.pending, record.pending);
  assert.deepEqual(refreshed.notification, record.notification);
  assert.equal(
    conflicts(refreshed.snapshot, refreshed.drafts)[0].reason,
    "STOCK_CONFLICT",
  );
  assert.equal(record.snapshot.products[0].stockVersion, "stock-1");
});
