import { randomUUID } from "node:crypto";
import {
  decimal,
  quantity,
  inputQuantity,
  bool,
  text,
  problem,
  operation,
  MAX,
} from "./core.js";

export function catalog(db, { archived = false } = {}) {
  return db
    .prepare(
      `SELECT p.*,s.quantity,s.checked_at,s.checked_by,s.accuracy,s.manual_low,s.last_at,s.last_event,s.version AS stock_version FROM varka_products p JOIN varka_stock s ON s.product_id=p.id ${archived ? "" : "WHERE p.archived=0"} ORDER BY p.ru`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      ru: row.ru,
      en: row.en,
      category: row.category,
      unit: row.unit,
      sleeve: row.sleeve,
      active: Boolean(row.active),
      archived: Boolean(row.archived),
      minimum: row.minimum,
      hours: row.hours,
      notes: row.notes,
      zones: JSON.parse(row.zones),
      version: row.version,
      revision: `${row.version}:${row.stock_version}`,
      quantity: row.quantity,
      checkedAt: row.checked_at,
      checkedBy: row.checked_by,
      accuracy: row.accuracy,
      manualLow: Boolean(row.manual_low),
      lastAt: row.last_at,
      lastEvent: row.last_event,
      low:
        row.quantity !== null &&
        (Boolean(row.manual_low) ||
          quantity(row.quantity) === 0n ||
          (row.minimum !== null &&
            quantity(row.quantity) <= quantity(row.minimum))),
      stale:
        !row.checked_at ||
        Date.now() - new Date(row.checked_at).getTime() > row.hours * 3600_000,
    }));
}
export function product(db, id) {
  const item = catalog(db, { archived: true }).find((item) => item.id === id);
  if (!item) problem(404, "PRODUCT_NOT_FOUND");
  return item;
}
export function appendEvent(
  db,
  actor,
  item,
  {
    action,
    amount,
    id = randomUUID(),
    at = new Date().toISOString(),
    countedAt = null,
    approx = false,
    low = false,
    note = "",
    sessionId = null,
    batchId = null,
    locations = [],
    correctsEvent = null,
    reason = "",
    kind = "",
  },
) {
  const before = item.quantity;
  if (action !== "CHECK" && before === null)
    problem(
      409,
      "OPENING_COUNT_REQUIRED",
      "Count this product before recording a delivery or waste.",
    );
  const after =
    action === "CHECK"
      ? amount
      : quantity(before) + (action === "RECEIVE" ? amount : -amount);
  if (after < 0n)
    problem(
      409,
      "INSUFFICIENT_STOCK",
      "Insufficient stock. Recount before retrying.",
    );
  if (after > MAX) problem(400, "QUANTITY_TOO_LARGE");
  const accuracy =
    approx || (action !== "CHECK" && item.accuracy === "ESTIMATED")
      ? "ESTIMATED"
      : "EXACT";
  const manualLow = action === "CHECK" ? low : low || item.manualLow;
  db.prepare(
    `INSERT INTO varka_events(id,product_id,action,quantity,before_quantity,after_quantity,unit,ru,en,actor,author_name,recorded_at,counted_at,accuracy,manual_low,note,session_id,corrects_event,reason,kind,batch_id,locations) VALUES(${Array(22).fill("?").join(",")})`,
  ).run(
    id,
    item.id,
    action,
    decimal(amount),
    before,
    decimal(after),
    item.unit,
    item.ru,
    item.en,
    actor.email,
    actor.name || "",
    at,
    countedAt,
    accuracy,
    +manualLow,
    note,
    sessionId,
    correctsEvent,
    reason,
    kind,
    batchId,
    JSON.stringify(locations),
  );
  db.prepare(
    "UPDATE varka_stock SET quantity=?,checked_at=?,checked_by=?,accuracy=?,manual_low=?,last_at=?,last_event=?,version=version+1 WHERE product_id=?",
  ).run(
    decimal(after),
    action === "CHECK" ? at : item.checkedAt,
    action === "CHECK" ? actor.email : item.checkedBy,
    accuracy,
    +manualLow,
    at,
    id,
    item.id,
  );
  return {
    id,
    productId: item.id,
    before,
    after: decimal(after),
    quantity: decimal(amount),
  };
}

