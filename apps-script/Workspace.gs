/* Session-free VARKA workspace. Add alongside the original five files and
 * PwaBridge.gs/WorkspaceNotifications.gs. Never replace the original ledger.
 * All private helpers end in _, so google.script.run cannot bypass dispatch.
 */
function workspaceLayouts_() {
  return {
    WorkspaceOperations: [
      "ID",
      "Actor",
      "Kind",
      "SHA256",
      "Created",
      "Result",
      "Plan",
    ],
    WorkspaceReminders: [
      "ID",
      "Count version",
      "State",
      "Operation ID",
      "Updated",
    ],
    WorkspaceOperationParts: ["ID", "JSON"],
  };
}
function installWorkspace() {
  v4Owner_();
  return v3Lock_(() => {
    const book = book_(),
      properties = prop_(),
      layouts = workspaceLayouts_();
    const widths = {
      Products: 15,
      Events: 22,
      UserProfiles: 3,
      Reminders: 8,
      YellowCards: 11,
    };
    Object.keys(widths).forEach((name) => {
      const sheet = book.getSheetByName(name);
      if (!sheet || sheet.getDataRange().getValues()[0].length < widths[name])
        throw Error("WORKSPACE_LEGACY_SCHEMA_MISSING");
    });
    const productHeader = book
      .getSheetByName("Products")
      .getDataRange()
      .getValues()[0];
    if (productHeader.length < 15)
      throw Error("WORKSPACE_LEGACY_SCHEMA_MISSING");
    Object.keys(layouts).forEach((name) => {
      const sheet = book.getSheetByName(name);
      if (
        sheet &&
        JSON.stringify(sheet.getDataRange().getValues()[0]) !==
          JSON.stringify(layouts[name])
      )
        throw Error("WORKSPACE_LAYOUT_CONFLICT");
    });
    if (!properties.getProperty("WORKSPACE_BACKUP_ID")) {
      const backup = book.copy(
        "VARKA backup before session-free workspace " +
          new Date().toISOString(),
      );
      properties.setProperty("WORKSPACE_BACKUP_ID", backup.getId());
    }
    Object.keys(layouts).forEach((name) => v3Sheet_(name, layouts[name]));
    properties.setProperty("WORKSPACE_INSTALLED", "1");
    return { ok: true, backedUp: true, version: 1 };
  });
}
function workspaceReady_() {
  if (prop_().getProperty("WORKSPACE_INSTALLED") !== "1")
    throw Error("WORKSPACE_NOT_INSTALLED");
  Object.keys(workspaceLayouts_()).forEach((name) => {
    if (!book_().getSheetByName(name)) throw Error("WORKSPACE_NOT_INSTALLED");
  });
}
function workspaceHash_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(value),
    Utilities.Charset.UTF_8,
  )
    .map((n) => ("0" + ((n + 256) % 256).toString(16)).slice(-2))
    .join("");
}
function workspaceId_(id) {
  // A bare numeric/scientific-looking ID would be coerced by Sheets. Browser
  // requests use UUIDs; named integrations may use an alphabetic prefix.
  if (
    typeof id !== "string" ||
    !/^(?:[a-zA-Z][a-zA-Z0-9-]{15,79}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/.test(
      id,
    )
  )
    throw Error("INVALID_ID");
  return id;
}
function workspaceText_(value, maximum, required) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw Error("INVALID_TEXT");
  const text = value.trim();
  if (required && !text) throw Error("INVALID_REQUIRED");
  return text;
}
function workspaceJson_(value) {
  const json = JSON.stringify(value);
  if (json.length > 45000) throw Error("WORKSPACE_REQUEST_TOO_LARGE");
  return json;
}
// Sheets cells have a 50,000 character ceiling. Large catalogs are not capped:
// immutable, hashed pieces are written before their small reference cell.
function workspaceEncode_(id, field, value) {
  const json = JSON.stringify(value);
  if (json.length <= 45000) return json;
  const hash = workspaceHash_(json),
    ids = [],
    sheet = book_().getSheetByName("WorkspaceOperationParts");
  const existing = new Map(
    sheet
      .getDataRange()
      .getValues()
      .slice(1)
      .map((r) => [r[0], r[1]]),
  );
  for (let i = 0; i < json.length; i += 40000) {
    const key = id + ":" + field + ":" + hash + ":" + i,
      part = "JSON:" + json.slice(i, i + 40000);
    if (existing.has(key) && existing.get(key) !== part)
      throw Error("COMMIT_UNCONFIRMED");
    if (!existing.has(key)) sheet.appendRow([key, part]);
    ids.push(key);
  }
  SpreadsheetApp.flush();
  return JSON.stringify({ workspaceParts: ids, hash: hash });
}
function workspaceDecode_(cell) {
  const value = JSON.parse(cell);
  if (!value || !Array.isArray(value.workspaceParts)) return value;
  const parts = new Map(
    workspaceRows_("WorkspaceOperationParts").map((r) => [r[0], r[1]]),
  );
  if (value.workspaceParts.some((id) => !parts.has(id)))
    throw Error("COMMIT_UNCONFIRMED");
  if (
    value.workspaceParts.some(
      (id) =>
        typeof parts.get(id) !== "string" || !parts.get(id).startsWith("JSON:"),
    )
  )
    throw Error("COMMIT_UNCONFIRMED");
  const json = value.workspaceParts
    .map((id) => parts.get(id).slice(5))
    .join("");
  if (workspaceHash_(json) !== value.hash) throw Error("COMMIT_UNCONFIRMED");
  return JSON.parse(json);
}
function workspaceRows_(name) {
  const sheet = book_().getSheetByName(name);
  return sheet
    ? sheet
        .getDataRange()
        .getValues()
        .slice(1)
        .filter((r) => r[0])
    : [];
}
function workspaceProfile_(email) {
  const row = workspaceRows_("UserProfiles").find(
    (r) => String(r[0]).toLowerCase() === email.toLowerCase(),
  );
  return { email: email, name: row && row[1] ? String(row[1]) : null };
}
function workspaceManage_(email) {
  return typeof v10CanManage_ === "function" && v10CanManage_(email);
}
function workspaceMetadata_(p) {
  return workspaceHash_(
    Array.from({ length: 15 }, (_, i) => (p[i] == null ? "" : p[i])),
  );
}
function workspaceCountVersion_(p) {
  return workspaceHash_([
    p[0],
    p[4],
    p[5] || "",
    p[6],
    p[13] || "",
    v8ProductZones_(p),
  ]);
}
function workspaceStockVersion_(id, events, state) {
  const latest = events
    .filter(
      (e) =>
        e[3] === id &&
        e[4] === "CAFE" &&
        ["CHECK", "RECEIVE", "WASTE"].includes(e[2]),
    )
    .slice(-1)[0];
  const s = state || {};
  return workspaceHash_([
    id,
    latest ? latest[0] : null,
    s.q == null ? null : s.q,
    s.checked ? new Date(s.checked).toISOString() : null,
    s.last ? new Date(s.last).toISOString() : null,
    s.quality || "",
    !!s.low,
    s.by || "",
    s.note || "",
  ]);
}
function workspaceProducts_() {
  const products = rows_("Products"),
    events = rows_("Events"),
    state = totalState_(events, baselines_());
  const batches = workspaceRows_("Events")
    .map((r) => v5Decode_(r))
    .filter(Boolean);
  const catalogTimes = new Map(
    workspaceRows_("WorkspaceOperations")
      .filter((row) => row[2] === "catalog")
      .map((row) => [row[0], row[4]]),
  );
  return products
    .filter((p) => p[13] !== "YES")
    .map((p) => {
      const current = state[p[0]] || {
        q: null,
        checked: null,
        low: false,
        quality: "",
      };
      const lastCheck = events
        .filter(
          (event) =>
            event[3] === p[0] && event[4] === "CAFE" && event[2] === "CHECK",
        )
        .slice(-1)[0];
      return {
        id: p[0],
        ru: p[1],
        en: p[2] || "",
        category: p[3],
        unit: p[4],
        sleeve: p[4] === "pcs" && Number(p[5]) === 25,
        zones: v8ProductZones_(p),
        active: p[6] === "YES",
        minimum: p[7] === "" || p[7] == null ? null : Number(p[7]),
        reminderHours: Number(p[8]) > 0 ? Number(p[8]) : null,
        stockVersion: workspaceStockVersion_(p[0], events, current),
        countVersion: workspaceCountVersion_(p),
        catalogVersion: workspaceMetadata_(p),
        catalogUpdatedAt: catalogTimes.get(p[12]) || null,
        last: current.q == null ? null : current.q,
        lastCountedAt: current.checked
          ? new Date(current.checked).toISOString()
          : null,
        lastCountId: lastCheck?.[0] || null,
        lastLocations:
          batches
            .slice()
            .reverse()
            .find((b) => b.events.some((e) => e[0] === lastCheck?.[0]))
            ?.locations?.find((item) => item.productId === p[0])?.locations ||
          null,
        approx: current.quality === "ESTIMATED",
        low: !!current.low,
      };
    });
}
function workspaceInformation_() {
  return {
    notes: workspaceRows_("Reminders").map((r) => ({
      id: r[0],
      text: r[1],
      done: r[2] === "DONE",
      created: r[3] ? new Date(r[3]).toISOString() : null,
      by: r[5] || null,
      authorName: r[7] || null,
      version: workspaceHash_(r),
    })),
    cards: workspaceRows_("YellowCards")
      .filter((r) => r[8] !== "NO")
      .map((r) => ({
        id: String(r[0]),
        name: r[1],
        size: r[2] || "",
        category: r[3] || "",
        note: r[4] || "",
        by: r[7] || null,
        authorName: r[9] || null,
        updated: r[6] ? new Date(r[6]).toISOString() : null,
        version: workspaceHash_(r),
      })),
  };
}
function workspaceLoad_(email) {
  return v3Lock_(() => {
    workspaceReady_();
    const products = workspaceProducts_();
    return {
      version: 1,
      databaseId: book_().getId(),
      loadedAt: new Date().toISOString(),
      products: products,
      zones: v8Zones_(),
      categories: [...new Set(products.map((p) => p.category))].sort(),
      ...workspaceInformation_(),
      profile: workspaceProfile_(email),
      permissions: {
        write: prop_().getProperty("PWA_WRITES_ENABLED") === "true",
        manageReminders: workspaceManage_(email),
      },
      reminders: { configured: workspaceRemindersConfigured_() },
    };
  });
}
function workspaceOperation_(id) {
  const rows = book_()
    .getSheetByName("WorkspaceOperations")
    .getDataRange()
    .getValues();
  const index = rows.findIndex((r, i) => i > 0 && r[0] === id);
  if (index < 1) return null;
  const row = rows[index];
  return {
    row: index + 1,
    id: row[0],
    actor: row[1],
    kind: row[2],
    hash: row[3],
    result: workspaceDecode_(row[5]),
    plan: row[6] ? workspaceDecode_(row[6]) : null,
  };
}
function workspaceAppendOperation_(id, actor, kind, hash, result, plan) {
  const sheet = book_().getSheetByName("WorkspaceOperations");
  sheet.appendRow([
    id,
    actor,
    kind,
    hash,
    new Date().toISOString(),
    workspaceEncode_(id, "result", result),
    plan ? workspaceEncode_(id, "plan", plan) : "",
  ]);
  SpreadsheetApp.flush();
  return workspaceOperation_(id);
}
function workspaceWriteResult_(operation, result) {
  book_()
    .getSheetByName("WorkspaceOperations")
    .getRange(operation.row, 6)
    .setValue(workspaceEncode_(operation.id, "result", result));
  SpreadsheetApp.flush();
  operation.result = result;
}
function workspacePrior_(id, email, kind, body) {
  const previous = workspaceOperation_(id);
  if (
    previous &&
    (previous.actor !== email ||
      previous.kind !== kind ||
      previous.hash !== workspaceHash_(body))
  )
    throw Error("REQUEST_ID_REUSED");
  return previous;
}
// Apps Script's source parser rejects arbitrary-precision integer literals.
// Keep scaled quantities as decimal text: 1e9 at eight decimal places exceeds
// Number.MAX_SAFE_INTEGER. Convert only after exact summation and validation.
function workspaceScaledText_(text) {
  const parts = text.split(".");
  return (parts[0] + (parts[1] || "").padEnd(8, "0")).replace(/^0+(?=\d)/, "");
}
function workspaceAddScaled_(left, right) {
  let result = "",
    carry = 0,
    i = left.length - 1,
    j = right.length - 1;
  while (i >= 0 || j >= 0 || carry) {
    const sum =
      Number(i >= 0 ? left[i--] : 0) + Number(j >= 0 ? right[j--] : 0) + carry;
    result = String(sum % 10) + result;
    carry = Math.floor(sum / 10);
  }
  return result || "0";
}
function workspaceScaledNumber_(scaled) {
  const maximum = "100000000000000000";
  if (
    scaled.length > maximum.length ||
    (scaled.length === maximum.length && scaled > maximum)
  )
    throw Error("INVALID_QUANTITY");
  const padded = scaled.padStart(9, "0");
  const quantity = Number(padded.slice(0, -8) + "." + padded.slice(-8));
  // The native Sheets ledger uses numbers. Reject any quantity that cannot
  // retain its exact eight-decimal value instead of silently rounding it.
  if (
    !Number.isFinite(quantity) ||
    workspaceScaledText_(quantity.toFixed(8)) !== scaled
  )
    throw Error("INVALID_QUANTITY");
  return quantity;
}
function workspaceQuantity_(value, unit) {
  if (!["l", "kg", "pcs", "pack", "roll"].includes(unit))
    throw Error("INVALID_UNIT");
  if (!["string", "number"].includes(typeof value))
    throw Error("INVALID_QUANTITY");
  const text = String(value).trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,8})?$/.test(text)) throw Error("INVALID_QUANTITY");
  const decimal = text.split(".")[1] || "";
  if (unit === "pcs" && /[1-9]/.test(decimal)) throw Error("INVALID_QUANTITY");
  return workspaceScaledNumber_(workspaceScaledText_(text));
}
function workspaceCountTotal_(item, product) {
  const expected = product.zones.length ? product.zones : ["unassigned"];
  if (
    !Array.isArray(item.locations) ||
    item.locations.length !== expected.length
  )
    throw Error("INVALID_ZONES");
  const found = new Set();
  let scaled = "0";
  for (const location of item.locations) {
    if (
      !location ||
      location.unit !== "BASE" ||
      !expected.includes(location.zoneId) ||
      found.has(location.zoneId)
    )
      throw Error("INVALID_ZONES");
    found.add(location.zoneId);
    workspaceQuantity_(location.value, product.unit);
    const text = String(location.value).trim().replace(",", ".");
    scaled = workspaceAddScaled_(scaled, workspaceScaledText_(text));
  }
  return workspaceScaledNumber_(scaled);
}
function workspaceReportProducts_(notification, current, storedRows) {
  if (notification.products === undefined) return current;
  if (!Array.isArray(notification.products))
    throw Error("INVALID_NOTIFICATION");
  const known = new Map(storedRows.map((row) => [row[0], row])),
    seen = new Set();
  return notification.products.map((input) => {
    if (
      !input ||
      typeof input.id !== "string" ||
      seen.has(input.id) ||
      !known.has(input.id)
    )
      throw Error("INVALID_NOTIFICATION");
    seen.add(input.id);
    const ru = workspaceText_(input.ru, 160, true),
      en = workspaceText_(input.en || "", 160, false);
    if (
      !["l", "kg", "pcs", "pack", "roll"].includes(input.unit) ||
      typeof input.active !== "boolean" ||
      typeof input.approx !== "boolean" ||
      typeof input.low !== "boolean"
    )
      throw Error("INVALID_NOTIFICATION");
    // Previously recorded native balances may contain old IEEE-754 movement
    // artifacts (0.1 + 0.2), unlike a newly entered count. They are report-only.
    const last = input.last == null ? null : Number(input.last);
    if (
      last !== null &&
      (!["number", "string"].includes(typeof input.last) ||
        String(input.last).trim() === "" ||
        !Number.isFinite(last) ||
        Math.abs(last) > 1e12)
    )
      throw Error("INVALID_NOTIFICATION");
    if (
      input.lastCountedAt != null &&
      (typeof input.lastCountedAt !== "string" ||
        !Number.isFinite(Date.parse(input.lastCountedAt)))
    )
      throw Error("INVALID_NOTIFICATION");
    return {
      id: input.id,
      ru: ru,
      en: en,
      unit: input.unit,
      active: known.get(input.id)[13] === "YES" ? false : input.active,
      last: last,
      lastCountedAt:
        input.lastCountedAt == null
          ? null
          : new Date(input.lastCountedAt).toISOString(),
      approx: input.approx,
      low: input.low,
    };
  });
}
function workspaceCount_(email, request) {
  return v3Lock_(() => {
    workspaceReady_();
    const id = workspaceId_(request.id);
    const previous = workspacePrior_(id, email, "count", request);
    if (previous) return workspaceFinishCount_(previous);
    if (
      !Array.isArray(request.items) ||
      !request.notification ||
      !["ALL", "ENTERED", "LOW"].includes(request.notification.scope) ||
      !["en", "ru"].includes(request.notification.language) ||
      !Array.isArray(request.notification.lowIds)
    )
      throw Error("INVALID_COUNT");
    const products = workspaceProducts_(),
      productMap = new Map(products.map((p) => [p.id, p]));
    if (
      request.notification.lowIds.some(
        (pid) => typeof pid !== "string" || !pid || pid.length > 160,
      )
    )
      throw Error("INVALID_NOTIFICATION");
    const result = {
        id: id,
        state: "PREPARED",
        accepted: [],
        failed: [],
        conflicted: [],
      },
      events = [],
      seen = new Set(),
      at = new Date().toISOString();
    const originalRows = rows_("Products"),
      operationId = "V5BATCH:" + id,
      hash = workspaceHash_(request);
    const reportProducts = workspaceReportProducts_(
      request.notification,
      products,
      originalRows,
    );
    for (const pid of new Set(request.notification.lowIds)) {
      if (
        !productMap.has(pid) &&
        !request.items.some((item) => item?.id === pid)
      )
        result.conflicted.push({ id: pid, error: "PRODUCT_DELETED" });
    }
    for (const item of request.items) {
      if (!item || typeof item.id !== "string" || seen.has(item.id))
        throw Error("INVALID_DUPLICATE_PRODUCT");
      seen.add(item.id);
      const product = productMap.get(item.id),
        base = { id: item.id, editVersion: item.editVersion };
      if (!product) {
        result.conflicted.push({ ...base, error: "PRODUCT_DELETED" });
        continue;
      }
      if (
        item.stockVersion !== product.stockVersion ||
        item.countVersion !== product.countVersion
      ) {
        result.conflicted.push({
          ...base,
          error:
            item.stockVersion !== product.stockVersion
              ? "STOCK_CONFLICT"
              : "PRODUCT_CHANGED",
          current: product,
        });
        continue;
      }
      try {
        if (
          typeof item.approx !== "boolean" ||
          typeof item.low !== "boolean" ||
          typeof item.editVersion !== "string" ||
          !/^[-a-zA-Z0-9]{16,80}$/.test(item.editVersion)
        )
          throw Error("INVALID_FLAGS");
        const total = workspaceCountTotal_(item, product),
          p = originalRows.find((p) => p[0] === item.id);
        const event = [
          operationId + ":" + item.id,
          at,
          "CHECK",
          item.id,
          "CAFE",
          "",
          total,
          email,
          item.approx ? "ESTIMATED" : "EXACT",
          item.low ? "YES" : "NO",
          "",
          "",
          product.last == null ? "" : product.last,
          p[4],
          p[1],
          p[2] || "",
          "",
          "",
          hash,
          "WORKSPACE_COUNT",
          at,
          workspaceProfile_(email).name || "",
        ];
        events.push(event);
        const accepted = {
          ...base,
          last: total,
          lastCountedAt: at,
          lastCountId: event[0],
          lastLocations: item.locations,
          unit: product.unit,
          approx: item.approx,
          low: item.low,
          catalogVersion: product.catalogVersion,
          countVersion: product.countVersion,
        };
        // Mirror totalState_ exactly so the returned version equals the next load.
        const state = {
          q: total,
          checked: at,
          by: email,
          quality: item.approx ? "ESTIMATED" : "EXACT",
          low: item.low,
          last: at,
          note: "",
        };
        accepted.stockVersion = workspaceStockVersion_(item.id, [event], state);
        result.accepted.push(accepted);
      } catch (error) {
        result.failed.push({ ...base, error: String(error.message) });
      }
    }
    result.notification = workspaceNotification_(
      request,
      result,
      reportProducts,
      email,
    );
    const batch = {
      version: 8,
      operationId: operationId,
      sessionId: "",
      by: email,
      authorName: workspaceProfile_(email).name || "",
      submittedAt: at,
      requestHash: hash,
      kind: "WORKSPACE_COUNT",
      status: "COMPLETE",
      missing: [],
      compactDefaults: true,
      events: [],
    };
    const chunks = [],
      compactEvents = events.map((event) => {
        const row = event.slice();
        [1, 7, 18, 21].forEach((i) => (row[i] = ""));
        return row;
      });
    const locationsFor = (items) =>
      request.items
        .filter((item) => items.some((event) => event[3] === item.id))
        .map((item) => ({ productId: item.id, locations: item.locations }));
    let chunk = [];
    for (const event of compactEvents) {
      if (
        JSON.stringify({
          ...batch,
          events: [...chunk, event],
          locations: locationsFor([...chunk, event]),
        }).length > 40000 &&
        chunk.length
      ) {
        chunks.push(chunk);
        chunk = [];
      }
      chunk.push(event);
    }
    if (chunk.length) chunks.push(chunk);
    const envelopes = chunks.map((items, index) => {
      const chunkId = operationId + "-" + index,
        json = workspaceJson_({
          ...batch,
          operationId: chunkId,
          events: items,
          locations: locationsFor(items),
        });
      return {
        ids: items.map((event) => event[3]),
        row: [
          chunkId,
          at,
          "SESSION_BATCH",
          "",
          "CAFE",
          "",
          items.length,
          email,
          "",
          "",
          json,
          "",
          "",
          "",
          "",
          "",
          "",
          hash,
          webHash_(json),
          "V5_SESSION",
        ],
      };
    });
    const plan = {
      envelopes: envelopes,
      notification: request.notification,
      products: reportProducts,
      expected: request.items
        .filter((item) => result.accepted.some((a) => a.id === item.id))
        .map((item) => ({
          id: item.id,
          stockVersion: item.stockVersion,
          countVersion: item.countVersion,
        })),
    };
    return workspaceFinishCount_(
      workspaceAppendOperation_(id, email, "count", hash, result, plan),
    );
  });
}
function workspaceFinishCount_(operation) {
  if (operation.result.state !== "PREPARED") return operation.result;
  const plan = operation.plan,
    sheet = book_().getSheetByName("Events");
  for (const envelope of plan.envelopes) {
    const prior = sheet
      .getDataRange()
      .getValues()
      .slice(1)
      .find((r) => r[0] === envelope.row[0]);
    if (prior) {
      const batch = v5Decode_(prior);
      if (
        !batch ||
        batch.requestHash !== operation.hash ||
        batch.by !== operation.actor
      )
        throw Error("COMMIT_UNCONFIRMED");
      continue;
    }
    const products = workspaceProducts_();
    const changed = plan.expected
      .filter((expected) => envelope.ids.includes(expected.id))
      .some((expected) => {
        const p = products.find((p) => p.id === expected.id);
        return (
          !p ||
          p.stockVersion !== expected.stockVersion ||
          p.countVersion !== expected.countVersion
        );
      });
    if (changed) {
      operation.result.conflicted.push(
        ...operation.result.accepted
          .filter((item) => envelope.ids.includes(item.id))
          .map((item) => ({
            id: item.id,
            editVersion: item.editVersion,
            error: "STOCK_CONFLICT",
          })),
      );
      operation.result.accepted = operation.result.accepted.filter(
        (item) => !envelope.ids.includes(item.id),
      );
    } else {
      sheet.appendRow(envelope.row);
      SpreadsheetApp.flush();
      const saved = sheet
        .getDataRange()
        .getValues()
        .slice(1)
        .find((r) => r[0] === envelope.row[0]);
      if (!v5Decode_(saved)) throw Error("COMMIT_UNCONFIRMED");
    }
  }
  operation.result.notification = workspaceNotification_(
    { notification: plan.notification },
    operation.result,
    plan.products,
    operation.actor,
  );
  operation.result.state = "COMMITTED";
  workspaceWriteResult_(operation, operation.result);
  return operation.result;
}
function workspaceCatalog_(email, request) {
  return v3Lock_(() => {
    workspaceReady_();
    const id = workspaceId_(request.id),
      previous = workspacePrior_(id, email, "catalog", request);
    if (previous) return workspaceFinishCatalog_(previous);
    if (
      !["save", "status", "delete"].includes(request.action) ||
      !request.product
    )
      throw Error("INVALID_CATALOG");
    if (typeof v9MaterializeProducts_ === "function") v9MaterializeProducts_();
    const sheet = book_().getSheetByName("Products"),
      rows = sheet.getDataRange().getValues(),
      input = request.product;
    const index = input.id
      ? rows.findIndex((r, i) => i > 0 && r[0] === input.id)
      : -1;
    if (input.id && (index < 1 || rows[index][13] === "YES"))
      throw Error("PRODUCT_DELETED");
    if (!input.id && request.action !== "save") throw Error("PRODUCT_DELETED");
    let product =
      index > 0
        ? Array.from({ length: 15 }, (_, i) =>
            rows[index][i] == null ? "" : rows[index][i],
          )
        : null;
    if (product && input.catalogVersion !== workspaceMetadata_(product))
      throw Error("CATALOG_CONFLICT");
    const before = product ? product.slice() : null;
    if (request.action === "delete") {
      product[13] = "YES";
      product[6] = "NO";
    } else if (request.action === "status") {
      if (typeof input.active !== "boolean") throw Error("INVALID_STATUS");
      product[6] = input.active ? "YES" : "NO";
    } else {
      const name = workspaceText_(input.ru, 160, true),
        english = workspaceText_(input.en || "", 160, false),
        category = workspaceText_(input.category, 100, true);
      if (!rows.slice(1).some((r) => r[13] !== "YES" && r[3] === category))
        throw Error("EXISTING_CATEGORY_REQUIRED");
      if (
        rows
          .slice(1)
          .some(
            (r) =>
              r[0] !== input.id &&
              String(r[1]).trim().toLowerCase() === name.toLowerCase(),
          )
      )
        throw Error("PRODUCT_NAME_EXISTS");
      if (
        typeof input.active !== "boolean" ||
        !["l", "kg", "pcs", "pack", "roll"].includes(input.unit)
      )
        throw Error("INVALID_UNIT");
      if (
        !Array.isArray(input.zones) ||
        !input.zones.length ||
        input.zones.some((zone) => !v8Zones_().some((z) => z.id === zone)) ||
        new Set(input.zones).size !== input.zones.length
      )
        throw Error("INVALID_ZONES");
      const minimum =
        input.minimum == null || input.minimum === ""
          ? ""
          : workspaceQuantity_(input.minimum, input.unit);
      const hours =
        input.reminderHours == null || input.reminderHours === ""
          ? 0
          : Number(input.reminderHours);
      if (
        !Number.isFinite(hours) ||
        hours < 0 ||
        hours > 87600 ||
        (hours !== 0 && hours < 1 / 60)
      )
        throw Error("INVALID_INTERVAL");
      if (
        product &&
        product[4] !== input.unit &&
        (rows_("Events").some((e) => e[3] === product[0]) ||
          baselines_()[product[0]]?.q != null)
      )
        throw Error("UNIT_HAS_HISTORY");
      if (!product) {
        const next =
          1 +
          Math.max(
            0,
            ...rows
              .slice(1)
              .map((r) => (/^P\d+$/.test(r[0]) ? Number(r[0].slice(1)) : 0)),
          );
        product = [
          "P" + String(next).padStart(3, "0"),
          "",
          "",
          "",
          "",
          "",
          "YES",
          "",
          0,
          "",
          "",
          id,
          id,
          "",
          "",
        ];
      }
      [
        product[1],
        product[2],
        product[3],
        product[4],
        product[6],
        product[7],
        product[8],
        product[14],
      ] = [
        v3Cell_(name),
        v3Cell_(english),
        v3Cell_(category),
        input.unit,
        input.active ? "YES" : "NO",
        minimum,
        hours,
        JSON.stringify(input.zones.slice().sort()),
      ];
    }
    product[12] = id;
    const plan = { before: before, after: product },
      result = {
        state: "PREPARED",
        ...(request.action === "delete"
          ? { deleted: product[0] }
          : { productId: product[0] }),
      };
    return workspaceFinishCatalog_(
      workspaceAppendOperation_(
        id,
        email,
        "catalog",
        workspaceHash_(request),
        result,
        plan,
      ),
    );
  });
}
function workspaceFinishCatalog_(operation) {
  if (operation.result.state !== "PREPARED") return operation.result;
  if (typeof v9MaterializeProducts_ === "function") v9MaterializeProducts_();
  const sheet = book_().getSheetByName("Products"),
    all = sheet.getDataRange().getValues(),
    plan = operation.plan;
  const index = all.findIndex((r, i) => i > 0 && r[0] === plan.after[0]),
    current =
      index > 0
        ? Array.from({ length: 15 }, (_, i) =>
            all[index][i] == null ? "" : all[index][i],
          )
        : null;
  if (JSON.stringify(current) !== JSON.stringify(plan.after)) {
    if (JSON.stringify(current) !== JSON.stringify(plan.before))
      throw Error("CATALOG_RECOVERY_CONFLICT");
    sheet
      .getRange(index > 0 ? index + 1 : sheet.getLastRow() + 1, 1, 1, 15)
      .setValues([plan.after]);
    SpreadsheetApp.flush();
  }
  operation.result.state = "COMMITTED";
  if (!operation.result.deleted)
    operation.result.product = workspaceProducts_().find(
      (p) => p.id === plan.after[0],
    );
  workspaceWriteResult_(operation, operation.result);
  return operation.result;
}
function workspaceTeam_(email, request) {
  return v3Lock_(() => {
    workspaceReady_();
    const id = workspaceId_(request.id),
      previous = workspacePrior_(id, email, "team", request);
    if (previous) return previous.result;
    const at = new Date().toISOString(),
      profile = workspaceProfile_(email);
    let result;
    if (request.kind === "note") {
      const text = workspaceText_(request.text, 1000, true),
        sheet = book_().getSheetByName("Reminders");
      const prior = sheet
        .getDataRange()
        .getValues()
        .slice(1)
        .find((r) => r[0] === id);
      if (!prior)
        sheet.appendRow([
          id,
          v3Cell_(text),
          "OPEN",
          at,
          at,
          email,
          email,
          profile.name || "",
        ]);
      else if (prior[5] !== email || prior[1] !== v3Cell_(text))
        throw Error("REQUEST_ID_REUSED");
      result = { ok: true, id: id };
    } else if (request.kind === "card") {
      const code = String(request.code || "")
        .trim()
        .toUpperCase();
      if (!/^[A-ZА-Я]{0,3}[1-9]\d{0,5}$/.test(code))
        throw Error("INVALID_CARD_NUMBER");
      const sheet = book_().getSheetByName("YellowCards"),
        all = sheet.getDataRange().getValues();
      const prior = all.slice(1).find((r) => r[10] === id);
      const name = workspaceText_(request.name, 160, true),
        size = workspaceText_(request.size || "", 100, false),
        category = workspaceText_(request.category, 100, true),
        note = workspaceText_(request.note || "", 500, false);
      if (
        prior &&
        (prior[7] !== email ||
          prior[0] !== code ||
          prior[1] !== v3Cell_(name) ||
          prior[2] !== v3Cell_(size) ||
          prior[3] !== v3Cell_(category) ||
          prior[4] !== v3Cell_(note))
      )
        throw Error("REQUEST_ID_REUSED");
      if (!prior) {
        if (all.slice(1).some((r) => String(r[0]) === code))
          throw Error("CARD_EXISTS");
        sheet.appendRow([
          code,
          v3Cell_(name),
          v3Cell_(size),
          v3Cell_(category),
          v3Cell_(note),
          "NO",
          at,
          email,
          "YES",
          profile.name || "",
          id,
        ]);
      }
      result = { ok: true, id: code };
    } else throw Error("METHOD_NOT_ALLOWED");
    SpreadsheetApp.flush();
    workspaceAppendOperation_(
      id,
      email,
      "team",
      workspaceHash_(request),
      result,
    );
    return result;
  });
}
function workspaceDispatch_(method, token, body) {
  if (method === "workspaceLogin") {
    try {
      return webLogin(body.username, body.password);
    } catch (error) {
      const message = String(error.message);
      if (/15/.test(message)) throw Error("LOGIN_RATE_LIMIT");
      if (/not installed|не установлено/i.test(message))
        throw Error("WORKSPACE_NOT_INSTALLED");
      throw Error("INVALID_LOGIN");
    }
  }
  const email = webAuth_(token);
  workspaceReady_();
  if (method === "workspaceLoad") return workspaceLoad_(email);
  if (method === "workspaceStatus")
    return v3Lock_(() => {
      const operation = workspaceOperation_(workspaceId_(body.id));
      if (!operation) return { status: "ABSENT" };
      if (operation.actor !== email) throw Error("OWN_OPERATION_ONLY");
      return {
        status: operation.result.state || "COMMITTED",
        result: operation.result,
      };
    });
  if (prop_().getProperty("PWA_WRITES_ENABLED") !== "true")
    throw Error("PWA_READ_ONLY");
  if (method === "workspaceCount" || method === "workspaceCatalog") {
    const result =
      method === "workspaceCount"
        ? workspaceCount_(email, body)
        : workspaceCatalog_(email, body);
    // Keep the original derived CafeStock/Dashboard sheets useful, but never
    // roll back inventory or resend the old alert pipeline if a view fails.
    if (typeof rebuild_ === "function") {
      try {
        v3Lock_(() => rebuild_());
      } catch (ignored) {
        result.warning = "DASHBOARD_REFRESH_FAILED";
      }
    }
    return result;
  }
  if (method === "workspaceTeam") return workspaceTeam_(email, body);
  if (method === "workspaceNotify")
    return workspaceDeliver_(workspaceId_(body.id), email);
  throw Error("METHOD_NOT_ALLOWED");
}
