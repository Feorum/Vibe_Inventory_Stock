import { GoogleTransport, deploymentUrl } from "./transport.js";
import { createFeatures } from "./features.js";
import { focusView } from "./ui.js";
import {
  accountKey,
  readRecord,
  saveRecord,
  buildSubmission,
  changedDrafts,
  normalizeSnapshot,
  effectiveSession,
  quantity,
  recoverCountDraft,
} from "./model.js";
const $ = (selector) => document.querySelector(selector);
const initial = () => ({
  snapshot: null,
  drafts: {},
  session: null,
  pending: null,
  startPending: null,
  keepCurrent: false,
  lastSync: null,
  featurePending: null,
  productChanges: [],
});
let config = readRecord(localStorage, "varka-google:configuration") || {};
let record = initial();
let transport,
  token,
  authenticated = false,
  writesEnabled = false,
  busy = false,
  storageOkay = true;
let featuresEnabled = false;
let countRecoveryEnabled = false;
let connectionOpen = false;
let fieldId = 0;
let conflicts = [];
const checklist = () =>
  effectiveSession(
    record.session,
    record.productChanges,
    record.snapshot?.catalog,
  );
const hasPending = () =>
  Boolean(
    record.pending ||
    record.startPending ||
    record.featurePending ||
    record.recoveryPending,
  );
