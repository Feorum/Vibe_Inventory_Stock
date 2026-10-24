import {
  operation,
  version,
  problem,
  inputQuantity,
  quantity,
  decimal,
  bool,
  text,
  zones,
  hash,
  canonical,
  MAX,
} from "./core.js";
import { catalog, product, appendEvent, queueReport } from "./stock.js";

function snapshot(item) {
  return {
    id: item.id,
    ru: item.ru,
    en: item.en,
    category: item.category,
    unit: item.unit,
    sleeve: item.sleeve,
    previous: item.quantity,
    revision: item.revision,
    zones: item.zones,
  };
}
export function session(db, id) {
  const row = db
    .prepare("SELECT * FROM varka_inventory_sessions WHERE id=?")
    .get(id);
  if (!row) problem(404, "SESSION_NOT_FOUND");
  const counts = new Map(
    db
      .prepare(
        "SELECT * FROM varka_events WHERE session_id=? AND action='CHECK' ORDER BY seq",
      )
      .all(id)
      .map((event) => [event.product_id, event]),
  );
  const items = JSON.parse(row.snapshot).map((item) => ({
    ...item,
    checked: counts.has(item.id),
    eventId: counts.get(item.id)?.id || null,
    countedQuantity: counts.get(item.id)?.quantity ?? null,
  }));
  return {
    id: row.id,
    owner: row.owner,
    createdAt: row.created_at,
    status: row.status,
    closedAt: row.closed_at,
    version: row.version,
    items,
    missing: JSON.parse(row.missing),
    total: items.length,
    checked: items.filter((item) => item.checked).length,
    remaining: items.filter((item) => !item.checked).length,
  };
}
export function recentSessions(db, actor) {
  return db
    .prepare(
      "SELECT id FROM varka_inventory_sessions ORDER BY created_at DESC,rowid DESC LIMIT 100",
    )
    .all()
    .map((row) => {
      const result = session(db, row.id);
      delete result.items;
      return { ...result, mine: result.owner === actor.email };
    });
}
export function startSession(db, actor, id, body = {}) {
  return operation(db, actor, id, "SESSION_START", body, () => {
    const items = catalog(db)
      .filter((item) => item.active)
      .map(snapshot);
    if (!items.length)
      problem(
        409,
        "NO_ACTIVE_PRODUCTS",
        "Add or enable a product before starting a count.",
      );
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO varka_inventory_sessions(id,owner,created_at,snapshot) VALUES(?,?,?,?)",
    ).run(id, actor.email, now, JSON.stringify(items));
    db.prepare(
      "INSERT INTO varka_session_journal(id,session_id,action,actor,at,payload) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      id,
      "START",
      actor.email,
      now,
      JSON.stringify({ products: items }),
    );
    return { session: session(db, id) };
  });
}
function owns(current, actor) {
  if (current.owner !== actor.email) problem(403, "OWN_SESSION_ONLY");
  if (current.status !== "OPEN") problem(409, "SESSION_CLOSED");
}

export function refreshSession(db, actor, id, sessionId, body) {
  return operation(
    db,
    actor,
    id,
    "SESSION_REFRESH",
    { sessionId, ...body },
    () => {
      const current = session(db, sessionId);
      owns(current, actor);
      version(current.version, body.version, "Checklist");
      const all = catalog(db, { archived: true });
      const items = current.items.map((old) =>
        old.checked
          ? old
          : snapshot(all.find((item) => item.id === old.id) || old),
      );
      for (const item of all)
        if (
          item.active &&
          !item.archived &&
          !items.some((old) => old.id === item.id)
        )
          items.push(snapshot(item));
      db.prepare(
        "UPDATE varka_inventory_sessions SET snapshot=?,version=version+1 WHERE id=?",
      ).run(JSON.stringify(items), sessionId);
      db.prepare(
        "INSERT INTO varka_session_journal(id,session_id,action,actor,at,payload) VALUES(?,?,?,?,?,?)",
      ).run(
        id,
        sessionId,
        "REFRESH",
        actor.email,
        new Date().toISOString(),
        JSON.stringify({ products: items }),
      );
      return { session: session(db, sessionId) };
    },
  );
}

function countedQuantity(entry, item, spec) {
  if (
    canonical([...item.zones].sort()) !==
    canonical([...(spec.zones || [])].sort())
  )
    problem(
      409,
      "ZONES_CHANGED",
      "Storage zones changed. Refresh the checklist and review all zone counts.",
    );
  if (entry.locations === undefined) {
    if (spec.zones?.length)
      problem(400, "INCOMPLETE_ZONES", "Count every assigned storage zone.");
    return inputQuantity(entry.value, entry.unit || "BASE", item);
  }
  const expected = spec.zones?.length ? spec.zones : ["unassigned"];
  if (
    !Array.isArray(entry.locations) ||
    entry.locations.length !== expected.length ||
    new Set(entry.locations.map((location) => location.zoneId)).size !==
      expected.length ||
    entry.locations.some((location) => !expected.includes(location.zoneId))
  )
    problem(400, "INCOMPLETE_ZONES");
  const total = entry.locations.reduce(
    (sum, location) =>
      sum + inputQuantity(location.value, location.unit || "BASE", item),
    0n,
  );
  if (total > MAX) problem(400, "QUANTITY_TOO_LARGE");
  return total;
}

