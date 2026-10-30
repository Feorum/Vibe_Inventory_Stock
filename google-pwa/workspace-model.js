// Pure workspace state. Credentials and login tokens never belong in this data.
const SCALE = 100000000n;
const LIMIT = 1000000000n * SCALE;
const clone = (value) => structuredClone(value);
const zonesFor = (product) =>
  product.zones?.length ? [...product.zones] : ["unassigned"];
const sameZones = (a = [], b = []) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function failure(code, productId) {
  const error = new Error(code);
  error.code = code;
  if (productId) error.productId = productId;
  return error;
}

// The endpoint scopes authorization, the server-returned ID scopes the workbook.
// Length-delimited JSON encoding avoids collisions even in unusual email/URL text.
export function storageKey(databaseId, email, endpoint = "") {
  if (!databaseId || !email) throw failure("NO_SNAPSHOT");
  return `varka-workspace:${JSON.stringify([
    String(endpoint),
    String(databaseId),
    String(email).trim().toLowerCase(),
  ])}`;
}
export const workspaceKey = storageKey;

export function decimalValue(scaled) {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / SCALE;
  const fraction = String(absolute % SCALE)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function quantityInput(value, unit) {
  let raw = String(value ?? "")
    .trim()
    .replace(",", ".");
  if (raw.startsWith(".")) raw = `0${raw}`;
  if (raw.endsWith(".")) raw = raw.slice(0, -1);
  if (!/^\d+(?:\.\d{1,8})?$/.test(raw)) throw failure("INVALID_QUANTITY");
  const [whole, fraction = ""] = raw.split(".");
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
  if (scaled > LIMIT) throw failure("QUANTITY_RANGE");
  if (unit === "pcs" && scaled % SCALE !== 0n)
    throw failure("WHOLE_PIECES_REQUIRED");
  return { value: decimalValue(scaled), scaled };
}

export function createDraft(product) {
  return {
    editVersion: crypto.randomUUID(),
    stockVersion: product.stockVersion,
    countVersion: product.countVersion,
    catalogVersion: product.catalogVersion,
    unit: product.unit,
    zones: [...(product.zones || [])],
    active: Boolean(product.active),
    locations: Object.fromEntries(
      zonesFor(product).map((zone) => [zone, { value: "", unit: "BASE" }]),
    ),
    approx: false,
    low: Boolean(product.low),
    countedAt: null,
  };
}

// Existing drafts retain their original versions/specification until explicit
// review. A refresh must never silently rebase an unsent physical count.
export function editDraft(product, old, patch, options = {}) {
  const draft = old ? clone(old) : createDraft(product);
  if (patch.locations)
    for (const [zone, value] of Object.entries(patch.locations))
      draft.locations[zone] = {
        ...(draft.locations[zone] || { value: "", unit: "BASE" }),
        ...clone(value),
      };
  if (Object.hasOwn(patch, "approx")) draft.approx = Boolean(patch.approx);
  if (Object.hasOwn(patch, "low")) draft.low = Boolean(patch.low);
  draft.editVersion = options.editVersion || crypto.randomUUID();
  draft.countedAt = options.now || new Date().toISOString();
  return draft;
}

export function draftState(product, draft) {
  const state = {
    entered: false,
    complete: false,
    locations: [],
    total: 0n,
    totalValue: "0",
    error: null,
  };
  if (!draft) return state;
  const expected = zonesFor(draft.zones ? draft : product);
  const entered = expected.filter(
    (zone) => String(draft.locations?.[zone]?.value ?? "").trim() !== "",
  );
  state.entered = entered.length > 0;
  // Flags alone are not a physical count, including a manually marked Low.
  if (!state.entered) return state;
  if (entered.length !== expected.length) {
    state.error = "INCOMPLETE_LOCATIONS";
    return state;
  }
  try {
    for (const zone of expected) {
      const input = draft.locations[zone];
      if (input.unit && input.unit !== "BASE")
        throw failure("INVALID_QUANTITY");
      const parsed = quantityInput(input.value, draft.unit || product.unit);
      state.total += parsed.scaled;
      state.locations.push({ zoneId: zone, value: parsed.value, unit: "BASE" });
    }
    if (state.total > LIMIT) throw failure("QUANTITY_RANGE");
    state.totalValue = decimalValue(state.total);
    state.complete = true;
  } catch (error) {
    state.error = error.code || "INVALID_QUANTITY";
  }
  return state;
}

export function conflicts(snapshot, drafts = {}) {
  const products = new Map((snapshot?.products || []).map((p) => [p.id, p]));
  const result = [];
  for (const [id, draft] of Object.entries(drafts)) {
    const product = products.get(id);
    let reason;
    if (!product || product.deleted) reason = "PRODUCT_DELETED";
    else if (
      product.countVersion !== draft.countVersion ||
      product.unit !== draft.unit ||
      Boolean(product.active) !== Boolean(draft.active) ||
      !sameZones(product.zones, draft.zones)
    )
      reason = "COUNT_SPEC_CONFLICT";
    else if (product.stockVersion !== draft.stockVersion)
      reason = "STOCK_CONFLICT";
    if (reason) result.push({ id, reason, product, draft });
  }
  return result;
}

export function filterProducts(products, filters = {}) {
  const search = String(filters.search || "")
    .trim()
    .toLocaleLowerCase()
    .replace(/ё/g, "е");
  return products.filter((product) => {
    if (product.deleted) return false;
    const name = [product.ru, product.en, product.name]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .replace(/ё/g, "е");
    return (
      (!search || name.includes(search)) &&
      (!filters.zone ||
        (filters.zone === "unassigned"
          ? !product.zones?.length
          : product.zones?.includes(filters.zone))) &&
      (!filters.category || product.category === filters.category)
    );
  });
}

export function buildSubmission(snapshot, drafts, options = {}) {
  if (!snapshot?.databaseId || !Array.isArray(snapshot.products))
    throw failure("NO_SNAPSHOT");
  const scope = options.scope || "ENTERED";
  if (!["ALL", "ENTERED", "LOW"].includes(scope))
    throw failure("INVALID_SCOPE");
  const problems = conflicts(snapshot, drafts);
  if (problems.length) throw failure(problems[0].reason, problems[0].id);
  const items = [];
  const lowIds = [];
  const products = snapshot.products.filter((product) => !product.deleted);
  for (const product of products) {
    const draft = drafts[product.id];
    if (draft ? draft.low : product.low) lowIds.push(product.id);
    const state = draftState(product, draft);
    if (!state.entered) continue;
    if (state.error) throw failure(state.error, product.id);
    items.push({
      id: product.id,
      stockVersion: draft.stockVersion,
      countVersion: draft.countVersion,
      catalogVersion: draft.catalogVersion,
      editVersion: draft.editVersion,
      locations: state.locations,
      approx: Boolean(draft.approx),
      low: Boolean(draft.low),
      countedAt: draft.countedAt,
    });
  }
  // This immutable body, not the visible filtered list, is persisted before RPC.
  return clone({
    id: options.id || crypto.randomUUID(),
    items,
    notification: {
      scope,
      language: options.language === "ru" ? "ru" : "en",
      lowIds,
      // Freeze the report's entire catalog at Send, including uncounted and
      // inactive products. These cached quantities are REPORT-ONLY: only items
      // above are eligible for stock writes, and accepted server counts replace
      // their report quantities. Later catalog edits cannot change this scope.
      products: products.map((product) => ({
        id: product.id,
        ru: product.ru || "",
        en: product.en || "",
        unit: product.unit,
        active: Boolean(product.active),
        last: product.last ?? null,
        lastCountedAt: product.lastCountedAt ?? null,
        approx: drafts[product.id]
          ? Boolean(drafts[product.id].approx)
          : Boolean(product.approx),
        low: drafts[product.id]
          ? Boolean(drafts[product.id].low)
          : Boolean(product.low),
      })),
    },
    summary: {
      entered: items.length,
      uncounted: products.length - items.length,
      low: lowIds.length,
      inactive: products.filter((product) => !product.active).length,
      inactiveEntered: items.filter(
        (item) => !products.find((product) => product.id === item.id).active,
      ).length,
    },
  });
}

// Never spread an accepted result over catalog metadata: stock acknowledgment
// must not restore a stale name/category/active flag from a response snapshot.
export function applyAcknowledgment(record, result, request = record.pending) {
  const next = clone(record);
  if (
    !request ||
    [result.status, result.state].some((state) =>
      ["UNKNOWN", "PENDING", "PREPARED"].includes(state),
    )
  )
    return next;
  const submitted = new Map(request.items.map((item) => [item.id, item]));
  const products = new Map(
    (next.snapshot?.products || []).map((product) => [product.id, product]),
  );
  for (const accepted of result.accepted || []) {
    const original = submitted.get(accepted.id);
    if (!original) continue;
    if (
      accepted.editVersion !== undefined &&
      accepted.editVersion !== original.editVersion
    )
      continue;
    const product = products.get(accepted.id);
    if (
      product &&
      (product.stockVersion === original.stockVersion ||
        product.stockVersion === accepted.stockVersion)
    )
      for (const field of [
        "last",
        "lastCountedAt",
        "lastCountId",
        "stockVersion",
        "approx",
        "low",
        "lastLocations",
      ])
        if (Object.hasOwn(accepted, field))
          product[field] = clone(accepted[field]);
    const current = next.drafts?.[accepted.id];
    if (!current) continue;
    if (current.editVersion === original.editVersion) {
      delete next.drafts[accepted.id];
    } else if (
      current.stockVersion === original.stockVersion &&
      accepted.stockVersion !== undefined
    ) {
      // Own confirmed predecessor is safe to advance, unlike a remote refresh.
      current.stockVersion = accepted.stockVersion;
    }
  }
  if (next.pending?.id === request.id) next.pending = null;
  if (result.notification !== undefined)
    next.notification = clone(result.notification);
  next.lastResult = clone(result);
  return next;
}

export function mergeSnapshot(record, snapshot) {
  // Keep local work and durable request bytes untouched on every refresh.
  return { ...clone(record), snapshot: clone(snapshot) };
}
