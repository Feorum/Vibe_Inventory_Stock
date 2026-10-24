import { catalog, product } from "./stock.js";
import {
  operation,
  text,
  quantity,
  decimal,
  zones,
  bool,
  version,
  problem,
  UNITS,
} from "./core.js";

export const DEFAULT_CATEGORIES = [
  "Молоко / Milk",
  "Молочные продукты / Dairy",
  "Кофе / Coffee",
  "Напитки / Drinks",
  "Сиропы / Syrups",
  "Пюре и концентраты / Purees and concentrates",
  "Десерты и еда / Desserts and food",
  "Сахар / Sugar",
  "Посуда / Disposables",
  "Хозяйственные материалы / Supplies",
];
export function categories(db) {
  const existing = db
    .prepare(
      "SELECT DISTINCT category FROM varka_products WHERE archived=0 ORDER BY category",
    )
    .all()
    .map((row) => row.category);
  return existing.length ? existing : DEFAULT_CATEGORIES;
}

export function saveProduct(db, actor, id, body) {
  return operation(db, actor, id, "CATALOG", body, () => {
    const current = body.id ? product(db, body.id) : null;
    if (current) {
      version(current.version, body.version, "Product");
      if (current.archived) problem(409, "PRODUCT_ARCHIVED");
    }
    const action = body.action || "save";
    if (action === "archive") {
      if (!current || current.active) problem(409, "DEACTIVATE_BEFORE_ARCHIVE");
      db.prepare(
        "UPDATE varka_products SET archived=1,version=version+1 WHERE id=?",
      ).run(current.id);
    } else if (action === "active") {
      if (!current) problem(404, "PRODUCT_NOT_FOUND");
      db.prepare(
        "UPDATE varka_products SET active=?,version=version+1 WHERE id=?",
      ).run(+bool(body.active), current.id);
    } else if (action === "save") {
      const d = body.product || {};
      const ru = text(d.ru, 160);
      const en = text(d.en ?? "", 160, false);
      const category = text(d.category, 100);
      const notes = text(d.notes ?? "", 500, false);
      const unit = d.unit;
      const sleeve = d.sleeve ?? 0;
      if (!categories(db).includes(category))
        problem(400, "EXISTING_CATEGORY_REQUIRED");
      if (
        !UNITS.includes(unit) ||
        ![0, 25].includes(sleeve) ||
        (sleeve && unit !== "pcs")
      )
        problem(400, "INVALID_UNIT");
      if ((unit === "pack" || sleeve) && !notes)
        problem(
          400,
          "PACKAGING_NOTE_REQUIRED",
          "Specify the package size or cup/lid size.",
        );
      if (!Number.isInteger(d.hours) || d.hours < 1 || d.hours > 8760)
        problem(400, "INVALID_CHECK_INTERVAL");
      if (d.minimum !== null && typeof d.minimum !== "string")
        problem(
          400,
          "INVALID_QUANTITY",
          "Send minimums as decimal strings or null.",
        );
      const minimum =
        d.minimum === null ? null : decimal(quantity(d.minimum, unit));
      const assigned = zones(d.zones ?? []);
      const duplicate = catalog(db, { archived: true }).find(
        (item) =>
          item.id !== current?.id &&
          item.ru.normalize("NFKC").toLocaleLowerCase("ru") ===
            ru.normalize("NFKC").toLocaleLowerCase("ru"),
      );
      if (duplicate) problem(409, "PRODUCT_NAME_EXISTS");
      if (
        current &&
        (current.unit !== unit || current.sleeve !== sleeve) &&
        (current.quantity !== null ||
          db
            .prepare("SELECT 1 FROM varka_events WHERE product_id=? LIMIT 1")
            .get(current.id))
      )
        problem(409, "UNIT_HAS_HISTORY");
      const active =
        d.active === undefined ? (current?.active ?? true) : bool(d.active);
      let productId = current?.id;
      if (!productId) {
        const next =
          1 +
          Math.max(
            0,
            ...db
              .prepare("SELECT id FROM varka_products")
              .all()
              .map((row) =>
                /^P\d+$/.test(row.id) ? Number(row.id.slice(1)) : 0,
              ),
          );
        productId = `P${String(next).padStart(3, "0")}`;
        db.prepare(
          "INSERT INTO varka_products(id,ru,en,category,unit,sleeve,active,minimum,hours,notes,zones) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          productId,
          ru,
          en,
          category,
          unit,
          sleeve,
          +active,
          minimum,
          d.hours,
          notes,
          JSON.stringify(assigned),
        );
        db.prepare("INSERT INTO varka_stock(product_id) VALUES(?)").run(
          productId,
        );
      } else
        db.prepare(
          "UPDATE varka_products SET ru=?,en=?,category=?,unit=?,sleeve=?,active=?,minimum=?,hours=?,notes=?,zones=?,version=version+1 WHERE id=?",
        ).run(
          ru,
          en,
          category,
          unit,
          sleeve,
          +active,
          minimum,
          d.hours,
          notes,
          JSON.stringify(assigned),
          productId,
        );
      body = { ...body, id: productId };
    } else problem(400, "INVALID_CATALOG_ACTION");
    db.prepare(
      "INSERT INTO varka_audit(operation_id,actor,action,product_id,payload,at) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      actor.email,
      action,
      body.id,
      JSON.stringify(body),
      new Date().toISOString(),
    );
    return { product: product(db, body.id) };
  });
}