export function submitSession(db, actor, id, sessionId, body) {
  return operation(
    db,
    actor,
    id,
    "SESSION_SUBMIT",
    { sessionId, ...body },
    () => {
      const current = session(db, sessionId);
      owns(current, actor);
      version(current.version, body.version, "Checklist");
      if (
        !Array.isArray(body.items) ||
        body.items.length > 500 ||
        !["REQUIRE_ALL", "KEEP_CURRENT"].includes(body.blankPolicy) ||
        typeof body.incomplete !== "boolean"
      )
        problem(400, "INVALID_BATCH");
      const productChanges = body.productChanges ?? [];
      if (!Array.isArray(productChanges) || productChanges.length > 300)
        problem(400, "INVALID_PRODUCT_CHANGES");
      const specs = current.items.map((item) => ({ ...item }));
      const changed = new Set();
      for (const change of productChanges) {
        if (changed.has(change.id)) problem(400, "DUPLICATE_PRODUCT");
        changed.add(change.id);
        const item = product(db, change.id);
        version(item.version, change.version, "Product");
        if (item.archived) problem(409, "PRODUCT_ARCHIVED");
        const active = bool(change.active);
        const assigned = zones(change.zones);
        if (active && !body.items.some((entry) => entry.id === item.id))
          problem(400, "ACTIVATION_REQUIRES_COUNT");
        if (!active && body.items.some((entry) => entry.id === item.id))
          problem(400, "DEACTIVATION_WITH_COUNT");
        db.prepare(
          "UPDATE varka_products SET active=?,zones=?,version=version+1 WHERE id=?",
        ).run(+active, JSON.stringify(assigned), item.id);
        const index = specs.findIndex((spec) => spec.id === item.id);
        if (index >= 0) specs.splice(index, 1);
        if (active) specs.push(snapshot({ ...item, zones: assigned }));
      }
      const seen = new Set();
      const results = [];
      const at = new Date().toISOString();
      for (const entry of body.items) {
        if (seen.has(entry.id)) problem(400, "DUPLICATE_PRODUCT");
        seen.add(entry.id);
        const spec = specs.find((spec) => spec.id === entry.id);
        if (!spec) problem(400, "NOT_IN_SESSION");
        if (spec.checked) problem(409, "ALREADY_SUBMITTED");
        const item = product(db, entry.id);
        if (!item.active || item.archived) problem(409, "PRODUCT_INACTIVE");
        // Catalog edits in this same transaction intentionally increment only metadata.
        const revision = changed.has(item.id)
          ? `${item.version - 1}:${item.revision.split(":")[1]}`
          : item.revision;
        if (entry.revision !== revision)
          problem(
            409,
            "CONFLICT",
            "Stock changed. Refresh and explicitly review this item.",
            {
              productId: item.id,
              current: item.quantity,
              revision: item.revision,
            },
          );
        if (spec.unit !== item.unit || Number(spec.sleeve || 0) !== item.sleeve)
          problem(409, "UNIT_CHANGED");
        const amount = countedQuantity(entry, item, spec);
        const countedAt = entry.countedAt;
        if (
          typeof countedAt !== "string" ||
          !Number.isFinite(Date.parse(countedAt)) ||
          Date.parse(countedAt) > Date.now() + 86400_000 ||
          Date.parse(countedAt) < Date.parse(current.createdAt) - 86400_000
        )
          problem(400, "INVALID_COUNT_TIME");
        results.push(
          appendEvent(db, actor, item, {
            id: `${id}:${item.id}`,
            action: "CHECK",
            amount,
            at,
            countedAt,
            approx: bool(entry.approx),
            low: bool(entry.low),
            sessionId,
            batchId: id,
            locations: entry.locations || [],
            kind: "SESSION_BATCH_ITEM",
          }),
        );
      }
      const missing = specs
        .filter((spec) => !spec.checked && !seen.has(spec.id))
        .map((spec) => spec.id);
      if (
        missing.length &&
        !body.incomplete &&
        body.blankPolicy !== "KEEP_CURRENT"
      )
        problem(
          400,
          "MISSING_COUNTS",
          "Count every item or explicitly choose to keep blank items unchanged.",
        );
      const status = missing.length
        ? body.blankPolicy === "KEEP_CURRENT"
          ? "COMPLETE_WITH_UNCHANGED"
          : "INCOMPLETE"
        : "COMPLETE";
      db.prepare(
        "UPDATE varka_inventory_sessions SET snapshot=?,status=?,missing=?,closed_at=?,version=version+1 WHERE id=?",
      ).run(
        JSON.stringify(specs),
        status,
        JSON.stringify(missing),
        at,
        sessionId,
      );
      const payload = { ...body, sessionId, status, missing, events: results };
      db.prepare(
        "INSERT INTO varka_batches(id,session_id,actor,status,kind,payload,at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        sessionId,
        actor.email,
        status,
        "SESSION",
        JSON.stringify(payload),
        at,
      );
      db.prepare(
        "INSERT INTO varka_session_journal(id,session_id,action,actor,at,payload) VALUES(?,?,?,?,?,?)",
      ).run(
        id,
        sessionId,
        "CLOSE",
        actor.email,
        at,
        JSON.stringify({ status, missing }),
      );
      queueReport(db, actor, id, [...seen]);
      return {
        id,
        sessionId,
        status,
        saved: results.length,
        unchanged: missing.length,
      };
    },
  );
}

