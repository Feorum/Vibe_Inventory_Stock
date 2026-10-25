import { GoogleTransport, deploymentUrl } from "./transport.js";
import { createFeatures } from "./features.js";
import {
  accountKey,
  readRecord,
  saveRecord,
  buildSubmission,
  changedDrafts,
  normalizeSnapshot,
  effectiveSession,
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
let conflicts = [];
const checklist = () =>
  effectiveSession(
    record.session,
    record.productChanges,
    record.snapshot?.catalog,
  );
const hasPending = () =>
  Boolean(record.pending || record.startPending || record.featurePending);
const features = createFeatures({
  record: () => record,
  config: () => config,
  rpc,
  persist,
  render,
  message,
  guard,
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
  $("#message").textContent = value;
  $("#message").classList.toggle("error", error);
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
  $("#connect").disabled = busy;
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
  $("#pending-panel").hidden = !pending;
  $("#lock").disabled = busy || pending;
  $("#submit").disabled =
    busy ||
    pending ||
    !connected ||
    !writesEnabled ||
    !storageOkay ||
    conflicts.length > 0;
  $("#keep-current").disabled = busy || pending;
  $("#products")
    .querySelectorAll("input,select")
    .forEach((node) => (node.disabled = busy || pending));
  $("#conflicts")
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
      conflicts = changedDrafts(
        { ...record.snapshot, session: checklist() },
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
  row.append(label, select);
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
  $("#conflicts-panel").hidden = !conflicts.length;
  for (const id of conflicts) {
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
  const counting = session?.status === "OPEN";
  $("#count-status").textContent = session
    ? `Session ${session.id} · ${session.status}. ${counting ? "Every assigned storage zone is required for a counted product." : "Start a new session for another count."}`
    : "Start a session online before entering offline counts.";
  $("#submit-panel").hidden = !counting;
  conflicts = changedDrafts({ ...snapshot, session }, record.drafts);
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
    const card = document.createElement("article");
    card.className = "product";
    card.append(
      text("h2", spec.ru),
      text("div", spec.en || "", "meta"),
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
    if (low) card.append(text("p", "Low / Заканчивается", "meta"));
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
      for (const zone of spec.zones?.length ? spec.zones : ["unassigned"])
        card.append(field(spec, zone, record.drafts[spec.id]));
      card.append(
        flag(spec, "approx", "Estimated / Приблизительно"),
        flag(spec, "low", "Manually mark low / Мало"),
      );
    }
    list.append(card);
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
  record.drafts = {};
  record.productChanges = [];
  record.keepCurrent = false;
  record.incomplete = false;
  $("#keep-current").checked = false;
  $("#incomplete").checked = false;
  if (record.session) record.session.status = result.status || "COMPLETE";
  persist();
  render();
  message(
    `Confirmed in Google Sheets: ${result.saved ?? ""} counts. Refresh to see the latest inventory.`,
  );
}
async function retry() {
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
    writesEnabled = capabilities.writesEnabled === true;
    featuresEnabled = capabilities.features === 2;
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
  });
});
$("#refresh").addEventListener("click", () => guard(refresh));
$("#start").addEventListener("click", () => guard(start));
$("#retry").addEventListener("click", () => guard(retry));
$("#submit").addEventListener("click", () =>
  guard(async () => {
    if (conflicts.length) throw Error("Review changed products first.");
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
    token = null;
    features.clear();
    render();
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
