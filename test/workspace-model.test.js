import test from "node:test";
import assert from "node:assert/strict";
import {
  storageKey,
  decimalValue,
  quantityInput,
  createDraft,
  editDraft,
  draftState,
  conflicts,
  filterProducts,
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