export function correctSession(db, actor, id, sessionId, body) {
  return operation(
    db,
    actor,
    id,
    "SESSION_CORRECTION",
    { sessionId, ...body },
    () => {
      session(db, sessionId);
      const parent =
        db
          .prepare(
            "SELECT id FROM varka_revisions WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(sessionId)?.id || null;
      version(parent, body.parentId ?? null, "Correction history");
      const reason = text(body.reason, 500);
      if (
        !["CURRENT", "HISTORY_ONLY"].includes(body.mode) ||
        !Array.isArray(body.changes) ||
        !body.changes.length ||
        body.changes.length > 500
      )
        problem(400, "INVALID_CORRECTION");
      const changes = [];
      const seen = new Set();
      const at = new Date().toISOString();
      for (const change of body.changes) {
        if (seen.has(change.id)) problem(400, "DUPLICATE_EVENT");
        seen.add(change.id);
        const event = db
          .prepare("SELECT * FROM varka_events WHERE id=?")
          .get(change.id);
        if (
          !event ||
          event.actor !== actor.email ||
          event.session_id !== sessionId ||
          event.action !== "CHECK"
        )
          problem(403, "OWN_ENTRIES_ONLY");
        version(hash(JSON.stringify(event)), change.version, "History entry");
        if (typeof change.value !== "string")
          problem(
            400,
            "INVALID_QUANTITY",
            "Send quantities as decimal strings.",
          );
        const amount = quantity(change.value, event.unit);
        const prior = db
          .prepare(
            "SELECT payload FROM varka_revisions WHERE session_id=? ORDER BY rowid",
          )
          .all(sessionId)
          .flatMap((row) => JSON.parse(row.payload))
          .filter((row) => row.id === event.id)
          .at(-1);
        changes.push({
          id: event.id,
          productId: event.product_id,
          previous: prior?.quantity ?? event.quantity,
          quantity: decimal(amount),
          unit: event.unit,
          ru: event.ru,
          en: event.en,
        });
        if (body.mode === "CURRENT") {
          const item = product(db, event.product_id);
          const latest =
            item.lastEvent &&
            db
              .prepare("SELECT * FROM varka_events WHERE id=?")
              .get(item.lastEvent);
          if (
            !item.active ||
            item.archived ||
            item.unit !== event.unit ||
            !(
              latest?.id === event.id ||
              (latest?.corrects_event === event.id &&
                latest?.kind === "SESSION_REVISION")
            )
          )
            problem(
              409,
              "NEWER_ENTRY_EXISTS",
              "A newer movement exists; this correction can only change historical annotations.",
            );
          appendEvent(db, actor, item, {
            id: `${id}:${item.id}`,
            action: "CHECK",
            amount,
            at,
            countedAt: at,
            low: Boolean(event.manual_low),
            sessionId,
            batchId: id,
            correctsEvent: event.id,
            reason,
            kind: "SESSION_REVISION",
          });
        }
      }
      db.prepare(
        "INSERT INTO varka_revisions(id,session_id,actor,mode,reason,parent_id,payload,at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        sessionId,
        actor.email,
        body.mode,
        reason,
        parent,
        JSON.stringify(changes),
        at,
      );
      db.prepare(
        "INSERT INTO varka_batches(id,session_id,actor,status,kind,payload,at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        sessionId,
        actor.email,
        null,
        "SESSION_REVISION",
        JSON.stringify({ ...body, corrections: changes }),
        at,
      );
      return { id, sessionId, mode: body.mode, corrections: changes };
    },
  );
}
