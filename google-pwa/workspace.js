import { GoogleTransport, deploymentUrl } from "./transport.js";
import { translate, errorKey } from "./locales.js";
import {
  createDraft,
  quantityInput,
  editDraft,
  draftState,
  conflicts,
  filterProducts,
  buildSubmission,
  applyAcknowledgment,
  mergeSnapshot,
  storageKey,
} from "./workspace-model.js";

const $ = (value) => document.querySelector(value);
const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
};
let config = read("varka-workspace:configuration") || {};
let language = read("varka-workspace:language") === "ru" ? "ru" : "en";
let record = {
  snapshot: null,
  drafts: {},
  pending: null,
  pendingMutation: null,
  notification: null,
};
let transport,
  token,
  authenticated = false,
  loading = false,
  submitting = false,
  mutating = false,
  storageOkay = true;
let page = "stock",
  lastMessage,
  opener,
  undoAction;
let generation = 0,
  snapshotEpoch = 0,
  loginOpen = false;
const notifying = new Set();
const filters = {
  stock: { search: "", zone: "", category: "" },
  catalog: { search: "", zone: "", category: "" },
};
const t = (key, values) => translate(language, key, values);
const make = (tag, value, className) => {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = value;
  if (className) el.className = className;
  return el;
};
const button = (label, fn, className) => {
  const el = make("button", label, className);
  el.type = "button";
  el.addEventListener("click", () => guard(fn));
  return el;
};
const productName = (p) =>
  (language === "en" ? p.en || p.ru : p.ru || p.en) || p.id;
const zoneName = (id) => {
  const z = record.snapshot?.zones?.find((z) => z.id === id);
  return z
    ? z[language] || z.ru || z.en || z.id
    : id === "unassigned"
      ? t("unassigned")
      : id;
};
const quantityText = (value) =>
  value === null || value === undefined || value === ""
    ? t("notCounted")
    : new Intl.NumberFormat(language, { maximumFractionDigits: 8 }).format(
        Number(value),
      );
const dateText = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : t("notCounted");
const writable = () =>
  authenticated &&
  navigator.onLine &&
  record.snapshot?.permissions?.write !== false &&
  storageOkay;
const recordKey = () =>
  storageKey(record.snapshot.databaseId, config.username, config.endpoint);
const pointerKey = () =>
  `varka-workspace:last:${config.endpoint}:${String(config.username || "").toLowerCase()}`;
function enteredCache() {
  const account = $("#username").value.trim().toLowerCase(),
    endpoint = $("#endpoint").value.trim();
  const key = read(`varka-workspace:last:${endpoint}:${account}`),
    saved = key && read(key);
  return { account, endpoint, key, saved };
}
function persist(candidate = record) {
  try {
    localStorage.setItem(
      storageKey(
        candidate.snapshot.databaseId,
        config.username,
        config.endpoint,
      ),
      JSON.stringify(candidate),
    );
    localStorage.setItem(
      pointerKey(),
      JSON.stringify(
        storageKey(
          candidate.snapshot.databaseId,
          config.username,
          config.endpoint,
        ),
      ),
    );
    storageOkay = true;
  } catch {
    storageOkay = false;
    throw Error("STORAGE_ERROR");
  }
}
function flash(key, values = {}, error = false) {
  lastMessage = { key, values, error };
  const el = $("#message");
  el.textContent = t(key, values);
  el.classList.toggle("error", error);
  el.setAttribute("role", error ? "alert" : "status");
  if (error) {
    const formError = $(".dialog-error");
    if ($("#workspace-dialog").open && formError) {
      formError.textContent = t(key, values);
      formError.focus();
    } else el.focus({ preventScroll: true });
  }
}
function showError(error) {
  if (error?.productId) {
    const p = record.snapshot?.products?.find((p) => p.id === error.productId);
    flash(
      "productCountError",
      { name: p ? productName(p) : error.productId, error: t(errorKey(error)) },
      true,
    );
    return;
  }
  flash(
    error?.message === "STORAGE_ERROR" ? "storageError" : errorKey(error),
    {},
    true,
  );
}
async function guard(fn) {
  try {
    await fn();
  } catch (error) {
    if (error?.message !== "STALE_OPERATION") showError(error);
  } finally {
    controls();
  }
}
async function rpc(method, body = {}) {
  if (
    !transport ||
    (!authenticated && method !== "workspaceLogin" && method !== "ping")
  )
    throw Error("SIGN_IN_REQUIRED");
  const epoch = generation;
  try {
    const result = await transport.call(method, body, token);
    if (epoch !== generation) throw Error("STALE_OPERATION");
    return result;
  } catch (error) {
    if (epoch !== generation) throw Error("STALE_OPERATION");
    if (epoch === generation && error?.message === "SIGN_IN_REQUIRED") {
      authenticated = false;
      token = null;
      controls();
    }
    throw error;
  }
}
function bindText(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]"))
    el.textContent = t(el.dataset.i18n);
}
function languageSelect(id) {
  const label = make("label", t("language"));
  const select = make("select");
  select.id = id;
  for (const [value, caption] of [
    ["en", "English"],
    ["ru", "Русский"],
  ]) {
    const option = make("option", caption);
    option.value = value;
    select.append(option);
  }
  select.value = language;
  select.addEventListener("change", () =>
    guard(() => setLanguage(select.value)),
  );
  label.append(select);
  return label;
}
function setLanguage(value) {
  language = value === "ru" ? "ru" : "en";
  try {
    localStorage.setItem("varka-workspace:language", JSON.stringify(language));
  } catch {
    storageOkay = false;
    flash("storageError", {}, true);
  }
  document.documentElement.lang = language;
  bindText();
  $("#login-language").value = language;
  if (transport) transport.frame.title = t("refresh");
  if (record.snapshot) render();
  if (lastMessage)
    flash(lastMessage.key, lastMessage.values, lastMessage.error);
}

