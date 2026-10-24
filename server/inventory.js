export const CATEGORIES = [
  "Coffee",
  "Milk & alternatives",
  "Syrups & tea",
  "Food",
  "Supplies",
  "Other",
];
export const UNITS = ["kg", "g", "L", "ml", "pcs"];

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function string(value, label, max, required = true) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim())
  ) {
    throw new ApiError(
      400,
      `${label} must be ${required ? "1" : "0"}–${max} characters.`,
    );
  }
  return value.trim();
}

function milli(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1_000_000 ||
    Math.abs(value * 1000 - Math.round(value * 1000)) > 0.000001
  ) {
    throw new ApiError(
      400,
      `${label} must be between 0 and 1,000,000, with at most 3 decimal places.`,
    );
  }
  return Math.round(value * 1000);
}

function item(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    quantity: row.quantity_milli / 1000,
    minimum: row.minimum_milli / 1000,
    lowStock: row.quantity_milli <= row.minimum_milli,
    updatedAt: row.updated_at,
  };
}

function movement(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    itemName: row.name,
    unit: row.unit,
    type: row.type,
    delta: row.delta_milli / 1000,
    balance: row.balance_milli / 1000,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function inventory(db) {
  const getItem = (id) =>
    db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  const getMovement = (id) =>
    db
      .prepare(
        "SELECT m.*, i.name, i.unit FROM movements m JOIN items i ON i.id=m.item_id WHERE m.id=?",
      )
      .get(id);
  return {
    list() {
      return db
        .prepare("SELECT * FROM items ORDER BY name COLLATE NOCASE")
        .all()
        .map(item);
    },
    movements() {
      return db
        .prepare(
          "SELECT m.*, i.name, i.unit FROM movements m JOIN items i ON i.id=m.item_id ORDER BY m.id DESC LIMIT 100",
        )
        .all()
        .map(movement);
    },
    create(body) {
      const name = string(body.name, "Name", 100);
      if (!CATEGORIES.includes(body.category))
        throw new ApiError(400, "Choose a valid category.");
      if (!UNITS.includes(body.unit))
        throw new ApiError(400, "Choose a valid unit.");
      const quantity = milli(body.quantity ?? 0, "Opening quantity");
      const minimum = milli(body.minimum ?? 0, "Minimum quantity");
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare(
            "INSERT INTO items(name,category,unit,quantity_milli,minimum_milli) VALUES(?,?,?,?,?)",
          )
          .run(name, body.category, body.unit, quantity, minimum);
        db.prepare(
          "INSERT INTO movements(item_id,type,delta_milli,balance_milli,note) VALUES(?,'opening',?,?,?)",
        ).run(result.lastInsertRowid, quantity, quantity, "Opening stock");
        const created = item(getItem(result.lastInsertRowid));
        db.exec("COMMIT");
        return created;
      } catch (error) {
        db.exec("ROLLBACK");
        if (error.message.includes("UNIQUE constraint failed: items.name"))
          throw new ApiError(409, "An item with this name already exists.");
        throw error;
      }
    },
    move(id, body, key) {
      if (!Number.isSafeInteger(id) || id < 1)
        throw new ApiError(400, "Invalid item ID.");
      if (!["in", "out", "count"].includes(body.type))
        throw new ApiError(
          400,
          "Choose stock in, stock out, or a stock count.",
        );
      const amount = milli(body.quantity, "Quantity");
      if (!amount && body.type !== "count")
        throw new ApiError(400, "Quantity must be greater than zero.");
      const note = string(body.note ?? "", "Note", 300, false);
      if (typeof key !== "string" || !/^[A-Za-z0-9-]{16,100}$/.test(key))
        throw new ApiError(400, "A valid Idempotency-Key header is required.");
      const payload = JSON.stringify({ id, type: body.type, amount, note });
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare("SELECT * FROM movements WHERE request_key=?")
          .get(key);
        if (existing) {
          if (existing.request_payload !== payload)
            throw new ApiError(
              409,
              "This request key was already used for a different change.",
            );
          db.exec("COMMIT");
          return {
            item: item(getItem(id)),
            movement: movement(getMovement(existing.id)),
            replayed: true,
          };
        }
        const current = getItem(id);
        if (!current) throw new ApiError(404, "Item not found.");
        const delta =
          body.type === "count"
            ? amount - current.quantity_milli
            : body.type === "out"
              ? -amount
              : amount;
        const balance = current.quantity_milli + delta;
        if (balance < 0)
          throw new ApiError(
            409,
            "Not enough stock. Refresh inventory or enter a physical stock count.",
          );
        if (balance > 1_000_000_000)
          throw new ApiError(400, "Resulting stock cannot exceed 1,000,000.");
        db.prepare(
          "UPDATE items SET quantity_milli=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        ).run(balance, id);
        const result = db
          .prepare(
            "INSERT INTO movements(item_id,type,delta_milli,balance_milli,note,request_key,request_payload) VALUES(?,?,?,?,?,?,?)",
          )
          .run(id, body.type, delta, balance, note, key, payload);
        const response = {
          item: item(getItem(id)),
          movement: movement(getMovement(result.lastInsertRowid)),
          replayed: false,
        };
        db.exec("COMMIT");
        return response;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