export function queueReport(db, actor, operationId, countedIds) {
  const settings = db
    .prepare("SELECT * FROM varka_notification_settings WHERE id=1")
    .get();
  if (!settings.enabled) return;
  const items = catalog(db).filter(
    (item) => item.active && (settings.mode === "ALL" || item.low),
  );
  if (!items.length) return;
  const lines = [
    `VARKA · ${actor.name || actor.email}`,
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Minsk",
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date()),
    ...items.map(
      (item) =>
        `${item.ru} — ${item.quantity === null ? "остаток неизвестен" : `${item.quantity} ${item.unit}`}${item.low ? " · мало" : ""}${countedIds.includes(item.id) ? "" : " · без пересчёта"}`,
    ),
  ];
  // Telegram text limit is 4096 UTF-16 units. Preserve complete lines when possible.
  const chunks = [];
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3500) {
      if (chunk) chunks.push(chunk);
      chunk = "";
    }
    if (line.length > 3500) {
      for (let i = 0; i < line.length; i += 3500)
        chunks.push(line.slice(i, i + 3500));
    } else chunk += `${chunk ? "\n" : ""}${line}`;
  }
  if (chunk) chunks.push(chunk);
  const now = new Date().toISOString();
  chunks.forEach((text, index) =>
    db
      .prepare(
        "INSERT INTO varka_outbox(id,operation_id,text,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(`${operationId}:${index}`, operationId, text, now, now),
  );
}

export function movements(db, actor, id, body) {
  return operation(db, actor, id, "MOVEMENTS", body, () => {
    if (
      !["RECEIVE", "WASTE"].includes(body.action) ||
      !Array.isArray(body.items) ||
      !body.items.length ||
      body.items.length > 500
    )
      problem(400, "INVALID_MOVEMENT");
    const note = text(body.note ?? "", 500, body.action === "WASTE");
    const seen = new Set();
    const results = [];
    for (const entry of body.items) {
      if (seen.has(entry.id)) problem(400, "DUPLICATE_PRODUCT");
      seen.add(entry.id);
      const item = product(db, entry.id);
      if (!item.active || item.archived) problem(409, "PRODUCT_INACTIVE");
      if (entry.revision !== item.revision)
        problem(
          409,
          "CONFLICT",
          "Stock changed. Refresh and review the quantity.",
          {
            productId: item.id,
            current: item.quantity,
            revision: item.revision,
          },
        );
      const amount = inputQuantity(entry.value, entry.unit || "BASE", item);
      if (!amount) problem(400, "POSITIVE_QUANTITY_REQUIRED");
      results.push(
        appendEvent(db, actor, item, {
          action: body.action,
          amount,
          approx: bool(entry.approx ?? false),
          low: bool(entry.low ?? false),
          note,
          batchId: id,
        }),
      );
    }
    queueReport(db, actor, id, []);
    return { saved: results.length, events: results };
  });
}

export function history(db, { before, limit = 100, sessionId } = {}) {
  limit = Math.min(500, Math.max(1, Number(limit) || 100));
  const conditions = [];
  const args = [];
  if (before) {
    conditions.push("seq < ?");
    args.push(Number(before));
  }
  if (sessionId) {
    conditions.push("session_id=?");
    args.push(sessionId);
  }
  const entries = db
    .prepare(
      `SELECT * FROM varka_events ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`,
    )
    .all(...args, limit)
    .map((row) => ({
      seq: row.seq,
      id: row.id,
      productId: row.product_id,
      action: row.action,
      source: row.source,
      quantity: row.quantity,
      before: row.before_quantity,
      after: row.after_quantity,
      unit: row.unit,
      ru: row.ru,
      en: row.en,
      actor: row.actor,
      authorName: row.author_name,
      at: row.recorded_at,
      countedAt: row.counted_at,
      accuracy: row.accuracy,
      manualLow: Boolean(row.manual_low),
      note: row.note,
      sessionId: row.session_id,
      correctsEvent: row.corrects_event,
      reason: row.reason,
      kind: row.kind,
      locations: JSON.parse(row.locations),
    }));
  const sessionIds = sessionId
    ? [sessionId]
    : [...new Set(entries.map((entry) => entry.sessionId).filter(Boolean))];
  const revisions = sessionIds.length
    ? db
        .prepare(
          `SELECT id,session_id AS sessionId,actor,mode,reason,parent_id AS parentId,payload,at FROM varka_revisions WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY rowid DESC`,
        )
        .all(...sessionIds)
        .map((row) => ({
          ...row,
          corrections: JSON.parse(row.payload),
          payload: undefined,
        }))
    : [];
  return {
    entries,
    next: entries.length === limit ? entries.at(-1).seq : null,
    revisions,
  };
}