document.body.innerHTML = `<a class="skip" href="#main" data-i18n="skip"></a><header><strong class="brand">VARKA</strong><span id="connection-badge"></span><button id="online-login" type="button" data-i18n="signInAgain" hidden></button><button id="refresh" type="button" data-i18n="refresh" hidden></button></header><main id="main"><p id="message" role="status" aria-live="polite" tabindex="-1"></p><section id="connect-panel" class="panel"><h1 data-i18n="loginTitle"></h1><p class="help" data-i18n="loginHelp"></p><form id="connect-form" class="form-grid"><label><span data-i18n="username"></span><input id="username" required autocomplete="username" autocapitalize="none" spellcheck="false"></label><label><span data-i18n="password"></span><input id="password" type="password" required autocomplete="current-password" maxlength="200"></label><label><span data-i18n="endpoint"></span><input id="endpoint" type="url" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec"></label><div id="login-language-wrap"></div><button id="sign-in" class="primary" data-i18n="signIn"></button></form><p class="help" data-i18n="privacy"></p><button id="restore-offline" type="button" data-i18n="restoreOffline" hidden></button><p id="cache-identity" class="help" hidden></p></section><section id="workspace" hidden><h1 id="view-heading" tabindex="-1"></h1><div id="pending-panel" class="panel" hidden><h2 data-i18n="pending"></h2><p data-i18n="pendingHelp"></p><button id="retry" type="button" data-i18n="retry"></button></div><div id="notification-panel" class="panel" hidden></div><div id="page-content"></div><div id="undo-panel" hidden></div></section></main><div id="count-bar" class="count-bar" hidden><div><span class="help" data-i18n="draftNotice"></span><button id="synchronize-quantity" type="button" class="primary" data-i18n="syncQuantity"></button></div></div><nav id="navigation" aria-label="VARKA" hidden></nav><footer data-i18n="version"></footer><dialog id="workspace-dialog"><form id="dialog-form" class="form-grid" novalidate></form></dialog>`;
$("#login-language-wrap").append(languageSelect("login-language"));
$("#main").tabIndex = -1;
$("#connect-form").noValidate = true;
$("#username").value = config.username || "";
$("#endpoint").value = config.endpoint || "";
for (const id of ["#username", "#endpoint"])
  $(id).addEventListener("input", controls);
$("#online-login").addEventListener("click", () => {
  loginOpen = true;
  controls();
  $("#password").focus();
});
$("#connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  guard(login);
});
$("#refresh").addEventListener("click", () => guard(refresh));
$("#retry").addEventListener("click", () => guard(retryPending));
$("#synchronize-quantity").addEventListener("click", () =>
  guard(confirmSubmission),
);
$("#restore-offline").addEventListener("click", () => guard(restoreOffline));
$("#workspace-dialog").addEventListener("close", () => {
  if (opener?.isConnected && !opener.disabled) opener.focus();
  else $("#view-heading")?.focus({ preventScroll: true });
});
$("#workspace-dialog").addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const all = [
    ...event.currentTarget.querySelectorAll(
      "button,input,select,textarea,[tabindex]",
    ),
  ].filter(
    (el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length,
  );
  if (!all.length) return;
  const first = all[0],
    last = all.at(-1);
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement.tabIndex < 0)
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || document.activeElement.tabIndex < 0)
  ) {
    event.preventDefault();
    first.focus();
  }
});

