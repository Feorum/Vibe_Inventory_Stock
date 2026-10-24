import readXlsx from "read-excel-file/node";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { hash, quantity, decimal, transaction, ZONES, UNITS } from "./core.js";

const blank = (value) => value === null || value === undefined || value === "";
const value = (input) => (blank(input) ? "" : input);
const ensure = (condition, message) => {
  if (!condition) throw new Error(`Migration refused: ${message}`);
};
const cell = (row, index) => value(row[index]);

// Excel date cells are wall-clock values. The original application uses Minsk.
export function legacyDate(input) {
  if (blank(input)) return null;
  if (input instanceof Date) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Minsk",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(input)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    return new Date(
      input.getTime() -
        (represented - Math.floor(input.getTime() / 1000) * 1000),
    ).toISOString();
  }
  const date = new Date(input);
  ensure(Number.isFinite(date.getTime()), "Invalid timestamp.");
  return date.toISOString();
}

export function decodeEnvelope(row) {
  const json = cell(row, 10);
  ensure(typeof json === "string", "Batch JSON is missing.");
  const encoding =
    hash(json) === row[18]
      ? "UTF-8"
      : hash(json.replace(/[^\x00-\x7f]/gu, "?")) === row[18]
        ? "legacy-ascii-replacement"
        : null;
  ensure(encoding, `Envelope checksum mismatch at ${row[0]}.`);
  let batch;
  try {
    batch = JSON.parse(json);
  } catch {
    ensure(false, `Invalid envelope JSON at ${row[0]}.`);
  }
  ensure(
    [5, 8, 9].includes(batch.version) &&
      row[2] === "SESSION_BATCH" &&
      row[19] === "V5_SESSION" &&
      batch.operationId === row[0] &&
      batch.sessionId === row[11] &&
      batch.requestHash === row[17] &&
      Array.isArray(batch.events) &&
      batch.events.length === Number(row[6]),
    `Invalid envelope identity at ${row[0]}.`,
  );
  const events = batch.events.map((original) => {
    const event = Array.from({ length: 22 }, (_, index) =>
      value(original[index]),
    );
    if (batch.compactDefaults)
      for (const [index, fallback] of [
        [0, `${batch.operationId}:${event[3]}`],
        [1, batch.submittedAt],
        [7, batch.by],
        [11, batch.sessionId],
        [18, batch.requestHash],
        [19, "SESSION_BATCH_ITEM"],
        [21, batch.authorName || "Anonymous"],
      ])
        if (blank(event[index])) event[index] = fallback;
    return event;
  });
  const locations = (batch.locations || []).map((location) =>
    Array.isArray(location)
      ? {
          productId: location[0],
          locations: location[1].map(([zoneId, amount, unit]) => ({
            zoneId,
            value: String(amount),
            unit: unit === 25 ? "SLEEVE_25" : "BASE",
          })),
        }
      : location,
  );
  return {
    ...batch,
    events,
    locations,
    encoding,
    originalJSON: json,
    storedHash: row[18],
  };
}

