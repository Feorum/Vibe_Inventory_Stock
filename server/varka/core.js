import { createHash } from "node:crypto";
import { ApiError } from "../inventory.js";

export const SCALE = 100_000_000n;
export const MAX = 1_000_000_000n * SCALE;
export const UNITS = ["l", "kg", "pcs", "pack", "roll"];
export const ZONES = [
  { id: "fridge", ru: "Холодильник", en: "Refrigerator" },
  { id: "freezer", ru: "Морозильник", en: "Freezer" },
  { id: "wardrobe", ru: "Шкаф", en: "Wardrobe" },
  { id: "cabinet", ru: "Тумба", en: "Cabinet" },
  { id: "shelf", ru: "Полка", en: "Shelf" },
  {
    id: "pickup",
    ru: "Шкафы под стойкой выдачи",
    en: "Cabinets under the pickup counter",
  },
];
export function problem(status, code, message = code, details = {}) {
  const error = new ApiError(status, message);
  error.code = code;
  error.details = details;
  throw error;
}
export function text(value, max = 160, required = true) {
  if (
    typeof value !== "string" ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) ||
    value.trim().length > max ||
    (required && !value.trim())
  )
    problem(
      400,
      "INVALID_TEXT",
      `Enter ${required ? "1" : "0"}–${max} characters.`,
    );
  return value.trim();
}
export function bool(value) {
  if (typeof value !== "boolean") problem(400, "INVALID_FLAG");
  return value;
}
export function quantity(value, unit) {
  // Scientific notation can occur in numeric XLSX values, never in user strings.
  if (typeof value === "number" && Number.isFinite(value))
    value = value.toLocaleString("en-US", {
      useGrouping: false,
      maximumFractionDigits: 20,
    });
  if (typeof value !== "string" || value.length > 40)
    problem(400, "INVALID_QUANTITY", "Enter a nonnegative decimal quantity.");
  const normalized = value.trim().replace(",", ".");
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(normalized);
  if (!match)
    problem(
      400,
      "INVALID_QUANTITY",
      "Use a nonnegative quantity with at most eight decimal places.",
    );
  const atoms =
    BigInt(match[1]) * SCALE + BigInt((match[2] || "").padEnd(8, "0"));
  if (atoms > MAX || (unit === "pcs" && atoms % SCALE !== 0n))
    problem(
      400,
      "INVALID_QUANTITY",
      unit === "pcs"
        ? "Pieces must be whole numbers."
        : "Quantity cannot exceed 1,000,000,000.",
    );
  return atoms;
}
export function decimal(atoms) {
  if (atoms === null || atoms === undefined) return null;
  const sign = atoms < 0n ? "-" : "";
  atoms = atoms < 0n ? -atoms : atoms;
  const fraction = String(atoms % SCALE)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return `${sign}${atoms / SCALE}${fraction ? `.${fraction}` : ""}`;
}
export function inputQuantity(value, inputUnit, product) {
  if (typeof value !== "string")
    problem(
      400,
      "INVALID_QUANTITY",
      "Send quantities as decimal strings, not JSON numbers.",
    );
  if (!["BASE", "SLEEVE_25"].includes(inputUnit))
    problem(400, "INVALID_INPUT_UNIT");
  let atoms = quantity(
    value,
    inputUnit === "SLEEVE_25" ? undefined : product.unit,
  );
  if (inputUnit === "SLEEVE_25") {
    if (product.unit !== "pcs" || product.sleeve !== 25)
      problem(409, "UNIT_CHANGED");
    atoms *= 25n;
    if (atoms % SCALE !== 0n || atoms > MAX)
      problem(400, "WHOLE_PIECES_REQUIRED");
  }
  return atoms;
}
export function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export function operation(db, actor, id, kind, body, callback) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(id))
    problem(
      400,
      "INVALID_OPERATION_ID",
      "A UUID Idempotency-Key header is required.",
    );
  const digest = hash(canonical(body));
  return transaction(db, () => {
    const previous = db
      .prepare("SELECT * FROM varka_operations WHERE id=?")
      .get(id);
    if (previous) {
      if (
        previous.actor !== actor.email ||
        previous.request_hash !== digest ||
        previous.kind !== kind
      )
        problem(409, "REQUEST_ID_REUSED");
      return { ...JSON.parse(previous.response), replayed: true };
    }
    const result = callback();
    db.prepare(
      "INSERT INTO varka_operations(id,actor,kind,request_hash,response,at) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      actor.email,
      kind,
      digest,
      JSON.stringify(result),
      new Date().toISOString(),
    );
    return { ...result, replayed: false };
  });
}
export function version(actual, expected, label = "Record") {
  if (actual !== expected)
    problem(
      409,
      "CONFLICT",
      `${label} changed. Refresh and review your entry.`,
    );
}
export function zones(value) {
  if (
    !Array.isArray(value) ||
    value.length > ZONES.length ||
    new Set(value).size !== value.length ||
    value.some((id) => !ZONES.some((zone) => zone.id === id))
  )
    problem(400, "INVALID_ZONES");
  return [...value].sort();
}