function controls() {
  const has = Boolean(record.snapshot);
  $("#workspace").hidden = !has;
  $("#connect-panel").hidden = has && !loginOpen;
  $("#online-login").hidden = !has || authenticated;
  $("#navigation").hidden = !has;
  $("#refresh").hidden = !has;
  $("#refresh").disabled = loading || !authenticated || !navigator.onLine;
  $("#connection-badge").textContent = t(
    !navigator.onLine
      ? "offline"
      : authenticated
        ? record.snapshot?.permissions?.write === false
          ? "readOnly"
          : "online"
        : "disconnected",
  );
  $("#sign-in").disabled = loading;
  $("#connect-form").setAttribute("aria-busy", String(loading));
  $("#count-bar").hidden = !has || page !== "stock";
  $("#synchronize-quantity").disabled =
    submitting ||
    Boolean(record.pending) ||
    Boolean(record.pendingMutation) ||
    !writable();
  $("#pending-panel").hidden = !record.pending && !record.pendingMutation;
  $("#retry").disabled = submitting || mutating || !writable();
  for (const el of document.querySelectorAll("[data-server-action]"))
    el.disabled =
      !writable() ||
      mutating ||
      Boolean(record.pendingMutation) ||
      Boolean(record.pending);
  const cache = enteredCache(),
    validCache =
      cache.saved?.snapshot &&
      cache.key ===
        storageKey(
          cache.saved.snapshot.databaseId,
          cache.account,
          cache.endpoint,
        ) &&
      String(cache.saved.snapshot.profile?.email || "").toLowerCase() ===
        cache.account;
  $("#restore-offline").hidden = has || !validCache;
  $("#restore-offline").disabled = loading;
  $("#cache-identity").hidden = has || !validCache;
  $("#cache-identity").textContent = validCache
    ? t("accountCache", { account: cache.account })
    : "";
}
async function login() {
  if (loading) return;
  const username = $("#username").value.trim().toLowerCase(),
    password = $("#password").value,
    endpoint = deploymentUrl($("#endpoint").value.trim()).href;
  if (!username || !password) throw Error("INVALID_REQUIRED");
  const epoch = ++generation;
  loading = true;
  submitting = false;
  mutating = false;
  loginOpen = false;
  record = {
    snapshot: null,
    drafts: {},
    pending: null,
    pendingMutation: null,
    notification: null,
  };
  authenticated = false;
  token = null;
  transport?.destroy();
  transport = new GoogleTransport(endpoint);
  transport.frame.title = t("refresh");
  flash("loading");
  controls();
  try {
    const loginResult = await rpc("workspaceLogin", { username, password });
    if (epoch !== generation) return;
    $("#password").value = "";
    token = loginResult.token;
    authenticated = true;
    const snapshot = await rpc("workspaceLoad");
    if (epoch !== generation) return;
    if (
      !snapshot?.databaseId ||
      !Array.isArray(snapshot.products) ||
      !snapshot.profile
    )
      throw Error("NO_SNAPSHOT");
    config = {
      endpoint,
      username: String(
        loginResult.email || snapshot.profile.email || username,
      ).toLowerCase(),
    };
    const saved = read(
      storageKey(snapshot.databaseId, config.username, endpoint),
    );
    const candidate = saved
      ? mergeSnapshot(saved, snapshot)
      : {
          snapshot,
          drafts: {},
          pending: null,
          pendingMutation: null,
          notification: null,
        };
    candidate.loadedAt = new Date().toISOString();
    persist(candidate);
    record = candidate;
    localStorage.setItem(
      "varka-workspace:configuration",
      JSON.stringify(config),
    );
    page = "stock";
    flash("refreshed");
    render();
  } catch (error) {
    if (epoch !== generation) return;
    authenticated = false;
    token = null;
    record = {
      snapshot: null,
      drafts: {},
      pending: null,
      pendingMutation: null,
      notification: null,
    };
    flash(
      errorKey(error) === "unknownError" ? "loginFailed" : errorKey(error),
      {},
      true,
    );
  } finally {
    if (epoch === generation) {
      $("#password").value = "";
      loading = false;
      controls();
    }
  }
}
async function restoreOffline() {
  if (loading) return;
  const { account, endpoint, key, saved } = enteredCache();
  if (!saved?.snapshot) throw Error("NO_SNAPSHOT");
  deploymentUrl(endpoint);
  if (
    key !== storageKey(saved.snapshot.databaseId, account, endpoint) ||
    String(saved.snapshot.profile?.email || "").toLowerCase() !== account
  )
    throw Error("SIGN_IN_REQUIRED");
  ++generation;
  config = { username: account, endpoint };
  record = saved;
  authenticated = false;
  page = "stock";
  loginOpen = false;
  flash("draftNotice");
  render();
}
async function refresh() {
  if (loading) return;
  const epoch = generation,
    version = snapshotEpoch,
    key = recordKey();
  loading = true;
  flash("refreshing");
  controls();
  try {
    const snapshot = await rpc("workspaceLoad");
    if (epoch !== generation || key !== recordKey())
      throw Error("STALE_OPERATION");
    if (version !== snapshotEpoch) return;
    if (snapshot.databaseId !== record.snapshot.databaseId)
      throw Error("NO_SNAPSHOT");
    const candidate = mergeSnapshot(record, snapshot);
    candidate.loadedAt = new Date().toISOString();
    persist(candidate);
    record = candidate;
    render();
    flash("refreshed");
  } finally {
    if (epoch === generation) {
      loading = false;
      controls();
    }
  }
}
function render() {
  document.documentElement.lang = language;
  bindText();
  if (!record.snapshot) {
    controls();
    return;
  }
  $("#view-heading").textContent = t(page);
  const nav = $("#navigation");
  nav.replaceChildren();
  for (const id of ["stock", "catalog", "team", "profile"]) {
    const b = button(t(id), () => {
      page = id;
      render();
      $("#view-heading").focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    });
    b.dataset.view = id;
    if (page === id) b.setAttribute("aria-current", "page");
    nav.append(b);
  }
  const root = $("#page-content");
  root.replaceChildren();
  if (page === "stock" || page === "catalog") renderProducts(root);
  else if (page === "team") renderTeam(root);
  else renderProfile(root);
  renderNotification();
  controls();
}
function renderProducts(root) {
  const current = filters[page],
    all = record.snapshot.products || [];
  const filter = make("section", undefined, "panel filters");
  const searchLabel = make("label", t("search")),
    search = make("input");
  search.type = "search";
  search.value = current.search;
  searchLabel.append(search);
  filter.append(searchLabel);
  const selectFilter = (key, title, options, allLabel) => {
    const label = make("label", t(title)),
      select = make("select");
    const blank = make("option", t(allLabel));
    blank.value = "";
    select.append(blank);
    for (const [id, name] of options) {
      const option = make("option", name);
      option.value = id;
      select.append(option);
    }
    select.value = current[key];
    select.addEventListener("change", () => {
      current[key] = select.value;
      list();
    });
    label.append(select);
    filter.append(label);
  };
  selectFilter(
    "zone",
    "location",
    (record.snapshot.zones || []).map((z) => [z.id, zoneName(z.id)]),
    "allLocations",
  );
  selectFilter(
    "category",
    "category",
    (
      record.snapshot.categories || [...new Set(all.map((p) => p.category))]
    ).map((c) => [
      typeof c === "string" ? c : c.id,
      typeof c === "string" ? c : c.name || c.id,
    ]),
    "allCategories",
  );
  filter.append(
    button(t("resetFilters"), () => {
      filters[page] = { search: "", zone: "", category: "" };
      render();
    }),
  );
  root.append(filter);
  const actions = make("div", undefined, "actions");
  if (page === "catalog") {
    const b = button(t("addProduct"), () => catalogForm());
    b.dataset.serverAction = "true";
    actions.append(b);
  } else {
    actions.append(button(t("clear"), clearDrafts));
    actions.append(button(t("backup"), downloadBackup));
    root.append(make("p", t("countHelp"), "help"));
  }
  root.append(actions);
  const result = make("p", undefined, "help");
  result.setAttribute("role", "status");
  root.append(result);
  const conflictBox = make("section", undefined, "panel");
  root.append(conflictBox);
  const cards = make("div", undefined, "product-list");
  root.append(cards);
  function list() {
    const visible = filterProducts(all, current),
      changes = conflicts(record.snapshot, record.drafts);
    cards.replaceChildren();
    result.textContent = t("filtersResult", {
      shown: visible.length,
      total: all.length,
    });
    const failed = (record.lastResult?.failed || []).filter(
      (item) => record.drafts[item.id]?.editVersion === item.editVersion,
    );
    conflictBox.hidden = !changes.length && !failed.length;
    conflictBox.replaceChildren();
    if (changes.length) {
      conflictBox.append(
        make("h2", t("conflictTitle")),
        make("p", t("conflictHelp"), "help"),
      );
      for (const change of changes)
        conflictBox.append(
          make("p", t(change.reason), "error"),
          button(
            `${t("review")} · ${productName(change.product || { id: change.id })}`,
            () => reviewConflict(change),
          ),
        );
    }
    for (const item of failed) {
      const product = all.find((p) => p.id === item.id);
      conflictBox.append(
        make(
          "p",
          t("productCountError", {
            name: product ? productName(product) : item.id,
            error: t(errorKey(item.error)),
          }),
          "error",
        ),
      );
    }
    if (!visible.length)
      cards.append(
        make("p", t(all.length ? "noProducts" : "emptyCatalog"), "panel"),
      );
    for (const p of visible)
      cards.append(
        productCard(
          p,
          changes.some((c) => c.id === p.id),
        ),
      );
    controls();
  }
  search.addEventListener("input", () => {
    current.search = search.value;
    list();
  });
  list();
}
function productCard(p, conflicted) {
  const card = make(
    "article",
    undefined,
    `product-card${p.active ? "" : " inactive"}${conflicted ? " conflict" : ""}`,
  );
  card.dataset.productId = p.id;
  const heading = make("div", undefined, "product-heading");
  heading.append(
    make("h2", productName(p)),
    make("span", t(p.active ? "active" : "inactive"), "badge"),
  );
  card.append(heading);
  card.append(
    make(
      "p",
      (p.zones || []).map(zoneName).join(" · ") || t("unassigned"),
      "locations",
    ),
  );
  if (page === "stock") {
    const recorded = make("div", undefined, "recorded");
    recorded.append(
      make("span", t("recorded")),
      make(
        "strong",
        `${quantityText(p.last)}${p.last === null || p.last === undefined ? "" : ` ${t(p.unit) || p.unit}`}`,
      ),
      make("span", `${t("countedAt")}: ${dateText(p.lastCountedAt)}`),
    );
    card.append(recorded);
    const inputs = make("div", undefined, "quantity-grid"),
      d = record.drafts[p.id];
    const zones = d?.zones || p.zones || [],
      expected = zones.length ? zones : ["unassigned"];
    for (const id of expected) {
      const label = make(
          "label",
          `${t("quantity")} · ${zoneName(id)} (${t(p.unit)})`,
        ),
        input = make("input");
      input.type = "text";
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.dataset.zone = id;
      input.value = d?.locations?.[id]?.value ?? "";
      input.addEventListener("input", () =>
        guard(() => {
          const next = editDraft(p, record.drafts[p.id], {
            locations: { [id]: { value: input.value, unit: "BASE" } },
          });
          record.drafts[p.id] = next;
          persist();
          input.removeAttribute("aria-invalid");
        }),
      );
      label.append(input);
      inputs.append(label);
    }
    card.append(inputs);
    const flags = make("div", undefined, "flags");
    for (const key of ["approx", "low"]) {
      const label = make("label", undefined, "check"),
        input = make("input");
      input.type = "checkbox";
      input.checked = Boolean(d ? d[key] : key === "low" ? p.low : false);
      input.addEventListener("change", () =>
        guard(() => {
          record.drafts[p.id] = editDraft(p, record.drafts[p.id], {
            [key]: input.checked,
          });
          persist();
        }),
      );
      label.append(
        input,
        make("span", t(key === "approx" ? "approximate" : "low")),
      );
      flags.append(label);
    }
    card.append(flags);
  } else
    card.append(
      make("p", `${p.category || ""} · ${t(p.unit) || p.unit}`, "help"),
    );
  const actions = make("div", undefined, "actions");
  const status = button(t(p.active ? "deactivate" : "activate"), () =>
    setStatus(p, !p.active),
  );
  status.dataset.serverAction = "true";
  actions.append(status);
  if (page === "catalog") {
    for (const [key, fn] of [
      ["editProduct", () => catalogForm(p)],
      ["deleteProduct", () => deleteProduct(p)],
    ]) {
      const b = button(
        t(key),
        fn,
        key === "deleteProduct" ? "danger" : undefined,
      );
      b.dataset.serverAction = "true";
      actions.append(b);
    }
  }
  card.append(actions);
  let start;
  card.addEventListener("pointerdown", (event) => {
    if (
      !writable() ||
      event.target.closest("input,button,label,select,textarea,a")
    )
      return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
  });
  card.addEventListener("pointercancel", () => (start = null));
  card.addEventListener("pointerup", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 85 && Math.abs(dy) < 30 && dx > 0 !== p.active)
      guard(() => setStatus(p, dx > 0));
  });
  return card;
}
function clearDrafts() {
  if (!confirm(t("clearConfirm"))) return;
  const pendingIds = new Set(
    record.pending?.items?.map((item) => item.id) || [],
  );
  const next = structuredClone(record);
  for (const id of Object.keys(next.drafts))
    if (!pendingIds.has(id)) delete next.drafts[id];
  persist(next);
  record = next;
  render();
  flash("clearDone");
}
function downloadBackup() {
  const content = {
    exportedAt: new Date().toISOString(),
    databaseId: record.snapshot?.databaseId,
    account: config.username,
    endpoint: config.endpoint,
    drafts: record.drafts,
    archivedDrafts: record.archivedDrafts || [],
    pending: record.pending,
    pendingMutation: record.pendingMutation,
    notifications: record.notifications || {},
    notification: record.notification,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }),
  );
  const a = make("a");
  a.href = url;
  a.download = `varka-count-backup-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function modal(title, build, onSubmit, submitLabel = "save") {
  const dialog = $("#workspace-dialog"),
    form = $("#dialog-form");
  opener = document.activeElement;
  form.replaceChildren();
  const heading = make("h2", t(title));
  heading.id = "dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const error = make("p", "", "dialog-error");
  error.setAttribute("role", "alert");
  error.tabIndex = -1;
  form.append(heading, error);
  const fields = make("div", undefined, "form-grid");
  form.append(fields);
  const values = build(fields) || {};
  const actions = make("div", undefined, "actions");
  actions.append(button(t("cancel"), () => dialog.close()));
  const submit = make("button", t(submitLabel), "primary");
  submit.type = "submit";
  actions.append(submit);
  form.append(actions);
  form.onsubmit = (event) => {
    event.preventDefault();
    guard(async () => {
      if (submit.disabled) return;
      error.textContent = "";
      const missing = [...form.querySelectorAll("[required]")].find(
        (el) => !el.value.trim(),
      );
      if (missing) {
        error.textContent = t("INVALID_REQUIRED");
        missing.setAttribute("aria-invalid", "true");
        missing.focus();
        return;
      }
      submit.disabled = true;
      const epoch = generation;
      try {
        await onSubmit(values);
        if (epoch === generation && submit.isConnected) dialog.close();
      } catch (error) {
        if (error?.message !== "STALE_OPERATION") showError(error);
      } finally {
        submit.disabled = false;
      }
    });
  };
  dialog.showModal();
  setTimeout(
    () => form.querySelector("input,select,textarea,button")?.focus(),
    0,
  );
  return dialog;
}
function field(
  root,
  key,
  value = "",
  { type = "text", required = false, options, decimal = false } = {},
) {
  const label = make("label");
  label.append(make("span", t(key)));
  if (required) {
    const marker = make("span", "*");
    marker.setAttribute("aria-hidden", "true");
    label.append(marker);
  }
  const el = make(
    options ? "select" : type === "textarea" ? "textarea" : "input",
  );
  if (options)
    for (const [v, name] of options) {
      const option = make("option", name);
      option.value = v;
      el.append(option);
    }
  else if (type !== "textarea") el.type = type;
  el.name = key;
  el.required = required;
  if (decimal) el.inputMode = "decimal";
  el.value = value ?? "";
  label.append(el);
  root.append(label);
  return el;
}
function confirmSubmission() {
  if (record.pending || record.pendingMutation) throw Error("INVALID_REQUEST");
  if (!writable()) throw Error("SIGN_IN_REQUIRED");
  let preview;
  try {
    preview = buildSubmission(record.snapshot, record.drafts, {
      language,
      scope: "ENTERED",
    });
  } catch (error) {
    showError(error);
    return;
  }
  modal(
    "confirmTitle",
    (root) => {
      const summary = make("div", undefined, "summary");
      for (const [key, value] of [
        ["entered", preview.summary.entered],
        ["uncounted", preview.summary.uncounted],
        ["lowTotal", preview.summary.low],
        ["inactiveTotal", preview.summary.inactive],
      ]) {
        const box = make("div");
        box.append(make("strong", value), make("span", t(key)));
        summary.append(box);
      }
      root.append(summary);
      const list = make("ul", undefined, "confirmation-list");
      for (const item of preview.items) {
        const p = record.snapshot.products.find((p) => p.id === item.id);
        const state = draftState(p, record.drafts[item.id]);
        list.append(
          make(
            "li",
            `${productName(p)}: ${quantityText(state.totalValue)} ${t(p.unit)}${p.active ? "" : ` · ${t("inactive")}`}`,
          ),
        );
      }
      if (!preview.items.length) root.append(make("p", t("noEntries"), "help"));
      else root.append(list);
      const scopes = make("fieldset"),
        legend = make("legend", t("scope"));
      scopes.append(legend);
      for (const [value, key] of [
        ["ALL", "entireList"],
        ["ENTERED", "enteredOnly"],
        ["LOW", "lowOnly"],
      ]) {
        const label = make("label", undefined, "check"),
          input = make("input");
        input.type = "radio";
        input.name = "scope";
        input.value = value;
        input.checked = value === "ENTERED";
        label.append(input, make("span", t(key)));
        scopes.append(label);
      }
      root.append(scopes, make("p", t("scopeHelp"), "help"));
      return { scopes };
    },
    async ({ scopes }) => {
      const scope = scopes.querySelector("input:checked").value;
      const request = buildSubmission(record.snapshot, record.drafts, {
        id: crypto.randomUUID(),
        language,
        scope,
      });
      record.pending = structuredClone(request);
      persist();
      $("#workspace-dialog").close();
      await submitCount();
    },
    "send",
  );
}
async function submitCount() {
  if (submitting) return;
  const epoch = generation,
    key = recordKey();
  submitting = true;
  controls();
  flash("saving");
  try {
    const request = structuredClone(record.pending);
    const result = await rpc("workspaceCount", request);
    if (epoch !== generation || key !== recordKey())
      throw Error("STALE_OPERATION");
    if ((result?.state || result?.status) !== "COMMITTED") {
      flash("uncertain", {}, true);
      return;
    }
    const candidate = applyAcknowledgment(record, result, request);
    candidate.notification = { ...result.notification, id: request.id };
    candidate.notifications ||= {};
    if (record.notification?.id)
      candidate.notifications[record.notification.id] = record.notification;
    candidate.notifications[request.id] = candidate.notification;
    for (const [id, notification] of Object.entries(candidate.notifications))
      if (
        id !== request.id &&
        !["READY", "FAILED", "UNKNOWN"].includes(notification.status)
      )
        delete candidate.notifications[id];
    for (const conflict of result.conflicted || []) {
      const original = request.items.find((item) => item.id === conflict.id),
        index = candidate.snapshot.products.findIndex(
          (p) => p.id === conflict.id,
        ),
        current = candidate.snapshot.products[index];
      const unchanged =
        current &&
        original &&
        current.stockVersion === original.stockVersion &&
        current.countVersion === original.countVersion &&
        current.catalogVersion === original.catalogVersion;
      if (conflict.current && unchanged)
        candidate.snapshot.products[index] = structuredClone(conflict.current);
      else if (conflict.error === "PRODUCT_DELETED" && unchanged)
        candidate.snapshot.products = candidate.snapshot.products.filter(
          (p) => p.id !== conflict.id,
        );
    }
    persist(candidate);
    record = candidate;
    snapshotEpoch++;
    render();
    flash(
      result.failed?.length || result.conflicted?.length ? "partial" : "saved",
      {},
      Boolean(result.failed?.length || result.conflicted?.length),
    );
    if (record.notification.status === "READY") await notify(request.id);
  } finally {
    if (epoch === generation) {
      submitting = false;
      controls();
    }
  }
}
async function notify(id = record.notification?.id, checkOnly = false) {
  const current =
    record.notifications?.[id] ||
    (record.notification?.id === id ? record.notification : null);
  if (
    !current ||
    notifying.has(id) ||
    (!checkOnly && !["READY", "FAILED"].includes(current.status))
  )
    return;
  const epoch = generation,
    key = recordKey();
  notifying.add(id);
  try {
    const response = await rpc(
      checkOnly ? "workspaceStatus" : "workspaceNotify",
      { id },
    );
    if (epoch !== generation || key !== recordKey()) return;
    const result = checkOnly ? response.result?.notification : response;
    if (!result) return;
    record.notifications ||= {};
    record.notifications[id] = { ...result, id };
    if (record.notification?.id === id)
      record.notification = record.notifications[id];
    persist();
  } catch (error) {
    if (epoch !== generation || key !== recordKey()) return;
    if (!checkOnly) {
      record.notifications ||= {};
      record.notifications[id] = { ...current, status: "UNKNOWN" };
      if (record.notification?.id === id)
        record.notification = record.notifications[id];
      persist();
    } else showError(error);
  } finally {
    notifying.delete(id);
    if (epoch === generation) {
      renderNotification();
      controls();
    }
  }
}
function renderNotification() {
  const panel = $("#notification-panel");
  const all = { ...(record.notifications || {}) };
  if (record.notification?.id)
    all[record.notification.id] = record.notification;
  const list = Object.values(all).filter(
    (n) =>
      n.id === record.notification?.id ||
      ["READY", "FAILED", "UNKNOWN"].includes(n.status),
  );
  panel.hidden = !list.length;
  if (!list.length) return;
  panel.replaceChildren(make("h2", t("notification")));
  for (const notification of list) {
    const section = make("section");
    const key =
      {
        READY: "telegramReady",
        SENT: "telegramSent",
        FAILED: "telegramFailed",
        UNKNOWN: "telegramUnknown",
        NOT_CONFIGURED: "telegramMissing",
        EMPTY: "telegramEmpty",
      }[notification.status] || "telegramUnknown";
    section.append(make("p", t(key)));
    if (["READY", "FAILED", "UNKNOWN"].includes(notification.status)) {
      const check = notification.status === "UNKNOWN";
      const b = button(t(check ? "checkDelivery" : "retryNotification"), () =>
        notify(notification.id, check),
      );
      b.dataset.serverAction = "true";
      section.append(b);
    }
    panel.append(section);
  }
}
async function retryPending() {
  if (record.pending) await submitCount();
  else if (record.pendingMutation) {
    await sendMutation();
    await refresh();
    render();
  }
}
function reviewConflict(change) {
  modal(
    "conflictTitle",
    (root) => {
      root.append(
        make("p", productName(change.product || { id: change.id })),
        make("p", t(change.reason), "error"),
        make("p", t(change.product ? "conflictHelp" : "deletedDraft")),
      );
      const list = make("ul");
      for (const [zone, input] of Object.entries(change.draft?.locations || {}))
        list.append(
          make(
            "li",
            `${zoneName(zone)}: ${input.value === "" ? t("notCounted") : input.value}`,
          ),
        );
      root.append(list);
      root.append(button(t("backup"), downloadBackup));
      return {};
    },
    () => {
      if (!change.product) {
        record.archivedDrafts ||= [];
        record.archivedDrafts.push({
          id: change.id,
          draft: structuredClone(change.draft),
          archivedAt: new Date().toISOString(),
        });
        delete record.drafts[change.id];
        persist();
        render();
        return;
      }
      const old = record.drafts[change.id];
      let next = createDraft(change.product);
      next.approx = old.approx;
      next.low = old.low;
      if (change.product.unit === old.unit) {
        for (const zone of next.zones.length ? next.zones : ["unassigned"])
          if (old.locations?.[zone])
            next.locations[zone] = structuredClone(old.locations[zone]);
      }
      record.drafts[change.id] = next;
      persist();
      render();
      flash("conflictResolved");
    },
    change.product ? "useReviewed" : "archiveDeleted",
  );
}
async function mutation(method, body) {
  if (!writable()) throw Error("SIGN_IN_REQUIRED");
  if (record.pending || record.pendingMutation) throw Error("INVALID_REQUEST");
  record.pendingMutation = {
    method,
    body: { ...body, id: crypto.randomUUID() },
  };
  persist();
  return sendMutation();
}
async function sendMutation() {
  if (mutating) return;
  const epoch = generation,
    key = recordKey();
  mutating = true;
  controls();
  const request = record.pendingMutation;
  try {
    const result = await rpc(request.method, request.body);
    if (epoch !== generation || key !== recordKey())
      throw Error("STALE_OPERATION");
    if (
      ["UNKNOWN", "PENDING", "PREPARED"].includes(
        result?.state || result?.status,
      )
    )
      throw Error("Connection interrupted");
    record.pendingMutation = null;
    persist();
    snapshotEpoch++;
    return result;
  } catch (error) {
    if (epoch !== generation || key !== recordKey())
      throw Error("STALE_OPERATION");
    const rejected =
      /^(INVALID_|EXISTING_CATEGORY_REQUIRED|UNIT_HAS_HISTORY|PRODUCT_NAME_EXISTS|PRODUCT_DELETED|CATALOG_CONFLICT$|CONFLICT$|CARD_EXISTS|OWNER_ONLY|PWA_READ_ONLY|SIGN_IN_REQUIRED)/.test(
        String(error.message),
      );
    if (rejected) {
      record.pendingMutation = null;
      persist();
    }
    throw error;
  } finally {
    if (epoch === generation) {
      mutating = false;
      controls();
    }
  }
}
async function setStatus(p, active) {
  if (active === p.active) return;
  flash("statusPending");
  const result = await mutation("workspaceCatalog", {
    action: "status",
    product: { id: p.id, catalogVersion: p.catalogVersion, active },
  });
  await refresh();
  undoAction = {
    id: p.id,
    active: p.active,
    version: result?.product?.catalogVersion,
  };
  const panel = $("#undo-panel");
  panel.hidden = false;
  panel.replaceChildren(
    button(t("undo"), async () => {
      const current = record.snapshot.products.find(
        (x) => x.id === undoAction.id,
      );
      if (current) await setStatus(current, undoAction.active);
      panel.hidden = true;
    }),
  );
  flash("statusDone");
}
async function completeMutation(message) {
  $("#workspace-dialog").close();
  try {
    await refresh();
    flash(message);
  } catch (error) {
    if (error?.message === "STALE_OPERATION") throw error;
    flash("savedRefreshFailed", {}, true);
  }
}
function catalogForm(p) {
  modal(
    p ? "editProduct" : "addProduct",
    (root) => {
      root.append(make("p", t("required"), "help"));
      const values = {};
      values.ru = field(root, "name", p?.ru || "", { required: true });
      values.en = field(root, "englishName", p?.en || "");
      values.category = field(
        root,
        "category",
        p?.category || record.snapshot.categories?.[0] || "",
        {
          required: true,
          options: (record.snapshot.categories || []).map((c) => [c, c]),
        },
      );
      values.unit = field(root, "unit", p?.unit || "pcs", {
        options: ["pcs", "l", "kg", "pack", "roll"].map((v) => [v, t(v)]),
      });
      values.minimum = field(root, "minimum", p?.minimum ?? "", {
        decimal: true,
      });
      const zones = make("fieldset");
      zones.append(make("legend", t("locations")));
      values.zones = [];
      for (const z of record.snapshot.zones || []) {
        const label = make("label", undefined, "check"),
          input = make("input");
        input.type = "checkbox";
        input.value = z.id;
        input.checked = p?.zones?.includes(z.id) || false;
        label.append(input, make("span", zoneName(z.id)));
        zones.append(label);
        values.zones.push(input);
      }
      root.append(zones);
      values.reminder = field(
        root,
        "reminder",
        p?.reminderHours === null ? "off" : "interval",
        {
          options: [
            ["off", t("off")],
            ["interval", t("interval")],
          ],
        },
      );
      values.interval = field(root, "interval", p?.reminderHours ?? 24, {
        decimal: true,
      });
      values.timeUnit = field(root, "timeUnit", "hours", {
        options: [
          ["hours", t("hours")],
          ["days", t("days")],
        ],
      });
      const reminderControls = () => {
        const off = values.reminder.value === "off";
        values.interval.disabled = off;
        values.timeUnit.disabled = off;
      };
      values.reminder.addEventListener("change", reminderControls);
      reminderControls();
      root.append(make("p", t("reminderHelp"), "help"));
      const label = make("label", undefined, "check");
      values.active = make("input");
      values.active.type = "checkbox";
      values.active.checked = p ? p.active : true;
      label.append(values.active, make("span", t("active")));
      root.append(label);
      return values;
    },
    async (v) => {
      const zones = v.zones.filter((x) => x.checked).map((x) => x.value);
      if (!zones.length) throw Error("INVALID_PRODUCT");
      const parsedMinimum =
        v.minimum.value.trim() === ""
          ? null
          : quantityInput(v.minimum.value, v.unit.value);
      const minimum =
        parsedMinimum === null ? null : Number(parsedMinimum.value);
      if (
        parsedMinimum &&
        BigInt(Math.round(minimum * 1e8)) !== parsedMinimum.scaled
      )
        throw Error("INVALID_QUANTITY");
      const interval =
        Number(v.interval.value.replace(",", ".")) *
        (v.timeUnit.value === "days" ? 24 : 1);
      if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0))
        throw Error("INVALID_QUANTITY");
      if (
        v.reminder.value !== "off" &&
        (!Number.isFinite(interval) || interval <= 0)
      )
        throw Error("INVALID_INTERVAL");
      await mutation("workspaceCatalog", {
        action: "save",
        product: {
          ...(p ? { id: p.id, catalogVersion: p.catalogVersion } : {}),
          ru: v.ru.value.trim(),
          en: v.en.value.trim(),
          category: v.category.value.trim(),
          unit: v.unit.value,
          zones,
          minimum,
          reminderHours: v.reminder.value === "off" ? null : interval,
          active: v.active.checked,
        },
      });
      await completeMutation("productSaved");
    },
  );
}
async function deleteProduct(p) {
  if (!confirm(t("confirmDelete", { name: productName(p) }))) return;
  await mutation("workspaceCatalog", {
    action: "delete",
    product: { id: p.id, catalogVersion: p.catalogVersion },
  });
  await refresh();
  flash("productDeleted");
}
function renderTeam(root) {
  const notes = make("section", undefined, "panel");
  notes.append(make("h2", t("notes")));
  const add = button(t("addNote"), () =>
    modal(
      "addNote",
      (root) => ({
        text: field(root, "noteContent", "", {
          type: "textarea",
          required: true,
        }),
      }),
      async (v) => {
        await mutation("workspaceTeam", { kind: "note", text: v.text.value });
        await completeMutation("noteSaved");
      },
    ),
  );
  add.dataset.serverAction = "true";
  notes.append(add);
  if (!record.snapshot.notes?.length)
    notes.append(make("p", t("noNotes"), "help"));
  for (const n of record.snapshot.notes || []) {
    const note = make("article", undefined, "note");
    note.append(
      make("p", n.text || n.content || ""),
      make(
        "p",
        `${n.authorName || n.by || t("noAuthor")} · ${dateText(n.created || n.timestamp)}`,
        "help",
      ),
    );
    notes.append(note);
  }
  root.append(notes);
  const cards = make("section", undefined, "panel");
  cards.append(make("h2", t("yellowCards")));
  const addCard = button(t("addCard"), cardForm);
  addCard.dataset.serverAction = "true";
  cards.append(addCard);
  for (const section of ["A", "C", "D", "otherCards"]) {
    cards.append(make("h3", section === "otherCards" ? t(section) : section));
    const list = (record.snapshot.cards || []).filter((c) => {
      const prefix = String(c.id || c.code || "")
        .toUpperCase()
        .slice(0, 1);
      return section === "otherCards"
        ? !["A", "C", "D"].includes(prefix)
        : prefix === section;
    });
    if (!list.length) cards.append(make("p", t("noCards"), "help"));
    for (const c of list) {
      const card = make("article", undefined, "note");
      card.append(make("strong", c.id || c.code), make("p", c.name));
      for (const value of [c.size, c.category, c.note])
        if (value) card.append(make("p", value));
      cards.append(card);
    }
  }
  root.append(cards);
}
function cardForm() {
  modal(
    "addCard",
    (root) => ({
      code: field(root, "cardCode", "", { required: true }),
      name: field(root, "cardName", "", { required: true }),
      size: field(root, "size"),
      category: field(root, "cardCategory", "", { required: true }),
      note: field(root, "cardNote", "", { type: "textarea" }),
    }),
    async (v) => {
      await mutation("workspaceTeam", {
        kind: "card",
        code: v.code.value,
        name: v.name.value,
        size: v.size.value,
        category: v.category.value,
        note: v.note.value,
      });
      await completeMutation("cardSaved");
    },
  );
}
function renderProfile(root) {
  const profile = record.snapshot.profile || {},
    panel = make("section", undefined, "panel");
  panel.append(
    make("p", `${t("name")}: ${profile.name || t("noName")}`),
    make("p", `${t("email")}: ${profile.email || config.username}`),
    languageSelect("profile-language"),
  );
  panel.append(
    make(
      "p",
      t(
        record.snapshot.reminders?.configured
          ? "remindersConfigured"
          : "remindersMissing",
      ),
      "help",
    ),
    make("p", t("reminderHelp"), "help"),
    make("p", `${t("lastSync")}: ${dateText(record.loadedAt)}`, "help"),
    make("p", t("logoutHelp"), "help"),
  );
  panel.append(
    button(t("backup"), downloadBackup),
    button(t("logout"), logout),
  );
  root.append(panel);
  const old = read(`varka-google:${config.endpoint}:${config.username}`);
  if (
    old &&
    (Object.keys(old.drafts || {}).length || old.pending || old.recoveryPending)
  ) {
    const legacy = make("section", undefined, "panel"),
      link = make("a", t("legacyLink"));
    link.href = "./legacy.html";
    legacy.append(make("p", t("legacy")), link);
    root.append(legacy);
  }
}
async function logout() {
  if (!confirm(t("confirmLogout"))) return;
  ++generation;
  const previousTransport = transport,
    previousToken = token;
  transport = null;
  token = null;
  authenticated = false;
  loading = false;
  submitting = false;
  mutating = false;
  loginOpen = false;
  record = {
    snapshot: null,
    drafts: {},
    pending: null,
    pendingMutation: null,
    notification: null,
  };
  page = "stock";
  $("#workspace-dialog").close();
  flash("disconnected");
  controls();
  if (previousTransport) {
    previousTransport
      .call("logout", {}, previousToken)
      .catch(() => {})
      .finally(() => previousTransport.destroy());
  }
}
window.addEventListener("online", () => {
  controls();
});
window.addEventListener("offline", () => {
  controls();
});
let fullViewportHeight = window.innerHeight;
function keyboardLayout() {
  const active = document.activeElement,
    editing = active?.matches(
      "input:not([type=checkbox]):not([type=radio]),textarea",
    );
  if (!editing)
    fullViewportHeight = Math.max(fullViewportHeight, window.innerHeight);
  const visible = window.visualViewport?.height || window.innerHeight;
  const keyboard =
    editing &&
    matchMedia("(max-width:700px)").matches &&
    (visible < fullViewportHeight * 0.75 ||
      window.innerHeight < fullViewportHeight * 0.75);
  document.body.classList.toggle("keyboard-open", Boolean(keyboard));
}
window.visualViewport?.addEventListener("resize", keyboardLayout);
window.addEventListener("resize", keyboardLayout);
document.addEventListener("focusin", keyboardLayout);
document.addEventListener("focusout", () => setTimeout(keyboardLayout, 0));
if ("ResizeObserver" in window) {
  const observer = new ResizeObserver(() => {
    const height =
      $("#navigation").getBoundingClientRect().height +
      $("#count-bar").getBoundingClientRect().height;
    document.body.style.setProperty("--workspace-bottom", `${height}px`);
  });
  observer.observe($("#navigation"));
  observer.observe($("#count-bar"));
}
setLanguage(language);
controls();
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("./sw.js").catch(() => {});