export function inspectSheets(
  sheets,
  { fingerprint = "", filename = "workbook.xlsx" } = {},
) {
  const byName = new Map(sheets.map((sheet) => [sheet.sheet, sheet.data]));
  for (const name of ["Products", "Events", "CafeStock", "InventorySessions"])
    ensure(byName.has(name), `Missing ${name} sheet.`);
  const rows = (name) =>
    (byName.get(name) || []).slice(1).filter((row) => !blank(row[0]));
  const materializedRows = rows("Products").map((row) =>
    Array.from({ length: 15 }, (_, index) => value(row[index])),
  );
  const decoded = new Map();
  for (const row of rows("Events"))
    if (String(row[0]).startsWith("V5BATCH:")) {
      const batch = decodeEnvelope(row);
      decoded.set(row[0], batch);
      for (const change of batch.productChanges || []) {
        const target = materializedRows.find(
          (product) => product[0] === change.id,
        );
        ensure(
          target,
          `Batch references unknown catalog product ${change.id}.`,
        );
        const serialized = JSON.stringify(target);
        if (
          hash(serialized) === change.before ||
          hash(serialized.replace(/[^\x00-\x7f]/gu, "?")) === change.before
        ) {
          ensure(
            typeof change.active === "boolean" && Array.isArray(change.zones),
            "Invalid batched catalog change.",
          );
          target[6] = change.active ? "YES" : "NO";
          target[14] = JSON.stringify(change.zones);
          target[12] = batch.operationId;
        }
      }
    }
  const products = materializedRows.map((row) => {
    ensure(/^P\d+$/.test(String(row[0])), `Invalid product ID ${row[0]}.`);
    const unit = String(cell(row, 4));
    // Disabled legacy setup rows may not yet have a configured unit.
    ensure(
      UNITS.includes(unit) || (row[6] !== "YES" && !unit),
      `Unsupported unit for ${row[0]}.`,
    );
    let locations;
    try {
      locations = blank(row[14]) ? [] : JSON.parse(row[14]);
    } catch {
      ensure(false, `Invalid zones for ${row[0]}.`);
    }
    ensure(
      Array.isArray(locations) &&
        new Set(locations).size === locations.length &&
        locations.every((id) => ZONES.some((zone) => zone.id === id)),
      `Invalid zones for ${row[0]}.`,
    );
    const hours = Number(row[8] || 24);
    ensure(
      Number.isInteger(hours) && hours >= 1 && hours <= 8760,
      `Invalid check interval for ${row[0]}.`,
    );
    return {
      id: String(row[0]),
      ru: String(row[1]),
      en: String(cell(row, 2)),
      category: String(row[3]),
      unit,
      sleeve: Number(row[5] || 0),
      active: row[6] === "YES",
      archived: row[13] === "YES",
      minimum: blank(row[7]) ? null : decimal(quantity(row[7], unit)),
      hours,
      notes: String(cell(row, 9)),
      zones: locations,
      legacy: row,
    };
  });
  ensure(
    new Set(products.map((product) => product.id)).size === products.length,
    "Duplicate product IDs.",
  );
  const productMap = new Map(products.map((product) => [product.id, product]));
  const batches = [];
  const events = [];
  const eventIds = new Set();
  const batchIds = new Set();
  for (const row of rows("Events")) {
    let expanded = [row];
    let batch;
    if (String(row[0]).startsWith("V5BATCH:")) {
      ensure(!batchIds.has(row[0]), `Duplicate batch ${row[0]}.`);
      batchIds.add(row[0]);
      batch = decoded.get(row[0]);
      batches.push(batch);
      expanded = batch.events;
    }
    for (const entry of expanded) {
      ensure(!eventIds.has(entry[0]), `Duplicate event ${entry[0]}.`);
      eventIds.add(entry[0]);
      const product = productMap.get(entry[3]);
      ensure(product, `Unknown event product ${entry[3]}.`);
      ensure(
        ["CHECK", "RECEIVE", "WASTE", "TRANSFER"].includes(entry[2]),
        `Unsupported event action ${entry[2]}.`,
      );
      const unit = String(entry[13] || product.unit);
      const amount = decimal(quantity(entry[6], unit));
      events.push({
        id: String(entry[0]),
        productId: product.id,
        action: entry[2],
        source: String(cell(entry, 4)),
        quantity: amount,
        unit,
        ru: String(entry[14] || product.ru),
        en: String(entry[15] || product.en),
        actor: String(cell(entry, 7)).toLowerCase(),
        authorName: String(cell(entry, 21)),
        at: legacyDate(entry[1]),
        countedAt: legacyDate(
          entry[20] || (entry[2] === "CHECK" ? entry[1] : null),
        ),
        accuracy: String(cell(entry, 8)),
        manualLow: entry[9] === "YES",
        note: String(cell(entry, 10)),
        sessionId: String(cell(entry, 11)) || null,
        correctsEvent: String(cell(entry, 16)) || null,
        reason: String(cell(entry, 17)),
        kind: String(cell(entry, 19)),
        batchId: batch?.operationId || null,
        locations:
          batch?.locations.find((location) => location.productId === product.id)
            ?.locations || [],
        legacy: entry,
      });
    }
  }
  const stock = new Map(
    products.map((product) => [
      product.id,
      {
        quantity: null,
        checkedAt: null,
        checkedBy: "",
        accuracy: "",
        manualLow: false,
        lastAt: null,
        lastEvent: null,
      },
    ]),
  );
  for (const event of events) {
    const current = stock.get(event.productId);
    event.before = event.source === "CAFE" ? current.quantity : null;
    if (event.source !== "CAFE") {
      event.after = null;
      continue;
    }
    const amount = quantity(event.quantity, event.unit);
    if (event.action === "CHECK") {
      current.quantity = decimal(amount);
      current.checkedAt = event.at;
      current.checkedBy = event.actor;
      current.accuracy = event.accuracy;
      current.manualLow = event.manualLow;
    } else if (
      ["RECEIVE", "WASTE"].includes(event.action) &&
      current.quantity !== null
    ) {
      const balance =
        quantity(current.quantity) +
        (event.action === "RECEIVE" ? amount : -amount);
      ensure(balance >= 0n, `Negative stock at ${event.id}.`);
      current.quantity = decimal(balance);
    } else {
      event.after = current.quantity;
      continue;
    }
    if (event.accuracy === "ESTIMATED") current.accuracy = "ESTIMATED";
    if (event.manualLow) current.manualLow = true;
    current.lastAt = event.at;
    current.lastEvent = event.id;
    event.after = current.quantity;
  }
  const cafes = rows("CafeStock");
  ensure(
    cafes.length === products.length &&
      new Set(cafes.map((row) => row[0])).size === products.length,
    "CafeStock/product coverage differs.",
  );
  for (const row of cafes) {
    const current = stock.get(row[0]);
    ensure(current, `Unknown CafeStock product ${row[0]}.`);
    const expected = blank(row[3])
      ? null
      : decimal(quantity(row[3], productMap.get(row[0]).unit));
    ensure(
      current.quantity === expected,
      `Balance mismatch for ${row[0]}: expected ${expected}, replayed ${current.quantity}.`,
    );
    ensure(
      current.manualLow === (row[9] === "YES"),
      `Manual-low mismatch for ${row[0]}.`,
    );
    ensure(
      current.accuracy === String(cell(row, 7)),
      `Accuracy mismatch for ${row[0]}.`,
    );
    ensure(
      (!row[5] && !current.checkedAt) ||
        Math.abs(
          Date.parse(legacyDate(row[5])) - Date.parse(current.checkedAt),
        ) <= 5,
      `Physical-check timestamp mismatch for ${row[0]}.`,
    );
  }
  const sessions = new Map();
  const journal = rows("InventorySessions").map((row) => {
    let payload;
    try {
      payload = JSON.parse(row[6] || "{}");
    } catch {
      ensure(false, `Invalid session journal ${row[0]}.`);
    }
    const record = {
      id: String(row[0]),
      at: legacyDate(row[1]),
      actor: String(row[2]).toLowerCase(),
      action: row[3],
      sessionId: row[4],
      payload,
    };
    if (record.action === "START") {
      ensure(
        !sessions.has(record.sessionId) && Array.isArray(payload.products),
        "Invalid/duplicate session start.",
      );
      sessions.set(record.sessionId, {
        id: record.sessionId,
        owner: record.actor,
        createdAt: record.at,
        status: "OPEN",
        snapshot: structuredClone(payload.products),
        missing: [],
        closedAt: null,
      });
    } else {
      const session = sessions.get(record.sessionId);
      ensure(
        session,
        `Journal references missing session ${record.sessionId}.`,
      );
      if (record.action === "EXPAND") {
        for (const product of payload.products)
          if (!session.snapshot.some((item) => item.id === product.id))
            session.snapshot.push(product);
      } else if (record.action === "CLOSE") {
        session.status = payload.status;
        session.closedAt = record.at;
      }
    }
    return record;
  });
  for (const batch of batches) {
    const session = sessions.get(batch.sessionId);
    ensure(session, `Batch references missing session ${batch.sessionId}.`);
    if (batch.kind !== "SESSION_REVISION") {
      for (const change of batch.snapshotChanges || []) {
        session.snapshot = session.snapshot.filter(
          (product) => product.id !== change.id,
        );
        if (change.active) session.snapshot.push(change.product);
      }
      session.status = batch.status;
      session.closedAt = batch.submittedAt;
      session.missing = batch.missing || [];
    }
  }
  for (const event of events)
    ensure(
      !event.sessionId || sessions.has(event.sessionId),
      `Event references missing session ${event.sessionId}.`,
    );
  const report = {
    fingerprint,
    filename,
    products: products.length,
    enabled: products.filter((product) => product.active).length,
    archived: products.filter((product) => product.archived).length,
    rawEvents: rows("Events").length,
    verifiedBatches: batches.length,
    expandedEvents: events.length,
    cafeEvents: events.filter((event) => event.source === "CAFE").length,
    reconciledBalances: cafes.length,
    unknownBalances: [...stock.values()].filter(
      (item) => item.quantity === null,
    ).length,
    sessions: sessions.size,
    cards: rows("YellowCards").length,
    reminders: rows("Reminders").length,
    categories: new Set(products.map((product) => product.category)).size,
    legacyDigestBatches: batches.filter((batch) => batch.encoding !== "UTF-8")
      .length,
    status: "VERIFIED",
    notificationsQueued: 0,
  };
  return {
    sheets,
    rows,
    products,
    events,
    batches,
    stock,
    sessions: [...sessions.values()],
    journal,
    report,
  };
}

