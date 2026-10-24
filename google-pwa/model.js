// Offline records contain inventory/drafts only, never access codes or tokens.
export const accountKey = (endpoint, email) =>
  `varka-google:${endpoint}:${email.toLowerCase()}`;
export function saveRecord(storage, key, value) {
  storage.setItem(key, JSON.stringify(value)); // Deliberately propagate quota errors.
}
export function readRecord(storage, key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}
export function normalizeSnapshot(snapshot) {
  const catalog = new Map((snapshot.catalog || []).map((p) => [p.id, p]));
  return {
    ...snapshot,
    stock: {
      ...snapshot.stock,
      products: snapshot.stock.products.map((p) => ({
        ...p,
        zones: catalog.get(p.id)?.zones || [],
      })),
    },
  };
}
export function quantity(value, unit, sleeve = false) {
  const raw = String(value).trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,8})?$/.test(raw))
    throw Error(
      "Enter a nonnegative quantity with at most eight decimal places.",
    );
  const [whole, decimal = ""] = raw.split(".");
  let scaled = BigInt(whole) * 100000000n + BigInt(decimal.padEnd(8, "0"));
  if (sleeve) scaled *= 25n;
  if (
    scaled > 1000000000n * 100000000n ||
    (unit === "pcs" && scaled % 100000000n)
  )
    throw Error("Quantity is out of range or pieces are not whole.");
  return { value: raw, scaled };
}
export function buildSubmission(
  session,
  drafts,
  { id = crypto.randomUUID(), keepCurrent = false } = {},
) {
  if (!session || session.status !== "OPEN")
    throw Error("Start an inventory session online first.");
  const items = [];
  for (const spec of session.items.filter((item) => !item.checked)) {
    const draft = drafts[spec.id];
    if (!draft) continue;
    const expected = spec.zones?.length ? spec.zones : ["unassigned"];
    const entered = expected.filter(
      (zone) => String(draft.locations?.[zone]?.value ?? "").trim() !== "",
    );
    if (!entered.length) continue;
    if (entered.length !== expected.length)
      throw Error(`Fill every storage zone for ${spec.ru || spec.id}.`);
    let total = 0n;
    const locations = expected.map((zoneId) => {
      const input = draft.locations[zoneId];
      if (
        !["BASE", "SLEEVE_25"].includes(input.unit) ||
        (input.unit === "SLEEVE_25" && !spec.sleeve)
      )
        throw Error("Unsupported input unit.");
      const parsed = quantity(
        input.value,
        spec.unit,
        input.unit === "SLEEVE_25",
      );
      total += parsed.scaled;
      return { zoneId, value: parsed.value, unit: input.unit };
    });
    if (total > 1000000000n * 100000000n)
      throw Error("Combined zone quantity exceeds the limit.");
    items.push({
      id: spec.id,
      revision: draft.revision,
      value: "0",
      unit: "BASE",
      approx: Boolean(draft.approx),
      low: Boolean(draft.low),
      countedAt: draft.countedAt,
      locations,
    });
  }
  if (!items.length)
    throw Error("Enter at least one count. Blank is not zero.");
  const missing =
    session.items.filter((item) => !item.checked).length - items.length;
  if (missing && !keepCurrent)
    throw Error("Count every item or explicitly keep blank items unchanged.");
  return {
    id,
    sessionId: session.id,
    items,
    incomplete: false,
    ...(keepCurrent ? { blankPolicy: "KEEP_CURRENT" } : {}),
  };
}

export function changedDrafts(snapshot, drafts) {
  const products = new Map(
    (snapshot?.stock?.products || []).map((p) => [p.id, p]),
  );
  const specs = new Map((snapshot?.session?.items || []).map((p) => [p.id, p]));
  return Object.keys(drafts).filter((id) => {
    const current = products.get(id),
      spec = specs.get(id);
    if (!current || !spec || current.revision !== drafts[id].revision)
      return true;
    return (
      JSON.stringify([...(spec.zones || [])].sort()) !==
      JSON.stringify([...(drafts[id].zones || [])].sort())
    );
  });
}