const features = createFeatures({
  record: () => record,
  config: () => config,
  rpc,
  persist,
  render,
  message,
  guard,
  focusView,
  downloadRecovery,
  pending: hasPending,
  busy: () => busy,
  supported: () => featuresEnabled || Boolean(record.featuresSupported),
  online: () => authenticated && navigator.onLine,
  writable: () => writesEnabled && storageOkay,
  mutate: async (kind, payload) => {
    if (hasPending()) throw Error("Resolve the pending operation first.");
    if (
      !featuresEnabled ||
      !writesEnabled ||
      !authenticated ||
      !navigator.onLine
    )
      throw Error("Sign in online with the updated bridge and writes enabled.");
    record.featurePending = { id: crypto.randomUUID(), kind, payload };
    persist();
    controls();
    await retryFeature();
  },
  resumeSession: async (id) => {
    if (hasPending()) throw Error("Resolve the pending operation first.");
    if (Object.keys(record.drafts).length || record.productChanges?.length)
      throw Error(
        "Keep or resolve the current draft before switching sessions.",
      );
    const snapshot = await rpc("load", { sessionId: id });
    if (!snapshot.session || snapshot.session.by !== config.email)
      throw Error("OWN_SESSION_ONLY");
    record.session = snapshot.session;
    record.snapshot = normalizeSnapshot(snapshot);
    persist();
    features.stock();
    render();
  },
});
const key = () => accountKey(config.endpoint, config.email);
const text = (tag, value, className) => {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
};
function message(value, error = false) {
  if ($("#message").textContent !== value) $("#message").textContent = value;
  $("#message").classList.toggle("error", error);
  $("#message").setAttribute("role", error ? "alert" : "status");
  $("#message").setAttribute("aria-live", error ? "assertive" : "polite");
  const errorBox = $("#form-error");
  if ($("#feature-dialog").open && errorBox) {
    errorBox.textContent = error ? value : "";
    if (error) errorBox.focus();
  } else if (error) {
    $("#message").focus({ preventScroll: true });
    $("#message").scrollIntoView({ block: "nearest" });
  }
}
function persist() {
  try {
    saveRecord(localStorage, key(), record);
    storageOkay = true;
  } catch {
    storageOkay = false;
    throw Error(
      "Device storage is full or blocked. No request was sent. Keep this page open and free storage.",
    );
  }
}
function controls() {
  const pending = hasPending();
  const connected = authenticated && navigator.onLine;
  $("#connect-panel").hidden = Boolean(
    record.snapshot && (authenticated || !connectionOpen),
  );
  $("#sign-in-again").hidden =
    authenticated || !record.snapshot || connectionOpen;
  $("#hide-connect").hidden = !record.snapshot;
  const badge = $("#connection-badge");
  const status = !navigator.onLine
    ? record.snapshot
      ? "Offline · saved data"
      : "Offline"
    : authenticated
      ? writesEnabled
        ? "Connected"
        : "Read only"
      : record.snapshot
        ? "Saved on device"
        : "Not connected";
  badge.textContent = status;
  badge.dataset.state = !navigator.onLine
    ? "offline"
    : connected
      ? "online"
      : "saved";
  $("#connect-form").setAttribute("aria-busy", String(busy));
  $("#feature-form").setAttribute("aria-busy", String(busy));
  $("#connect").disabled = busy;
  $("#connect").textContent =
    busy && !authenticated ? "Connecting…" : "Sign in & synchronize";
  $("#refresh").disabled = busy || !connected;
  $("#start").disabled =
    busy ||
    !connected ||
    !writesEnabled ||
    pending ||
    record.session?.status === "OPEN";
  $("#start").textContent = record.startPending
    ? "Start awaiting confirmation — Retry safely"
    : "Start count session";
  $("#retry").disabled = busy || !connected;
  $("#recover-count").hidden = !record.pending && !record.recoveryPending;
  $("#recover-count").disabled =
    busy ||
    !connected ||
    !writesEnabled ||
    !countRecoveryEnabled ||
    !storageOkay;
  $("#recovery-help").textContent =
    record.pending || record.recoveryPending
      ? countRecoveryEnabled
        ? "For a frozen-zone error: recovery checks the old outcome, replaces the checklist if safe, and preserves your draft for review."
        : "Zone recovery needs the updated PwaBridge.gs deployment. Your pending request and counts are still saved."
      : "";
  $("#pending-panel").hidden = !pending;
  $("#lock").disabled = busy || pending;
  $("#submit").disabled =
    busy ||
    pending ||
    !connected ||
    !writesEnabled ||
    !storageOkay ||
    Boolean(
      record.recoveryReview?.needsReview?.length ||
      record.recoveryReview?.catalogNeedsReview,
    ) ||
    conflicts.length > 0;
  $("#keep-current").disabled = busy || pending;
  $("#products")
    .querySelectorAll("input,select")
    .forEach((node) => (node.disabled = busy || pending));
  $("#conflicts")
    .querySelectorAll("button")
    .forEach((node) => (node.disabled = busy || pending));
  $("#recovery-review")
    .querySelectorAll("button")
    .forEach((node) => (node.disabled = busy || pending));
  $("#incomplete").disabled = busy || pending;
  features.controls();
}
async function guard(action) {
  if (busy) return;
  busy = true;
  controls();
  try {
    await action();
  } catch (error) {
    const reason = String(error.message);
    if (/SIGN_IN_REQUIRED/.test(reason)) {
      authenticated = false;
      token = null;
      connectionOpen = true;
      message(
        "Your Google session expired. Sign in again; your local draft and pending request are preserved.",
        true,
      );
    } else message(reason, true);
  } finally {
    busy = false;
    controls();
  }
}
function button(label, callback) {
  const node = text("button", label);
  node.type = "button";
  node.addEventListener("click", () => guard(callback));
  return node;
}
function restore() {
  record = readRecord(localStorage, key()) || initial();
  // A closed session's metadata may remain for audit, but never reopen it locally.
  $("#keep-current").checked = Boolean(record.keepCurrent);
  $("#incomplete").checked = Boolean(record.incomplete);
}
async function rpc(method, body = {}) {
  if (!authenticated) throw Error("Sign in online to synchronize.");
  return transport.call(method, body, token);
}
async function refresh() {
  const snapshot = await rpc("load", { sessionId: record.session?.id });
  if (snapshot.rejected) throw Error(snapshot.error || "LOAD_REJECTED");
  record.snapshot = normalizeSnapshot(snapshot);
  if (snapshot.session) record.session = snapshot.session;
  record.lastSync = new Date().toISOString();
  persist();
  render();
  message(
    "Synchronized from Google Sheets. Local draft revisions were preserved.",
  );
}
function updateProgress() {
  const session = checklist();
  const counting = session?.status === "OPEN";
  $("#count-progress").hidden = !counting;
  $("#count-help").hidden = !counting;
  if (!counting) return;
  const total = session.items.length;
  const entered = session.items.filter(
    (spec) =>
      spec.checked ||
      (spec.zones?.length ? spec.zones : ["unassigned"]).every(
        (zone) =>
          String(
            record.drafts[spec.id]?.locations?.[zone]?.value ?? "",
          ).trim() !== "",
      ),
  ).length;
  const label =
    record.language === "ru"
      ? `${entered} из ${total} товаров заполнено`
      : `${entered} of ${total} items entered`;
  $("#progress-label").textContent = label;
  $("#count-progress-bar").max = Math.max(1, total);
  $("#count-progress-bar").value = entered;
  $("#count-action-summary").textContent =
    `${label}. ${authenticated && navigator.onLine ? "Review blanks before sending." : "Saved locally · sign in online to send."}`;
}
function field(spec, zoneId, draft) {
  const row = document.createElement("div");
  row.className = "zone";
  const zone = record.snapshot?.zones?.find((value) => value.id === zoneId);
  const label = text(
    "label",
    zone ? `${zone.ru} / ${zone.en}` : "Total / Всего",
  );
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.placeholder = "Blank ≠ 0";
  input.maxLength = 30;
  input.id = `count-field-${++fieldId}`;
  label.htmlFor = input.id;
  input.setAttribute("aria-describedby", `count-help ${input.id}-error`);
  input.autocomplete = "off";
  input.dataset.product = spec.id;
  input.dataset.zone = zoneId;
  input.value = draft?.locations?.[zoneId]?.value || "";
  label.append(input);
  const select = document.createElement("select");
  select.setAttribute("aria-label", `${spec.ru} ${zoneId} input unit`);
  const units = [
    ["BASE", spec.unit],
    ...(spec.sleeve ? [["SLEEVE_25", "×25 pcs"]] : []),
  ];
  for (const [value, title] of units) {
    const option = text("option", title);
    option.value = value;
    select.append(option);
  }
  select.value = draft?.locations?.[zoneId]?.unit || "BASE";
  const errorBox = text("p", "", "field-error");
  errorBox.id = `${input.id}-error`;
  errorBox.setAttribute("role", "status");
  function validate() {
    try {
      if (input.value.trim())
        quantity(input.value, spec.unit, select.value === "SLEEVE_25");
      input.removeAttribute("aria-invalid");
      errorBox.textContent = "";
    } catch (error) {
      input.setAttribute("aria-invalid", "true");
      errorBox.textContent = error.message;
    }
  }
  input.addEventListener("blur", validate);
  const edit = () => {
    try {
      const current = record.snapshot.stock.products.find(
        (p) => p.id === spec.id,
      );
      const entry = (record.drafts[spec.id] ||= {
        revision: current?.revision || spec.revision,
        zones: spec.zones || [],
        unit: spec.unit,
        sleeve: Boolean(spec.sleeve),
        locations: {},
        approx: false,
        low: false,
      });
      entry.locations[zoneId] = { value: input.value, unit: select.value };
      entry.countedAt = new Date().toISOString();
      persist();
      updateProgress();
      if (input.getAttribute("aria-invalid") === "true") validate();
      const savedMessage = "Draft saved on this device. Not submitted yet.";
      if ($("#draft-feedback").textContent !== savedMessage)
        $("#draft-feedback").textContent = savedMessage;
      conflicts = changedDrafts(
        {
          ...record.snapshot,
          session: checklist(),
          productChanges: record.productChanges,
        },
        record.drafts,
      );
      renderConflicts();
      controls();
      message(
        "Count draft saved on this device. Not yet submitted to Google Sheets.",
      );
    } catch (error) {
      message(error.message, true);
      controls();
    }
  };
  input.addEventListener("input", edit);
  select.addEventListener("change", edit);
  row.append(label, select, errorBox);
  return row;
}
function flag(spec, keyName, labelText) {
  const label = text("label", "", "check");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(record.drafts[spec.id]?.[keyName]);
  input.addEventListener("change", () => {
    try {
      const current = record.snapshot.stock.products.find(
        (p) => p.id === spec.id,
      );
      const entry = (record.drafts[spec.id] ||= {
        revision: current?.revision || spec.revision,
        zones: spec.zones || [],
        unit: spec.unit,
        sleeve: Boolean(spec.sleeve),
        locations: {},
      });
      entry[keyName] = input.checked;
      entry.countedAt = new Date().toISOString();
      persist();
      message("Draft saved on this device.");
    } catch (error) {
      message(error.message, true);
      controls();
    }
  });
  label.append(input, document.createTextNode(labelText));
  return label;
}
function renderConflicts() {
  const target = $("#conflicts");
  target.replaceChildren();
  const regular = conflicts.filter(
    (id) => !record.recoveryReview?.needsReview?.includes(id),
  );
  $("#conflicts-panel").hidden = !regular.length;
  for (const id of regular) {
    const current = record.snapshot?.stock.products.find((p) => p.id === id);
    const draft = record.drafts[id];
    if (!draft || record.productChanges?.some((c) => c.id === id)) {
      const card = text(
        "div",
        `Staged checklist change ${id} needs review. Discard it and re-open the catalog to choose the current status/zones.`,
        "conflict",
      );
      card.append(
        button("Discard staged change and its draft", () => {
          record.productChanges = (record.productChanges || []).filter(
            (c) => c.id !== id,
          );
          delete record.drafts[id];
          persist();
          render();
        }),
      );
      target.append(card);
      continue;
    }
    const spec = record.session?.items.find((p) => p.id === id);
    const card = document.createElement("div");
    card.className = "conflict";
    card.append(
      text(
        "p",
        `${current?.ru || id}: latest balance ${current?.last ?? "unknown"} ${current?.unit || ""}. Recheck the physical quantity before keeping your entered values.`,
      ),
    );
    const compatible =
      current &&
      spec &&
      current.unit === draft.unit &&
      Boolean(current.sleeve) === draft.sleeve &&
      JSON.stringify([...(current.zones || [])].sort()) ===
        JSON.stringify([...(draft.zones || [])].sort());
    const checklistChanged =
      current &&
      spec &&
      JSON.stringify([...(current.zones || [])].sort()) !==
        JSON.stringify([...(spec.zones || [])].sort());
    if (checklistChanged)
      card.append(
        button("Recover frozen checklist — keep my draft", beginRecovery),
      );
    if (compatible)
      card.append(
        button("I rechecked — keep entered count", () => {
          // Explicit review, never silently rebase an absolute count.
          draft.revision = current.revision;
          draft.countedAt = new Date().toISOString();
          persist();
          render();
        }),
      );
    else
      card.append(
        text(
          "p",
          "Product, unit, or storage zones changed. Discard this entry; use a new session for changed checklist metadata.",
        ),
      );
    card.append(
      button("Discard this draft entry", () => {
        delete record.drafts[id];
        persist();
        render();
      }),
    );
    target.append(card);
  }
}
function downloadRecovery() {
  const file = new Blob(
    [
      JSON.stringify(
        {
          format: "varka-count-backup-1",
          exportedAt: new Date().toISOString(),
          account: config.email,
          endpoint: config.endpoint,
          session: record.session,
          drafts: record.drafts,
          productChanges: record.productChanges || [],
          pending: record.pending,
          recoveryPending: record.recoveryPending,
          recoveryArchives: record.recoveryArchives || [],
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(file),
    link = document.createElement("a");
  link.href = url;
  link.download = `varka-count-backup-${new Date().toISOString().replace(/:/g, "-")}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderRecovery() {
  const review = record.recoveryReview;
  $("#recovery-panel").hidden = !review;
  const root = $("#recovery-review");
  root.replaceChildren();
  if (!review) return;
  const archive = record.recoveryArchives.find(
    (item) => item.id === review.archiveId,
  );
  $("#recovery-summary").textContent =
    "The old checklist was closed without a stock write. Every original entry is retained in a local backup. Matching zone values are kept; new zones stay blank. Review and physically recheck changed assignments before submitting.";
  for (const id of review.needsReview) {
    const original = archive.drafts[id],
      draft = record.drafts[id],
      spec = record.session.items.find((item) => item.id === id);
    const card = text("div", undefined, "conflict");
    card.append(
      text(
        "h3",
        spec?.ru ||
          archive.session?.items.find((item) => item.id === id)?.ru ||
          id,
      ),
      text(
        "p",
        `Original values: ${
          Object.entries(original.locations || {})
            .map(
              ([zone, item]) =>
                `${zone}: ${item.value === "" ? "(blank)" : item.value} ${item.unit === "SLEEVE_25" ? "×25 pcs" : original.unit}`,
            )
            .join(" · ") || "(blank)"
        }`,
      ),
      text(
        "p",
        spec
          ? `Current zones: ${(spec.zones?.length ? spec.zones : ["unassigned"]).join(", ")} · ${spec.unit}. Recheck every current zone below, then confirm here.`
          : "This product is not active in the replacement checklist. Its original values remain in the backup and will not be submitted.",
      ),
    );
    if (spec)
      card.append(
        button("I rechecked every current zone — use these values", () => {
          const reviewed = record.drafts[id];
          if (!reviewed)
            throw Error(
              "Enter counts for the current zones first. The original values remain in the backup.",
            );
          const current = record.snapshot.catalog.find(
            (item) => item.id === id,
          );
          if (
            !current ||
            current.unit !== spec.unit ||
            JSON.stringify([...(current.zones || [])].sort()) !==
              JSON.stringify([...(spec.zones || [])].sort())
          )
            throw Error(
              "The catalog changed again. Recover the checklist again before confirming this item.",
            );
          for (const zone of spec.zones?.length ? spec.zones : ["unassigned"]) {
            const entry = reviewed.locations[zone];
            if (!entry || !String(entry.value).trim())
              throw Error(
                `Enter a physical count for every current zone of ${spec.ru}, including 0 where empty.`,
              );
            if (entry.unit === "SLEEVE_25" && !spec.sleeve)
              throw Error("Sleeve packaging changed. Enter base units.");
            if (!["BASE", "SLEEVE_25"].includes(entry.unit))
              throw Error("Choose a valid input unit.");
            quantity(entry.value, spec.unit, entry.unit === "SLEEVE_25");
          }
          reviewed.zones = [...(spec.zones || [])];
          reviewed.unit = spec.unit;
          reviewed.sleeve = Boolean(spec.sleeve);
          reviewed.revision = current.revision;
          reviewed.countedAt = new Date().toISOString();
          review.needsReview = review.needsReview.filter(
            (value) => value !== id,
          );
          persist();
          render();
        }),
      );
    else
      card.append(
        button("Keep in backup only — exclude from submission", () => {
          delete record.drafts[id];
          review.needsReview = review.needsReview.filter(
            (value) => value !== id,
          );
          persist();
          render();
        }),
      );
    root.append(card);
  }
  if (review.catalogNeedsReview) {
    root.append(
      text(
        "p",
        "Your staged catalog changes were backed up, not automatically reapplied. Review Catalog and restage them if still needed.",
      ),
      button("I reviewed the archived catalog changes", () => {
        review.catalogNeedsReview = false;
        persist();
        render();
      }),
    );
  }
  if (!review.needsReview.length && !review.catalogNeedsReview)
    root.append(
      text(
        "p",
        "Review complete. Your counts are ready for the usual revision checks when you submit. Nothing has been sent automatically.",
      ),
    );
}
function render() {
  const snapshot = record.snapshot;
  $("#workspace").hidden = !snapshot;
  $("#lock").hidden = !snapshot;
  if (!snapshot) {
    features.clear();
    features.render();
    controls();
    return;
  }
  $("#identity").textContent =
    `${config.email} · ${snapshot.profile?.name || "VARKA"}`;
  $("#sync-status").textContent =
    `Last saved synchronization: ${record.lastSync ? new Date(record.lastSync).toLocaleString() : "unknown"}. ${authenticated ? "Signed in for synchronization." : "Saved device data — sign in online to synchronize."}`;
  $("#mode").textContent = !authenticated
    ? "Offline/local view. No credentials are saved."
    : writesEnabled
      ? "Google Sheets is the shared database. Refresh to see changes from other devices."
      : "Read-only connection. The owner must enable PWA_WRITES_ENABLED after testing.";
  const session = checklist();
  $("#metric-products").textContent = snapshot.stock.products.length;
  $("#metric-low").textContent = snapshot.stock.products.filter(
    (p) =>
      p.low ||
      p.last === 0 ||
      (p.last != null && p.minimum != null && p.last <= p.minimum),
  ).length;
  $("#metric-due").textContent = snapshot.stock.products.filter(
    (p) => p.stale,
  ).length;
  updateProgress();
  const counting = session?.status === "OPEN";
  $("#count-status").textContent = session
    ? `Session ${session.id} · ${session.status}. ${counting ? "Every assigned storage zone is required for a counted product." : "Start a new session for another count."}`
    : "Start a session online before entering offline counts.";
  $("#submit-panel").hidden = !counting;
  conflicts = changedDrafts(
    { ...snapshot, session, productChanges: record.productChanges },
    record.drafts,
  );
  renderRecovery();
  for (const change of record.productChanges || []) {
    if (
      snapshot.catalog.find((p) => p.id === change.id)?.version !==
        change.version &&
      !conflicts.includes(change.id)
    )
      conflicts.push(change.id);
  }
  renderConflicts();
  const list = $("#products");
  list.replaceChildren();
  const query = $("#search").value.trim().toLowerCase();
  const products = counting ? session.items : snapshot.stock.products;
  let shown = 0;
  for (const spec of products) {
    if (
      query &&
      !`${spec.ru} ${spec.en} ${spec.category}`.toLowerCase().includes(query)
    )
      continue;
    const current = snapshot.stock.products.find((p) => p.id === spec.id);
    const low =
      current &&
      (current.low ||
        current.last === 0 ||
        (current.last != null &&
          current.minimum != null &&
          current.last <= current.minimum));
    if ($("#only-low").checked && !low) continue;
    shown++;
    const card = document.createElement("article");
    card.className = "product";
    const productTitle = text("h2", spec.ru);
    productTitle.lang = "ru";
    const englishTitle = text("div", spec.en || "", "meta");
    englishTitle.lang = "en";
    card.append(
      productTitle,
      englishTitle,
      text("div", `${spec.category || ""} · ${spec.id}`, "meta"),
      text(
        "p",
        `${current?.last ?? "Unknown / Неизвестно"} ${spec.unit}`,
        "balance",
      ),
    );
    if (current?.stale)
      card.append(
        text("p", "Physical check overdue / Пора пересчитать", "meta"),
      );
    if (low) card.append(text("p", "Low / Заканчивается", "badge warning"));
    if (current?.approx)
      card.append(text("p", "Estimated / Приблизительно", "meta"));
    if (current?.minimum == null)
      card.append(text("p", "Minimum not set / Минимум не задан", "meta"));
    if (current?.checked)
      card.append(
        text(
          "p",
          `Last count / Последний пересчёт: ${new Date(current.checked).toLocaleString(undefined, { timeZone: "Europe/Minsk" })}`,
          "meta",
        ),
      );
    if (counting && !spec.checked) {
      const fields = text("fieldset", undefined, "count-fields");
      fields.append(text("legend", `Count / Пересчёт: ${spec.ru}`, "sr-only"));
      for (const zone of spec.zones?.length ? spec.zones : ["unassigned"])
        fields.append(field(spec, zone, record.drafts[spec.id]));
      fields.append(
        flag(spec, "approx", "Estimated / Приблизительно"),
        flag(spec, "low", "Manually mark low / Мало"),
      );
      card.append(fields);
    }
    list.append(card);
  }
  const resultsMessage = `${shown} of ${products.length} products shown${query || $("#only-low").checked ? " · filtered" : ""}`;
  if ($("#results-count").textContent !== resultsMessage)
    $("#results-count").textContent = resultsMessage;
  if (!shown) {
    const empty = text("div", undefined, "panel empty-state");
    empty.append(
      text("h2", "No matching products"),
      text(
        "p",
        "Try a different name or turn off the low-stock filter. Your draft is unchanged.",
      ),
    );
    list.append(empty);
  }
  controls();
  features.render();
}
async function start() {
  if (Object.keys(record.drafts).length || record.productChanges?.length)
    throw Error(
      "Resolve or discard the previous local draft before starting another session.",
    );
  record.startPending = { id: crypto.randomUUID() };
  persist();
  controls();
  await resumeStart();
}
async function resumeStart() {
  const result = await rpc("start", record.startPending);
  if (result.rejected) throw Error(result.error || "START_REJECTED");
  if (!result.session || result.session.id !== record.startPending.id)
    throw Error("START_UNCONFIRMED");
  record.session = result.session;
  record.startPending = null;
  persist();
  await refresh();
  message("Session opened. Counts can now be drafted offline on this device.");
}
function committed(result) {
  record.pending = null;
  record.recoveryPending = null;
  record.recoveryReview = null;
  record.drafts = {};
  record.productChanges = [];
  record.keepCurrent = false;
  record.incomplete = false;
  $("#keep-current").checked = false;
  $("#incomplete").checked = false;
  if (record.session) record.session.status = result.status || "COMPLETE";
  persist();
  render();
  focusView();
  message(
    `Confirmed in Google Sheets: ${result.saved ?? ""} counts. Refresh to see the latest inventory.`,
  );
}
async function retry() {
  if (record.recoveryPending) return resumeRecovery();
  if (record.featurePending) return retryFeature();
  if (record.startPending) return resumeStart();
  if (!record.pending) return;
  const pending = record.pending;
  // Check before retrying; status reads do not repeat legacy notification delivery.
  const status = await rpc("status", { id: pending.id });
  if (status.status === "COMMITTED") {
    committed(status.result);
    await refresh();
    return;
  }
  if (!["ABSENT", "UNCONFIRMED"].includes(status.status))
    throw Error(
      "Unexpected operation status. Keep the pending request and contact the owner.",
    );
  const result = await rpc("submit", pending);
  if (result.rejected) {
    record.pending = null;
    persist();
    // A definite rejection is not an uncertain commit. Drafts remain unchanged.
    await refresh();
    throw Error(
      `${result.error || "Count rejected"}. Draft preserved; review before creating a new submission.`,
    );
  }
  if (!result.ok)
    throw Error(
      "COMMIT_UNCONFIRMED. Keep the pending request and retry safely.",
    );
  committed(result);
  await refresh();
}
async function beginRecovery() {
  if (!authenticated || !navigator.onLine || !writesEnabled)
    throw Error(
      "Sign in online with writes enabled before recovering a checklist. Your draft is unchanged.",
    );
  if (!countRecoveryEnabled)
    throw Error(
      "Update and redeploy PwaBridge.gs, then sign in again to enable count recovery. Your draft is unchanged.",
    );
  if (record.featurePending || record.startPending)
    throw Error("Resolve the other pending operation first.");
  if (!record.recoveryPending) {
    if (
      !confirm(
        "Recovery first checks whether your old count committed. If not, it closes that checklist and starts a current one. All local values are backed up; changed zones require physical rechecking. Continue?",
      )
    )
      return;
    record.recoveryPending = {
      id: crypto.randomUUID(),
      successorId: crypto.randomUUID(),
      pending: structuredClone(
        record.pending || {
          id: crypto.randomUUID(),
          sessionId: record.session.id,
          items: [],
          incomplete: true,
        },
      ),
    };
    persist();
    controls();
  }
  await resumeRecovery();
}
async function resumeRecovery() {
  const recovery = record.recoveryPending;
  const result = await rpc("recoverCount", recovery);
  if (result.status === "COMMITTED") {
    committed(result.result);
    await refresh();
    return;
  }
  if (result.status !== "RECOVERED")
    throw Error(
      result.status === "UNCONFIRMED"
        ? "An unconfirmed batch exists. Keep the saved request; the owner must inspect it before recovery."
        : "This session changed or was closed elsewhere. Keep your draft and ask the owner to check its history.",
    );
  const snapshot = await rpc("load", { sessionId: result.sessionId });
  const candidate = recoverCountDraft(record, snapshot, recovery);
  try {
    saveRecord(localStorage, key(), candidate);
  } catch {
    storageOkay = false;
    throw Error(
      "The server checklist was recovered, but device storage is full. Your original saved request is retained. Free storage and Retry safely; do not clear app data.",
    );
  }
  record = candidate;
  storageOkay = true;
  features.stock();
  render();
  focusView();
  message(
    "Checklist recovered. Your original values are backed up on this device. Review changed zones before submitting.",
  );
}
async function retryFeature() {
  const pending = record.featurePending;
  if (!pending) return;
  let result = await rpc("operationStatus", { id: pending.id });
  if (result.status === "ABSENT") result = await rpc("mutate", pending);
  if (result.status === "UNKNOWN")
    throw Error(
      `Operation ${pending.id} is still running or uncertain. Wait and check status again. Do not recreate it; if it stays UNKNOWN, ask the owner to reconcile PwaOperations against the original records. ${result.result?.error || ""}`,
    );
  if (!["COMMITTED", "REJECTED"].includes(result.status))
    throw Error("Unexpected operation status. Keep the saved request.");
  record.featurePending = null;
  persist();
  $("#feature-dialog").close();
  await refresh();
  await features.refreshView();
  if (result.status === "REJECTED")
    throw Error(
      result.result?.error ||
        "Operation rejected. Refresh and review your input.",
    );
  message("Confirmed in Google Sheets. History and attribution are preserved.");
}
$("#connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  // Clear the DOM immediately; never pass credentials to persistence functions.
  const code = $("#code").value;
  $("#code").value = "";
  guard(async () => {
    const next = {
      endpoint: deploymentUrl($("#endpoint").value.trim()).href,
      email: $("#email").value.trim().toLowerCase(),
    };
    if (
      hasPending() &&
      (next.endpoint !== config.endpoint || next.email !== config.email)
    )
      throw Error(
        "Confirm the pending operation with the original account and deployment before switching accounts.",
      );
    transport?.destroy();
    authenticated = false;
    token = null;
    transport = new GoogleTransport(next.endpoint);
    const capabilities = await transport.call("ping");
    if (capabilities.protocol !== 1)
      throw Error("Unsupported bridge protocol.");
    const login = await transport.call("login", { email: next.email, code });
    if (!login.token || login.email !== next.email)
      throw Error("Invalid sign-in response.");
    config = next;
    token = login.token;
    authenticated = true;
    connectionOpen = false;
    writesEnabled = capabilities.writesEnabled === true;
    featuresEnabled = capabilities.features === 2;
    countRecoveryEnabled = capabilities.countRecovery === 1;
    saveRecord(localStorage, "varka-google:configuration", config);
    restore();
    record.featuresSupported = featuresEnabled;
    features.clear();
    render();
    if (record.startPending)
      message(
        "Sign-in complete. Use Retry safely to confirm your pending session start.",
      );
    else await refresh();
    focusView();
  });
});
$("#refresh").addEventListener("click", () => guard(refresh));
$("#start").addEventListener("click", () => guard(start));
$("#retry").addEventListener("click", () => guard(retry));
$("#recover-count").addEventListener("click", () => guard(beginRecovery));
$("#download-count-backup").addEventListener("click", downloadRecovery);
$("#download-recovery").addEventListener("click", downloadRecovery);
$("#submit").addEventListener("click", () =>
  guard(async () => {
    if (conflicts.length) throw Error("Review changed products first.");
    if (
      record.recoveryReview?.needsReview.length ||
      record.recoveryReview?.catalogNeedsReview
    )
      throw Error("Complete the recovered zone review first.");
    record.pending = buildSubmission(checklist(), record.drafts, {
      keepCurrent: record.keepCurrent,
      incomplete: record.incomplete,
      productChanges: record.productChanges,
    });
    persist();
    controls();
    await retry();
  }),
);
$("#keep-current").addEventListener("change", () => {
  try {
    record.keepCurrent = $("#keep-current").checked;
    if (record.keepCurrent) {
      record.incomplete = false;
      $("#incomplete").checked = false;
    }
    persist();
  } catch (error) {
    message(error.message, true);
    controls();
  }
});
$("#search").addEventListener("input", render);
$("#sign-in-again").addEventListener("click", () => {
  connectionOpen = true;
  controls();
  $("#code").focus();
  $("#connect-panel").scrollIntoView({ block: "start" });
});
$("#hide-connect").addEventListener("click", () => {
  connectionOpen = false;
  controls();
  $("#sign-in-again").focus();
});
$("#clear-draft").addEventListener("click", () =>
  guard(() => {
    if (hasPending()) throw Error("Resolve the pending operation first.");
    if (
      !confirm(
        "Discard this device’s unsent counts and staged checklist changes? The server session and stock will not change.",
      )
    )
      return;
    record.drafts = {};
    record.recoveryReview = null;
    record.productChanges = [];
    record.keepCurrent = false;
    record.incomplete = false;
    $("#keep-current").checked = false;
    $("#incomplete").checked = false;
    persist();
    render();
    message("Local count draft cleared. No server stock was changed.");
  }),
);
$("#only-low").addEventListener("change", render);
$("#incomplete").addEventListener("change", () => {
  try {
    record.incomplete = $("#incomplete").checked;
    if (record.incomplete) {
      record.keepCurrent = false;
      $("#keep-current").checked = false;
    }
    persist();
  } catch (error) {
    message(error.message, true);
  }
});
$("#lock").addEventListener("click", () =>
  guard(async () => {
    if (hasPending())
      throw Error("Confirm the pending request before clearing this device.");
    if (
      (Object.keys(record.drafts).length || record.productChanges?.length) &&
      !window.confirm("Discard saved count drafts on this device?")
    )
      return;
    // Local lock works even without a connection. A remote session expires naturally
    // if logout cannot reach Google; its token is not persisted anywhere.
    const activeTransport = transport,
      activeToken = token;
    const remoteLogout = authenticated
      ? activeTransport.call("logout", {}, activeToken).catch(() => {})
      : Promise.resolve();
    localStorage.removeItem(key());
    localStorage.removeItem("varka-google:configuration");
    record = initial();
    authenticated = false;
    connectionOpen = false;
    token = null;
    features.clear();
    render();
    $("#email").focus();
    message(
      "Saved inventory and drafts cleared. Sign in to open the café again.",
    );
    await remoteLogout;
    activeTransport?.destroy();
    transport = null;
  }),
);
window.addEventListener("offline", () => {
  message(
    "Device offline. Existing counts can be drafted locally; reconnect and sign in to synchronize.",
  );
  // navigator.onLine is a hint only; no queued operation is automatically sent.
  controls();
});
window.addEventListener("online", () => {
  message(
    "Network available. Sign in or refresh, then explicitly synchronize your counts.",
  );
  controls();
});
$("#endpoint").value = config.endpoint || "";
$("#email").value = config.email || "";
$("#connection-settings").open = !config.endpoint;
if (config.endpoint && config.email) {
  restore();
  render();
  if (record.snapshot)
    message(
      "Opened saved device data. Sign in online to refresh or synchronize.",
    );
}
if ("serviceWorker" in navigator && window.isSecureContext)
  navigator.serviceWorker
    .register("./sw.js")
    .catch(() =>
      message(
        "Offline installation failed. Reconnect and reload before relying on offline access.",
        true,
      ),
    );