export async function inspectWorkbook(filename) {
  const bytes = await readFile(filename);
  const sheets = await readXlsx(bytes, { trim: false });
  return inspectSheets(sheets, {
    fingerprint: hash(bytes),
    filename: basename(filename),
  });
}

export function importWorkbook(db, plan) {
  return transaction(db, () => {
    const previous = db
      .prepare("SELECT report FROM varka_migration_runs WHERE fingerprint=?")
      .get(plan.report.fingerprint);
    if (previous) return { ...JSON.parse(previous.report), replayed: true };
    ensure(
      db.prepare("SELECT COUNT(*) AS n FROM varka_products").get().n === 0 &&
        db.prepare("SELECT COUNT(*) AS n FROM varka_events").get().n === 0,
      "Destination already contains VARKA inventory. Use a new database.",
    );
    for (const product of plan.products) {
      db.prepare(
        "INSERT INTO varka_products(id,ru,en,category,unit,sleeve,active,archived,minimum,hours,notes,zones) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        product.id,
        product.ru,
        product.en,
        product.category,
        product.unit,
        product.sleeve,
        +product.active,
        +product.archived,
        product.minimum,
        product.hours,
        product.notes,
        JSON.stringify(product.zones),
      );
      const stock = plan.stock.get(product.id);
      db.prepare(
        "INSERT INTO varka_stock(product_id,quantity,checked_at,checked_by,accuracy,manual_low,last_at,last_event) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        product.id,
        stock.quantity,
        stock.checkedAt,
        stock.checkedBy,
        stock.accuracy,
        +stock.manualLow,
        stock.lastAt,
        stock.lastEvent,
      );
    }
    for (const profile of plan.rows("UserProfiles"))
      db.prepare(
        "INSERT INTO varka_users(email,name) VALUES(?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name",
      ).run(String(profile[0]).toLowerCase(), String(profile[1] || ""));
    for (const session of plan.sessions)
      db.prepare(
        "INSERT INTO varka_inventory_sessions(id,owner,created_at,status,snapshot,missing,closed_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        session.id,
        session.owner,
        session.createdAt,
        session.status,
        JSON.stringify(
          session.snapshot.map((spec) => ({
            ...spec,
            sleeve: spec.sleeve === true ? 25 : Number(spec.sleeve || 0),
          })),
        ),
        JSON.stringify(session.missing),
        session.closedAt,
      );
    for (const record of plan.journal)
      db.prepare(
        "INSERT INTO varka_session_journal(id,session_id,action,actor,at,payload) VALUES(?,?,?,?,?,?)",
      ).run(
        record.id,
        record.sessionId,
        record.action,
        record.actor,
        record.at,
        JSON.stringify(record.payload),
      );
    for (const event of plan.events)
      db.prepare(
        `INSERT INTO varka_events(id,product_id,action,source,quantity,before_quantity,after_quantity,unit,ru,en,actor,author_name,recorded_at,counted_at,accuracy,manual_low,note,session_id,corrects_event,reason,kind,batch_id,locations,legacy_row) VALUES(${Array(24).fill("?").join(",")})`,
      ).run(
        event.id,
        event.productId,
        event.action,
        event.source,
        event.quantity,
        event.before,
        event.after,
        event.unit,
        event.ru,
        event.en,
        event.actor,
        event.authorName,
        event.at,
        event.countedAt,
        event.accuracy,
        +event.manualLow,
        event.note,
        event.sessionId,
        event.correctsEvent,
        event.reason,
        event.kind,
        event.batchId,
        JSON.stringify(event.locations),
        JSON.stringify(event.legacy),
      );
    for (const batch of plan.batches) {
      db.prepare(
        "INSERT INTO varka_batches(id,session_id,actor,status,kind,payload,legacy_hash,hash_encoding,at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        batch.operationId,
        batch.sessionId,
        batch.by,
        batch.status || null,
        batch.kind || "SESSION",
        batch.originalJSON,
        batch.storedHash,
        batch.encoding,
        batch.submittedAt,
      );
      if (batch.kind === "SESSION_REVISION")
        db.prepare(
          "INSERT INTO varka_revisions(id,session_id,actor,mode,reason,parent_id,payload,at) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          batch.operationId,
          batch.sessionId,
          batch.by,
          batch.mode,
          batch.reason,
          batch.parentRevision || null,
          JSON.stringify(batch.corrections),
          batch.submittedAt,
        );
    }
    for (const row of plan.rows("YellowCards"))
      db.prepare(
        "INSERT INTO varka_cards(id,name,size,category,note,active,author,author_name,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        String(row[0]),
        String(row[1]),
        String(cell(row, 2)),
        String(cell(row, 3)),
        String(cell(row, 4)),
        +(row[8] !== "NO"),
        String(cell(row, 7)),
        String(cell(row, 9)),
        legacyDate(row[6]) || new Date().toISOString(),
      );
    for (const row of plan.rows("Reminders"))
      db.prepare(
        "INSERT INTO varka_reminders(id,text,done,author,author_name,editor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        String(row[0]),
        String(row[1]),
        +(row[2] === "DONE"),
        String(cell(row, 5)),
        String(cell(row, 7)),
        String(cell(row, 6)),
        legacyDate(row[3]) || new Date().toISOString(),
        legacyDate(row[4]) || new Date().toISOString(),
      );
    const settings = plan.rows("CafeNotificationSettings")[0];
    // Preserve configuration but deliberately queue no historical deliveries.
    if (settings)
      db.prepare(
        "UPDATE varka_notification_settings SET enabled=?,mode=? WHERE id=1",
      ).run(+(settings[1] === "YES"), settings[2] === "ALL" ? "ALL" : "LOW");
    for (const sheet of plan.sheets)
      sheet.data.forEach((row, index) =>
        db
          .prepare(
            "INSERT INTO varka_legacy_rows(sheet,row_number,data) VALUES(?,?,?)",
          )
          .run(sheet.sheet, index + 1, JSON.stringify(row)),
      );
    db.prepare(
      "INSERT INTO varka_migration_runs(fingerprint,filename,report,imported_at) VALUES(?,?,?,?)",
    ).run(
      plan.report.fingerprint,
      plan.report.filename,
      JSON.stringify(plan.report),
      new Date().toISOString(),
    );
    return { ...plan.report, replayed: false };
  });
}
