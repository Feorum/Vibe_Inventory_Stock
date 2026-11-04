import { GoogleTransport, deploymentUrl } from "./transport.js";
import { DEFAULT_APPS_SCRIPT_URL } from "./deployment-config.js";
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
  countingProgress,
  validateCountDateFilter,
  countDateKey,
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
const teamViews = new Map();
const stockDetails = new Map();
const pagePositions = new Map();
const freshDeliveries = new Map();
let messageTimer;
let dialogPosition;
let layoutObserver;
let updateStockProgress = () => {};
const stockFilterDefaults = () => ({
  search: "",
  zone: "",
  category: "",
  onlyUnchecked: false,
  lastCounted: "ALL",
  dateFrom: "",
  dateTo: "",
  sort: "NAME",
});
const filters = {
  stock: stockFilterDefaults(),
  catalog: { search: "", zone: "", category: "" },
};
const t = (key, values) => translate(language, key, values);
const make = (tag, value, className) => {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = value;
  if (className) el.className = className;
  return el;
};
const tipsEnabled = () => record.preferences?.tips === true;
function tip(key, className = "help") {
  const element = make("p", t(key), className);
  element.dataset.tip = "true";
  element.hidden = !tipsEnabled();
  return element;
}
function applyTips() {
  document.body.classList.toggle("tips-enabled", tipsEnabled());
  for (const element of document.querySelectorAll("[data-tip]"))
    element.hidden = !tipsEnabled();
}
function teamView() {
  const key = recordKey();
  if (!teamViews.has(key))
    teamViews.set(key, { tab: "notes", search: "", groups: {}, rows: {} });
  return teamViews.get(key);
}
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
function dateText(value, short = false) {
  try {
    if (!countDateKey(value, cafeTimeZone())) return t("notCounted");
    return new Intl.DateTimeFormat(
      language,
      short
        ? { day: "numeric", month: "short", timeZone: cafeTimeZone() }
        : { dateStyle: "medium", timeStyle: "short", timeZone: cafeTimeZone() },
    ).format(new Date(value));
  } catch {
    return t("INVALID_TIME_ZONE");
  }
}
const cafeTimeZone = () => record.snapshot?.timeZone || "Europe/Minsk";
const dateFilterKeys = {
  ALL: "dateAll",
  TODAY: "dateToday",
  YESTERDAY: "dateYesterday",
  DAYS_7: "dateDays7",
  DAYS_30: "dateDays30",
  NEVER: "dateNever",
  RANGE: "dateRange",
};
const sortKeys = {
  NAME: "sortName",
  OLDEST: "sortOldest",
  NEWEST: "sortNewest",
};
function dateFilterText(filter) {
  if (filter.lastCounted !== "RANGE")
    return t(dateFilterKeys[filter.lastCounted] || "dateAll");
  const display = (day) =>
    new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(`${day}T00:00:00Z`));
  return `${t("dateRange")}: ${display(filter.dateFrom)} – ${display(filter.dateTo)}`;
}
const writable = () =>
  authenticated &&
  navigator.onLine &&
  record.snapshot?.permissions?.write !== false &&
  storageOkay;
const recordKey = () =>
  storageKey(record.snapshot.databaseId, config.username, config.endpoint);
const pointerKey = () =>
  `varka-workspace:last:${config.endpoint}:${String(config.username || "").toLowerCase()}`;
function announceDelivery(id) {
  const key = recordKey();
  const noticeKey = `${key}:${id}`;
  const expires = Date.now() + 10000;
  const epoch = generation;
  freshDeliveries.set(noticeKey, expires);
  setTimeout(() => {
    if (freshDeliveries.get(noticeKey) === expires)
      freshDeliveries.delete(noticeKey);
    if (epoch === generation && record.snapshot && recordKey() === key)
      renderNotification();
  }, 10000);
}
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
function clearMessage() {
  clearTimeout(messageTimer);
  lastMessage = null;
  $("#message").replaceChildren();
  $("#message").classList.remove("error");
}
function flash(key, values = {}, error = false) {
  clearTimeout(messageTimer);
  lastMessage = { key, values, error };
  const el = $("#message");
  el.replaceChildren(make("span", t(key, values)));
  el.classList.toggle("error", error);
  el.setAttribute("role", error ? "alert" : "status");
  const transient =
    !error &&
    [
      "saved",
      "noCountsSaved",
      "refreshed",
      "clearDone",
      "productSaved",
      "unitChangeSaved",
      "productDeleted",
      "statusDone",
      "noteSaved",
      "cardSaved",
      "conflictResolved",
    ].includes(key);
  const dismiss = clearMessage;
  if (transient || error) {
    const dismissButton = button("×", dismiss, "message-dismiss");
    dismissButton.setAttribute("aria-label", t("dismissMessage"));
    dismissButton.title = t("dismissMessage");
    el.append(dismissButton);
  }
  if (transient) messageTimer = setTimeout(dismiss, 10000);
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
  for (const el of root.querySelectorAll("[data-i18n-label]"))
    el.setAttribute("aria-label", t(el.dataset.i18nLabel));
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
$("#count-bar").classList.add("compact-count-bar");
$("#count-bar").setAttribute("role", "region");
$("#count-bar").dataset.i18nLabel = "stock";
const dockContent = $("#count-bar > div");
dockContent.classList.add("stock-dock-content");
const countProgress = make("span");
countProgress.id = "count-progress";
countProgress.setAttribute("role", "status");
const dockAction = make("div");
dockAction.id = "stock-dock-action";
dockAction.append($("#synchronize-quantity"));
dockContent.prepend(countProgress);
dockContent.append(dockAction);
$("#count-bar").append($("#count-bar [data-i18n=draftNotice]"));
$("#count-bar [data-i18n=draftNotice]").dataset.tip = "true";
$("#synchronize-quantity").dataset.i18n = "saveCountCompact";
$("#synchronize-quantity").dataset.i18nLabel = "syncQuantity";
$("#refresh").dataset.i18n = "refreshCompact";
$("#refresh").dataset.i18nLabel = "refresh";
$("#main").tabIndex = -1;
$("#connect-form").noValidate = true;
$("#username").value = config.username || "";
// A release default helps new devices; never switch a saved database connection
// or its endpoint/account-scoped drafts automatically.
$("#endpoint").value = config.endpoint || DEFAULT_APPS_SCRIPT_URL;
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
  $("#workspace-dialog").classList.remove(
    "bottom-sheet",
    "recount-menu-dialog",
  );
  delete $("#workspace-dialog").dataset.kind;
  const restoredOpener = opener?.isConnected
    ? opener
    : opener?.id
      ? document.getElementById(opener.id)
      : null;
  if (restoredOpener && !restoredOpener.disabled)
    restoredOpener.focus({ preventScroll: true });
  else $("#view-heading")?.focus({ preventScroll: true });
  const position = dialogPosition;
  if (position && position.generation === generation && position.page === page)
    requestAnimationFrame(() => {
      if (
        position.generation === generation &&
        position.page === page &&
        !$("#workspace-dialog").open
      )
        window.scrollTo({ top: position.y, left: position.x });
    });
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
  applyTips();
  if (record.snapshot && page === "stock") updateStockProgress(false);
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
  for (const el of document.querySelectorAll("[data-telegram-action]")) {
    const status = record.snapshot?.telegram;
    const latest = record.telegramTests?.[record.telegramTestId];
    const checking = el.dataset.telegramAction === "check";
    const testBusy = latest && notifying.has(`telegram-test:${latest.id}`);
    if (checking) {
      el.disabled =
        !authenticated || !navigator.onLine || !status?.canTest || testBusy;
    } else {
      el.disabled ||=
        !status?.canTest ||
        !status?.configured ||
        status.writesEnabled === false ||
        testBusy ||
        (el.dataset.telegramAction === "new" &&
          latest &&
          latest.status !== "SENT");
    }
  }
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
  flash("savedInventoryOpened");
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
  updateStockProgress = () => {};
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
      pagePositions.set(`${recordKey()}:${page}`, window.scrollY);
      page = id;
      render();
      $("#view-heading").focus({ preventScroll: true });
      window.scrollTo({
        top: pagePositions.get(`${recordKey()}:${page}`) || 0,
      });
    });
    b.dataset.view = id;
    if (page === id) b.setAttribute("aria-current", "page");
    nav.append(b);
  }
  const root = $("#page-content");
  root.replaceChildren();
  if (page === "stock") renderStockProducts(root);
  else if (page === "catalog") renderProducts(root);
  else if (page === "team") renderTeam(root);
  else renderProfile(root);
  renderNotification();
  controls();
  observeLayout();
}
function renderStockProducts(root) {
  const current = filters.stock;
  const all = (record.snapshot.products || []).filter(
    (product) => !product.deleted,
  );
  const searchRow = make("div", undefined, "stock-search-row");
  const searchLabel = make("label", t("search"), "filter-search");
  const search = make("input");
  search.type = "search";
  search.value = current.search;
  searchLabel.append(search);
  const filterButton = button(t("filtersButton"), openStockFilters);
  filterButton.id = "stock-filter-button";
  const recount = button("⋯", openRecountMenu, "recount-menu-button");
  recount.id = "recount-menu";
  recount.setAttribute("aria-label", t("recountMenu"));
  recount.title = t("recountMenu");
  searchRow.append(searchLabel, filterButton, recount);
  root.append(searchRow);
  const chips = make("div", undefined, "selected-stock-filters");
  chips.id = "selected-stock-filters";
  root.append(chips);
  const progressRow = make("div", undefined, "stock-progress-row");
  const uncheckedLabel = make("label", undefined, "check unchecked-control");
  const unchecked = make("input");
  unchecked.type = "checkbox";
  unchecked.id = "stock-only-unchecked";
  unchecked.checked = Boolean(current.onlyUnchecked);
  uncheckedLabel.append(unchecked, make("span", t("onlyUnchecked")));
  const draftHelp = make("small", t("currentDraftHelp"), "draft-filter-help");
  draftHelp.id = "current-draft-help";
  unchecked.setAttribute("aria-describedby", draftHelp.id);
  progressRow.append(uncheckedLabel, draftHelp);
  root.append(progressRow, tip("countHelp"));
  const result = make("p", undefined, "help filter-results");
  root.append(result);
  const conflictBox = make("section", undefined, "panel");
  root.append(conflictBox);
  const cards = make("div", undefined, "product-list stock-product-list");
  root.append(cards);
  function updateChips() {
    chips.replaceChildren();
    for (const [key, value] of [
      ["zone", current.zone ? zoneName(current.zone) : ""],
      ["category", current.category],
      [
        "lastCounted",
        current.lastCounted !== "ALL"
          ? `${t("lastCountedFilter")}: ${dateFilterText(current)}`
          : "",
      ],
      [
        "sort",
        current.sort !== "NAME" ? t(sortKeys[current.sort] || "sortName") : "",
      ],
    ]) {
      if (!value) continue;
      const chip = button(
        `${value} ×`,
        () => {
          if (key === "lastCounted") {
            current.lastCounted = "ALL";
            current.dateFrom = current.dateTo = "";
          } else current[key] = key === "sort" ? "NAME" : "";
          list();
          filterButton.focus({ preventScroll: true });
        },
        "filter-chip",
      );
      chip.dataset.filter = key;
      chip.setAttribute("aria-label", t("removeFilter", { filter: value }));
      chips.append(chip);
    }
    chips.hidden = !chips.childElementCount;
  }
  updateStockProgress = (applyVisibility = false) => {
    const progress = countingProgress(record.snapshot, record.drafts);
    const text = t("countProgress", progress);
    if ($("#count-progress").textContent !== text)
      $("#count-progress").textContent = text;
    if (applyVisibility && current.onlyUnchecked) {
      const remaining = new Set(progress.uncheckedIds);
      const activeCard = document.activeElement?.closest(".product-card");
      for (const card of cards.querySelectorAll(".product-card"))
        card.hidden =
          !remaining.has(card.dataset.productId) && card !== activeCard;
    }
    const shown = [...cards.querySelectorAll(".product-card")].filter(
      (card) => !card.hidden,
    ).length;
    let empty = cards.querySelector(".stock-empty");
    if (!empty) {
      empty = make("section", undefined, "panel stock-empty");
      empty.append(
        make("p", t(all.length ? "noFilteredProducts" : "emptyCatalog")),
      );
      if (all.length)
        empty.append(
          button(t("resetFilters"), () => {
            Object.assign(current, stockFilterDefaults());
            list();
            search.focus({ preventScroll: true });
          }),
        );
      cards.append(empty);
    }
    empty.hidden = shown > 0;
    result.textContent = t("filtersResult", { shown, total: all.length });
  };
  function list() {
    search.value = current.search;
    unchecked.checked = Boolean(current.onlyUnchecked);
    const changes = conflicts(record.snapshot, record.drafts);
    const uncheckedIds = new Set(
      countingProgress(record.snapshot, record.drafts).uncheckedIds,
    );
    let visible = [];
    let filterError;
    try {
      visible = filterProducts(all, current, {
        timeZone: cafeTimeZone(),
        language,
      }).filter(
        (product) => !current.onlyUnchecked || uncheckedIds.has(product.id),
      );
    } catch (error) {
      filterError = error;
    }
    cards.replaceChildren();
    if (filterError) cards.append(make("p", t(errorKey(filterError)), "error"));
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
      const product = all.find((product) => product.id === item.id);
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
    for (const product of visible)
      cards.append(
        productCard(
          product,
          changes.some((change) => change.id === product.id),
        ),
      );
    updateChips();
    updateStockProgress();
    controls();
  }
  unchecked.addEventListener("change", () => {
    current.onlyUnchecked = unchecked.checked;
    list();
  });
  search.addEventListener("input", () => {
    current.search = search.value;
    list();
  });
  list();
}
function openStockFilters() {
  const previousScroll = window.scrollY;
  const current = filters.stock;
  let resetAll = false;
  const dialog = modal(
    "filtersButton",
    (root) => {
      const zones = [
        ["", t("allLocations")],
        ...(record.snapshot.zones || []).map((zone) => [
          zone.id,
          zoneName(zone.id),
        ]),
      ];
      if (
        (record.snapshot.products || []).some(
          (product) => !product.deleted && !product.zones?.length,
        )
      )
        zones.push(["unassigned", t("unassigned")]);
      const catalogCategories = record.snapshot.categories || [
        ...new Set(
          (record.snapshot.products || [])
            .filter((product) => !product.deleted)
            .map((product) => product.category),
        ),
      ];
      const categories = [
        ["", t("allCategories")],
        ...catalogCategories.map((category) =>
          typeof category === "string"
            ? [category, category]
            : [category.id, category.name || category.id],
        ),
      ];
      const location = field(root, "location", current.zone, {
        options: zones,
      });
      const category = field(root, "category", current.category, {
        options: categories,
      });
      const lastCounted = field(
        root,
        "lastCountedFilter",
        current.lastCounted,
        {
          options: Object.entries(dateFilterKeys).map(([value, key]) => [
            value,
            t(key),
          ]),
        },
      );
      lastCounted.name = "lastCounted";
      const range = make("div", undefined, "date-range-fields");
      const dateFrom = field(range, "dateFrom", current.dateFrom, {
        type: "date",
      });
      const dateTo = field(range, "dateTo", current.dateTo, { type: "date" });
      root.append(range);
      const updateRange = () => {
        range.hidden = lastCounted.value !== "RANGE";
        dateFrom.disabled = dateTo.disabled = range.hidden;
      };
      lastCounted.addEventListener("change", updateRange);
      updateRange();
      const sort = field(root, "sortProducts", current.sort, {
        options: [
          ["OLDEST", t("sortOldest")],
          ["NEWEST", t("sortNewest")],
          ["NAME", t("sortName")],
        ],
      });
      sort.name = "sort";
      root.append(
        make("p", t("historicalDateHelp"), "help historical-date-help"),
      );
      root.append(
        make("p", t("cafeTimeZone", { timeZone: cafeTimeZone() }), "help"),
      );
      if (!record.snapshot.timeZone)
        root.append(make("p", t("cafeTimeZoneFallback"), "help"));
      root.append(
        button(t("resetFilters"), () => {
          location.value = "";
          category.value = "";
          lastCounted.value = "ALL";
          dateFrom.value = dateTo.value = "";
          sort.value = "NAME";
          updateRange();
          resetAll = true;
        }),
      );
      return { location, category, lastCounted, dateFrom, dateTo, sort };
    },
    ({ location, category, lastCounted, dateFrom, dateTo, sort }) => {
      const next = {
        ...current,
        zone: location.value,
        category: category.value,
        lastCounted: lastCounted.value,
        dateFrom: dateFrom.value,
        dateTo: dateTo.value,
        sort: sort.value,
      };
      for (const field of [dateFrom, dateTo])
        field.removeAttribute("aria-invalid");
      try {
        validateCountDateFilter(next);
      } catch (error) {
        for (const field of [dateFrom, dateTo])
          field.setAttribute("aria-invalid", "true");
        throw error;
      }
      try {
        new Intl.DateTimeFormat(language, { timeZone: cafeTimeZone() });
      } catch {
        throw Error("INVALID_TIME_ZONE");
      }
      Object.assign(current, next);
      if (
        ["INVALID_DATE_RANGE", "INVALID_TIME_ZONE"].includes(lastMessage?.key)
      )
        clearMessage();
      if (resetAll) {
        current.search = "";
        current.onlyUnchecked = false;
      }
      // A refresh may have replaced the underlying list while this sheet was
      // open. Render the current screen rather than updating a detached closure.
      render();
      window.scrollTo({ top: previousScroll });
    },
    "applyFilters",
  );
  dialog.dataset.kind = "filters";
  dialog.classList.add("bottom-sheet");
}
function openRecountMenu() {
  const dialog = modal(
    "recountMenu",
    (root) => {
      root.append(
        button(t("backup"), () => {
          downloadBackup();
          dialog.close();
        }),
      );
      root.append(
        button(
          t("clear"),
          () => {
            clearDrafts();
            dialog.close();
          },
          "danger",
        ),
      );
    },
    () => {},
    "close",
  );
  dialog.dataset.kind = "recount";
  dialog.classList.add("recount-menu-dialog");
  dialog.querySelector("#dialog-form > .actions > button[type=button]").hidden =
    true;
}
function renderProducts(root) {
  const current = filters.catalog,
    all = (record.snapshot.products || []).filter(
      (product) => !product.deleted,
    );
  const filter = make("section", undefined, "panel filters workspace-filters");
  filter.id = "workspace-filters";
  const searchLabel = make("label", t("search"), "filter-search"),
    search = make("input");
  search.type = "search";
  search.value = current.search;
  searchLabel.append(search);
  filter.append(searchLabel);
  const selectFilter = (key, title, options, allLabel) => {
    const label = make("label", t(title), `filter-${key}`),
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
  const reset = button(t("resetFilters"), () => {
    filters.catalog = { search: "", zone: "", category: "" };
    render();
  });
  reset.setAttribute("aria-label", t("resetFilters"));
  filter.append(reset);
  root.append(filter);
  const actions = make("div", undefined, "actions");
  const add = button(t("addProduct"), () => catalogForm());
  add.dataset.serverAction = "true";
  actions.append(add);
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
    `product-card${page === "stock" ? " stock-card" : ""}${p.active ? "" : " inactive"}${conflicted ? " conflict" : ""}`,
  );
  card.dataset.productId = p.id;
  const heading = make("div", undefined, "product-heading");
  heading.append(make("h2", productName(p)));
  if (page === "catalog")
    heading.append(make("span", t(p.active ? "active" : "inactive"), "badge"));
  else if (!p.active)
    heading.append(make("span", t("inactive"), "inactive-label"));
  card.append(heading);
  if (page === "catalog")
    card.append(
      make(
        "p",
        (p.zones || []).map(zoneName).join(" · ") || t("unassigned"),
        "locations",
      ),
    );
  if (page === "stock") {
    const cardGeneration = generation;
    const cardKey = recordKey();
    card.addEventListener("focusout", () =>
      setTimeout(() => {
        if (
          card.isConnected &&
          page === "stock" &&
          generation === cardGeneration &&
          record.snapshot &&
          recordKey() === cardKey &&
          !card.contains(document.activeElement)
        )
          updateStockProgress(true);
      }, 0),
    );
    const recorded = make("details", undefined, "recorded-details");
    const recordedValue = make("summary", undefined, "recorded-summary");
    const previousBalance = make("span", undefined, "previous-balance");
    previousBalance.append(
      make("span", t("recordedShort")),
      make(
        "strong",
        `${quantityText(p.last)}${p.last === null || p.last === undefined ? "" : ` ${t(`unitShort_${p.unit}`)}`}`,
      ),
    );
    const counted = make(
      "time",
      p.lastCountedAt ? dateText(p.lastCountedAt, true) : "",
      "recorded-time",
    );
    counted.title = `${t("countedAt")}: ${dateText(p.lastCountedAt)}`;
    counted.setAttribute("aria-label", counted.title);
    if (p.lastCountedAt) counted.dateTime = p.lastCountedAt;
    previousBalance.append(counted);
    const countTimeAction = make(
      "span",
      t("showCountTime"),
      "disclosure-label",
    );
    recordedValue.append(previousBalance, countTimeAction);
    recorded.addEventListener("toggle", () => {
      countTimeAction.textContent = t(
        recorded.open ? "hideCountTime" : "showCountTime",
      );
    });
    recorded.append(
      recordedValue,
      make("p", `${t("countedAt")}: ${dateText(p.lastCountedAt)}`, "help"),
    );
    card.append(recorded);
    if (p.expirationWarning)
      card.append(
        make("p", t("savedExpirationWarning"), "help saved-expiration-warning"),
      );
    const inputs = make("div", undefined, "quantity-grid"),
      d = record.drafts[p.id];
    const entryUnit = d?.unit || p.unit;
    const zones = d?.zones || p.zones || [],
      expected = zones.length ? zones : ["unassigned"];
    if (expected.length === 1) inputs.classList.add("single-location");
    for (const id of expected) {
      const label = make("label", undefined, "quantity-label"),
        input = make("input");
      label.append(
        make(
          "span",
          `${zoneName(id)}, ${t(`unitShort_${entryUnit}`)}`,
          "quantity-caption",
        ),
      );
      label.title = `${zoneName(id)}, ${t(entryUnit)}`;
      input.type = "text";
      input.className = "quantity-input";
      input.setAttribute(
        "aria-label",
        `${t("quantity")} · ${zoneName(id)} (${t(entryUnit)})`,
      );
      input.inputMode = "decimal";
      input.autocomplete = "off";
      input.dataset.zone = id;
      input.value = d?.locations?.[id]?.value ?? "";
      input.title = input.value;
      input.addEventListener("input", () =>
        guard(() => {
          const next = editDraft(p, record.drafts[p.id], {
            locations: { [id]: { value: input.value, unit: "BASE" } },
          });
          record.drafts[p.id] = next;
          input.title = input.value;
          persist();
          input.removeAttribute("aria-invalid");
        }),
      );
      label.append(input);
      inputs.append(label);
    }
    const countFeedback = make("p", undefined, "count-feedback");
    countFeedback.setAttribute("role", "status");
    const updateCountFeedback = () => {
      const state = draftState(p, record.drafts[p.id]);
      card.classList.toggle("draft-complete", state.complete && !conflicted);
      const entered = expected.filter(
        (id) =>
          String(record.drafts[p.id]?.locations?.[id]?.value ?? "").trim() !==
          "",
      ).length;
      countFeedback.classList.toggle(
        "error",
        Boolean(state.error && state.error !== "INCOMPLETE_LOCATIONS"),
      );
      countFeedback.textContent = state.complete
        ? `${conflicted ? `${t("draftEntered")} · ${t("review")}` : `✓ ${t("draftEntered")}`} · ${t("localTotal")}: ${quantityText(state.totalValue)} ${t(`unitShort_${entryUnit}`)}`
        : entered > 0 && entered < expected.length
          ? t("draftPartialLocations", { entered, total: expected.length })
          : state.entered
            ? t(state.error || "draftInvalid")
            : "";
    };
    for (const input of inputs.querySelectorAll("input")) {
      input.enterKeyHint = "next";
      const error = make("span", "", "error field-error");
      error.id = `quantity-error-${p.id}-${input.dataset.zone}`;
      input.setAttribute("aria-describedby", error.id);
      input.parentElement.append(error);
      const validateField = () => {
        error.textContent = "";
        try {
          if (input.value.trim()) quantityInput(input.value, d?.unit || p.unit);
          input.removeAttribute("aria-invalid");
        } catch (failure) {
          error.textContent = t(errorKey(failure));
          input.setAttribute("aria-invalid", "true");
        }
        updateCountFeedback();
      };
      input.addEventListener("input", validateField);
      validateField();
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        const fields = [
          ...document.querySelectorAll(".stock-product-list input[data-zone]"),
        ].filter((field) => field.getClientRects().length);
        fields[fields.indexOf(input) + 1]?.focus();
      });
    }
    updateCountFeedback();
    card.append(inputs, countFeedback);
    const additional = make("details", undefined, "additional-controls");
    const detailKey = `${recordKey()}:${p.id}`;
    additional.open = stockDetails.get(detailKey) === true;
    const summary = make("summary");
    const indicator = make("span", undefined, "additional-indicator");
    const additionalAction = make(
      "span",
      t(additional.open ? "hideAdditional" : "showAdditional"),
      "disclosure-label",
    );
    summary.append(additionalAction, indicator);
    additional.addEventListener("toggle", () => {
      additionalAction.textContent = t(
        additional.open ? "hideAdditional" : "showAdditional",
      );
    });
    summary.addEventListener("click", () =>
      stockDetails.set(detailKey, !additional.open),
    );
    const updateIndicator = () => {
      const latest = record.drafts[p.id];
      const selected =
        Number(Boolean(latest?.approx)) +
        Number(Boolean(latest ? latest.low : p.low)) +
        Number(
          Boolean(
            latest && Object.hasOwn(latest, "expirationWarning")
              ? latest.expirationWarning
              : p.expirationWarning,
          ),
        );
      indicator.textContent = selected
        ? t("additionalSelected", { count: selected })
        : "";
      indicator.hidden = !selected;
      additional.classList.toggle("has-selected", selected > 0);
    };
    const flags = make("div", undefined, "flags");
    for (const key of ["approx", "low", "expirationWarning"]) {
      const label = make("label", undefined, "check"),
        input = make("input");
      input.type = "checkbox";
      input.checked = Boolean(
        d && Object.hasOwn(d, key) ? d[key] : key === "approx" ? false : p[key],
      );
      input.addEventListener("change", () =>
        guard(() => {
          record.drafts[p.id] = editDraft(p, record.drafts[p.id], {
            [key]: input.checked,
          });
          persist();
          updateIndicator();
        }),
      );
      label.append(
        input,
        make("span", t(key === "approx" ? "approximate" : key)),
      );
      flags.append(label);
    }
    flags.append(
      make("p", t("expirationWarningHelp"), "help expiration-warning-help"),
    );
    updateIndicator();
    additional.append(summary, flags);
    card.append(additional);
    return card; // Catalog alone owns status actions and status-changing swipes.
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
  (card.querySelector(".product-footer") || card).append(actions);
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
  dialogPosition = { generation, page, y: window.scrollY, x: window.scrollX };
  dialog.classList.remove("bottom-sheet", "recount-menu-dialog");
  delete dialog.dataset.kind;
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
  // An older deployment would silently ignore the new manual warning field.
  // Keep drafts intact until the matching server is deployed; old pending
  // requests still recover through their original, unchanged retry path.
  if (record.snapshot.features?.expirationWarning !== true)
    throw Error("WORKSPACE_UPGRADE_REQUIRED");
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
      root.append(
        make(
          "p",
          t("submissionSummary", {
            entered: preview.summary.entered,
            total: preview.summary.entered + preview.summary.uncounted,
          }),
        ),
      );
      const list = make("ul", undefined, "confirmation-list");
      for (const item of preview.items) {
        const p = record.snapshot.products.find((p) => p.id === item.id);
        const state = draftState(p, record.drafts[item.id]);
        const warning = Object.hasOwn(
          record.drafts[item.id],
          "expirationWarning",
        )
          ? record.drafts[item.id].expirationWarning
          : p.expirationWarning;
        list.append(
          make(
            "li",
            `${productName(p)}: ${quantityText(state.totalValue)} ${t(p.unit)}${p.active ? "" : ` · ${t("inactive")}`}${warning ? ` · ${t("expirationWarning")}` : ""}`,
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
      root.append(scopes, tip("scopeHelp"));
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
    if (record.notification.status === "SENT") announceDelivery(request.id);
    snapshotEpoch++;
    render();
    flash(
      result.failed?.length || result.conflicted?.length
        ? "partial"
        : result.accepted?.length
          ? "saved"
          : "noCountsSaved",
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
    if (result.status === "SENT" && current.status !== "SENT")
      announceDelivery(id);
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
      (n.id === record.notification?.id ||
        ["READY", "FAILED", "UNKNOWN"].includes(n.status)) &&
      !(
        n.status === "SENT" &&
        (record.dismissedNotifications?.[n.id] ||
          (freshDeliveries.get(`${recordKey()}:${n.id}`) || 0) <= Date.now())
      ),
  );
  panel.hidden = !list.length;
  panel.classList.toggle(
    "notification-compact",
    list.every((item) => item.status === "SENT"),
  );
  if (!list.length) return;
  panel.replaceChildren();
  panel.setAttribute("aria-label", t("notification"));
  panel.setAttribute("role", "status");
  if (list.some((item) => item.status !== "SENT"))
    panel.append(make("h2", t("notification")));
  for (const notification of list) {
    const section = make("section", undefined, "notification-item");
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
    if (notification.status === "SENT") {
      const noticeGeneration = generation;
      const noticeKey = recordKey();
      const dismiss = button(
        t("dismissNotification"),
        () => {
          if (
            noticeGeneration !== generation ||
            !record.snapshot ||
            noticeKey !== recordKey()
          )
            return;
          const candidate = structuredClone(record);
          candidate.dismissedNotifications = {
            ...(candidate.dismissedNotifications || {}),
            [notification.id]: true,
          };
          persist(candidate);
          record = candidate;
          renderNotification();
          $("#view-heading").focus({ preventScroll: true });
        },
        "notification-dismiss",
      );
      dismiss.dataset.dismissNotification = notification.id;
      dismiss.setAttribute("aria-label", t("dismissNotificationLabel"));
      section.append(dismiss);
    }
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
      if (change.product && change.draft?.unit !== change.product.unit)
        root.append(
          make(
            "p",
            t("unitChangeReviewOldUnit", { unit: t(change.draft.unit) }),
            "help",
          ),
        );
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
      if (!old) throw Error("INVALID_COUNT");
      let next = createDraft(change.product);
      next.approx = old.approx;
      next.low = old.low;
      if (Object.hasOwn(old, "expirationWarning"))
        next.expirationWarning = old.expirationWarning;
      if (change.product.unit === old.unit) {
        for (const zone of next.zones.length ? next.zones : ["unassigned"])
          if (old.locations?.[zone])
            next.locations[zone] = structuredClone(old.locations[zone]);
      } else {
        record.archivedDrafts ||= [];
        record.archivedDrafts.push({
          id: change.id,
          draft: structuredClone(old),
          archivedAt: new Date().toISOString(),
          reason: "UNIT_CHANGED",
        });
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
    const candidate = structuredClone(record);
    candidate.pendingMutation = null;
    if (request.method === "workspaceTelegramTest") {
      candidate.telegramTests ||= {};
      candidate.telegramTests[request.body.id] = {
        ...result.notification,
        id: request.body.id,
      };
      candidate.telegramTestId = request.body.id;
    }
    persist(candidate);
    record = candidate;
    snapshotEpoch++;
    return result;
  } catch (error) {
    if (epoch !== generation || key !== recordKey())
      throw Error("STALE_OPERATION");
    const rejected =
      /^(INVALID_|EXISTING_CATEGORY_REQUIRED|UNIT_HAS_HISTORY|UNIT_RECOUNT_|STOCK_CONFLICT$|PRODUCT_CHANGED$|PRODUCT_NAME_EXISTS|PRODUCT_DELETED|CATALOG_CONFLICT$|CONFLICT$|CARD_EXISTS|OWNER_ONLY|PWA_READ_ONLY|SIGN_IN_REQUIRED|METHOD_NOT_ALLOWED|TELEGRAM_SETUP_NOT_AVAILABLE)/.test(
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
      const unitPanel = make("fieldset", undefined, "unit-change-panel");
      unitPanel.id = "unit-change-counts";
      unitPanel.append(make("legend", t("unitChangeTitle")));
      unitPanel.append(make("p", t("unitChangeHelp"), "help"));
      if (p && record.drafts[p.id])
        unitPanel.append(make("p", t("unitChangeOldDraft"), "help"));
      const unitInputs = make("div", undefined, "unit-change-inputs");
      unitPanel.append(make("p", t("unitChangeCountHelp"), "help"), unitInputs);
      const confirmedLabel = make("label", undefined, "check");
      values.unitChangeConfirmed = make("input");
      values.unitChangeConfirmed.type = "checkbox";
      values.unitChangeConfirmed.name = "unitChangeConfirmed";
      confirmedLabel.append(
        values.unitChangeConfirmed,
        make("span", t("unitChangeConfirm")),
      );
      unitPanel.append(confirmedLabel);
      values.unitRecountLocations = [];
      const enteredUnitCounts = new Map();
      let displayedUnit = values.unit.value;
      values.needsUnitRecount = () =>
        Boolean(
          p &&
          p.unit !== values.unit.value &&
          (p.hasStockHistory !== false ||
            (p.last !== null && p.last !== undefined) ||
            p.lastCountedAt),
        );
      const renderUnitCounts = () => {
        for (const input of values.unitRecountLocations)
          enteredUnitCounts.set(
            `${displayedUnit}:${input.dataset.unitRecountZone}`,
            input.value,
          );
        displayedUnit = values.unit.value;
        values.unitChangeConfirmed.checked = false;
        unitPanel.hidden = !values.needsUnitRecount();
        values.unitChangeConfirmed.disabled = unitPanel.hidden;
        values.unitRecountLocations = [];
        unitInputs.replaceChildren();
        if (unitPanel.hidden) return;
        for (const zone of values.zones
          .filter((input) => input.checked)
          .map((input) => input.value)) {
          const label = make("label");
          label.append(
            make(
              "span",
              `${zoneName(zone)}, ${t(`unitShort_${displayedUnit}`)}`,
            ),
          );
          const input = make("input");
          input.type = "text";
          input.inputMode = "decimal";
          input.enterKeyHint = "next";
          input.autocomplete = "off";
          input.required = true;
          input.dataset.unitRecountZone = zone;
          input.setAttribute(
            "aria-label",
            `${t("quantity")} · ${zoneName(zone)} (${t(displayedUnit)})`,
          );
          input.value = enteredUnitCounts.get(`${displayedUnit}:${zone}`) || "";
          const error = make("span", "", "error field-error");
          error.id = `unit-count-error-${zone}`;
          input.setAttribute("aria-describedby", error.id);
          input.addEventListener("input", () => {
            values.unitChangeConfirmed.checked = false;
            error.textContent = "";
            input.removeAttribute("aria-invalid");
            try {
              if (input.value.trim())
                quantityInput(input.value, values.unit.value);
            } catch (failure) {
              error.textContent = t(errorKey(failure));
              input.setAttribute("aria-invalid", "true");
            }
          });
          input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || event.isComposing) return;
            event.preventDefault();
            const index = values.unitRecountLocations.indexOf(input);
            (
              values.unitRecountLocations[index + 1] ||
              values.unitChangeConfirmed
            ).focus();
          });
          label.append(input, error);
          values.unitRecountLocations.push(input);
          unitInputs.append(label);
        }
      };
      values.unit.addEventListener("change", renderUnitCounts);
      for (const checkbox of values.zones)
        checkbox.addEventListener("change", renderUnitCounts);
      root.append(unitPanel);
      renderUnitCounts();
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
      root.append(tip("reminderHelp"));
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
      let unitRecount;
      if (v.needsUnitRecount()) {
        if (record.snapshot.features?.unitRecount !== true)
          throw Error("WORKSPACE_UPGRADE_REQUIRED");
        if (!v.unitChangeConfirmed.checked)
          throw Error("UNIT_RECOUNT_CONFIRM_REQUIRED");
        const locations = v.unitRecountLocations.map((input) => ({
          zoneId: input.dataset.unitRecountZone,
          value: quantityInput(input.value, v.unit.value).value,
          unit: "BASE",
        }));
        const nextProduct = { ...p, unit: v.unit.value, zones };
        const draft = createDraft(nextProduct);
        for (const location of locations)
          draft.locations[location.zoneId].value = location.value;
        const state = draftState(nextProduct, draft);
        if (!state.complete)
          throw Error(state.error || "UNIT_RECOUNT_REQUIRED");
        unitRecount = {
          confirmed: true,
          stockVersion: p.stockVersion,
          countVersion: p.countVersion,
          locations,
          approx: false,
          low: Boolean(p.low),
          expirationWarning: Boolean(p.expirationWarning),
        };
      }
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
      const form = $("#dialog-form");
      const disabledStates = unitRecount
        ? [...form.querySelectorAll("input,select,textarea,button")].map(
            (control) => [control, control.disabled],
          )
        : [];
      const epoch = generation;
      if (unitRecount) {
        for (const [control] of disabledStates) control.disabled = true;
        form.setAttribute("aria-busy", "true");
      }
      try {
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
            ...(unitRecount ? { unitRecount } : {}),
          },
        });
        await completeMutation(
          unitRecount ? "unitChangeSaved" : "productSaved",
        );
      } finally {
        if (unitRecount && epoch === generation) {
          form.removeAttribute("aria-busy");
          for (const [control, disabled] of disabledStates)
            if (control.isConnected) control.disabled = disabled;
        }
      }
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
  const state = teamView();
  const tabs = make("div", undefined, "team-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("teamSections"));
  const sections = [
    ["notes", "notes"],
    ["cards", "yellowCards"],
  ];
  const switchTab = (id) => {
    state.tab = id;
    render();
    $(`#team-tab-${id}`).focus({ preventScroll: true });
  };
  for (const [id, label] of sections) {
    const control = button(t(label), () => switchTab(id));
    control.id = `team-tab-${id}`;
    control.setAttribute("role", "tab");
    control.setAttribute("aria-controls", `team-${id}-panel`);
    control.setAttribute("aria-selected", String(state.tab === id));
    control.tabIndex = state.tab === id ? 0 : -1;
    control.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const target =
        event.key === "Home"
          ? "notes"
          : event.key === "End"
            ? "cards"
            : id === "notes"
              ? "cards"
              : "notes";
      switchTab(target);
    });
    tabs.append(control);
  }
  root.append(tabs);
  const panel = (id, title) => {
    const element = make("section", undefined, "panel team-panel");
    element.id = `team-${id}-panel`;
    element.setAttribute("role", "tabpanel");
    element.setAttribute("aria-labelledby", `team-tab-${id}`);
    element.tabIndex = 0;
    element.hidden = state.tab !== id;
    element.append(make("h2", t(title)));
    root.append(element);
    return element;
  };
  const notes = panel("notes", "notes");
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
  const cards = panel("cards", "yellowCards");
  const searchLabel = make("label", t("searchCards"), "card-search");
  const search = make("input");
  search.type = "search";
  search.id = "card-search";
  search.value = state.search;
  searchLabel.append(search);
  cards.append(searchLabel);
  const cardActions = make("div", undefined, "actions card-actions");
  const addCard = button(t("addCard"), cardForm);
  addCard.dataset.serverAction = "true";
  const clear = button(t("clearCardSearch"), () => {
    state.search = "";
    search.value = "";
    listCards();
    search.focus();
  });
  cardActions.append(addCard, clear);
  cards.append(cardActions);
  const result = make("p", undefined, "help card-search-result");
  result.setAttribute("role", "status");
  cards.append(result);
  const groups = make("div", undefined, "card-groups");
  cards.append(groups);
  const normalize = (value) =>
    String(value || "")
      .toLocaleLowerCase()
      .replace(/ё/g, "е");
  function listCards() {
    const all = record.snapshot.cards || [],
      query = normalize(state.search.trim());
    const visible = all.filter(
      (c) =>
        !query ||
        [c.id, c.code, c.name, c.size, c.category, c.note].some((value) =>
          normalize(value).includes(query),
        ),
    );
    result.textContent = t("cardsSearchResult", {
      shown: visible.length,
      total: all.length,
    });
    clear.disabled = !state.search;
    groups.replaceChildren();
    if (query && !visible.length) {
      groups.append(make("p", t("noMatchingCards"), "help"));
      return;
    }
    const categories = [
      "A",
      "C",
      "D",
      ...new Set(
        all
          .map(cardCategory)
          .filter((category) => !["A", "C", "D"].includes(category)),
      ),
    ];
    for (const category of categories) {
      const entries = visible.filter((c) => cardCategory(c) === category);
      if (query && !entries.length) continue;
      const group = make("details", undefined, "card-group");
      group.dataset.category = category;
      group.open = Boolean(query) || state.groups[category] === true;
      const summary = make("summary", undefined, "card-group-summary");
      summary.append(
        make("h3", category === "__other__" ? t("otherCards") : category),
        make("span", String(entries.length), "card-group-count"),
      );
      summary.addEventListener("click", () => {
        if (!query) state.groups[category] = !group.open;
      });
      group.append(summary);
      if (!entries.length) group.append(make("p", t("noCards"), "help"));
      for (const c of entries) group.append(yellowCardRow(c, state));
      groups.append(group);
    }
  }
  search.addEventListener("input", () => {
    state.search = search.value;
    listCards();
  });
  listCards();
}
function cardCategory(card) {
  const category = String(card.category || "").trim();
  if (category) return category;
  const prefix = String(card.id || card.code || "")
    .toUpperCase()
    .slice(0, 1);
  return ["A", "C", "D"].includes(prefix) ? prefix : "__other__";
}
function yellowCardRow(card, state) {
  const id = String(card.id || card.code || ""),
    row = make("details", undefined, "yellow-card-row");
  row.dataset.cardId = id;
  row.open = state.rows[id] === true;
  const summary = make("summary", undefined, "yellow-card-summary");
  summary.append(
    make("strong", id, "card-code"),
    make("span", card.name, "card-name"),
  );
  if (card.size) summary.append(make("span", card.size, "card-meta"));
  summary.addEventListener("click", () => {
    state.rows[id] = !row.open;
  });
  const details = make("div", undefined, "yellow-card-details");
  for (const [key, value] of [
    ["cardCategory", card.category],
    ["size", card.size],
    ["cardNote", card.note],
  ]) {
    if (value) details.append(make("p", `${t(key)}: ${value}`));
  }
  if (card.authorName || card.by)
    details.append(
      make("p", `${t("author")}: ${card.authorName || card.by}`, "help"),
    );
  if (card.updated) details.append(make("p", dateText(card.updated), "help"));
  row.append(summary, details);
  return row;
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
      const state = teamView();
      state.tab = "cards";
      state.search = "";
      state.groups[v.category.value.trim()] = true;
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
  const tipsLabel = make("label", undefined, "check tips-mode-control");
  const tips = make("input");
  tips.type = "checkbox";
  tips.id = "tips-mode";
  tips.checked = tipsEnabled();
  tips.addEventListener("change", () =>
    guard(() => {
      const candidate = structuredClone(record);
      candidate.preferences = {
        ...(candidate.preferences || {}),
        tips: tips.checked,
      };
      persist(candidate);
      record = candidate;
      applyTips();
    }),
  );
  tipsLabel.append(tips, make("span", t("tipsMode")));
  panel.append(tipsLabel, tip("tipsModeHelp"));
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
    tip("reminderHelp"),
    make("p", `${t("lastSync")}: ${dateText(record.loadedAt)}`, "help"),
    tip("logoutHelp"),
  );
  panel.append(
    button(t("backup"), downloadBackup),
    button(t("logout"), logout),
  );
  root.append(panel);
  renderTelegramSettings(root);
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
function renderTelegramSettings(root) {
  const panel = make("section", undefined, "panel telegram-settings");
  panel.id = "telegram-settings";
  const heading = make("h2", t("telegramSettings"));
  heading.id = "telegram-heading";
  panel.setAttribute("aria-labelledby", heading.id);
  panel.append(heading);
  root.append(panel);
  const status = record.snapshot.telegram;
  if (!status) {
    panel.append(make("p", t("telegramSetupUnavailable")));
    return;
  }
  panel.append(
    make(
      "p",
      t(status.configured ? "telegramConfigured" : "telegramNotConfigured"),
    ),
  );
  if (!status.tokenConfigured)
    panel.append(make("p", t("telegramTokenMissing"), "error"));
  if (!status.chatConfigured)
    panel.append(make("p", t("telegramChatMissing"), "error"));
  if (!status.canTest) {
    panel.append(make("p", t("telegramSetupOwnerOnly")));
    return;
  }
  const instructions = make("details", undefined, "telegram-setup-guide");
  instructions.append(make("summary", t("telegramSetupInstructions")));
  const steps = make("ol");
  for (const key of [
    "telegramSetupBot",
    "telegramSetupChat",
    "telegramSetupDeploy",
  ])
    steps.append(make("li", t(key)));
  instructions.append(steps);
  panel.append(instructions);
  const latest = record.telegramTests?.[record.telegramTestId];
  if (latest) {
    const key =
      {
        READY: "telegramTestReady",
        SENT: "telegramTestSent",
        FAILED: "telegramTestFailed",
        UNKNOWN: "telegramTestUnknown",
        NOT_CONFIGURED: "telegramTestMissing",
      }[latest.status] || "telegramTestUnknown";
    const result = make("p", t(key));
    result.setAttribute("role", "status");
    panel.append(result);
    if (
      ["READY", "FAILED", "UNKNOWN", "NOT_CONFIGURED"].includes(latest.status)
    ) {
      const checkOnly = latest.status === "UNKNOWN";
      const retry = button(
        t(checkOnly ? "checkDelivery" : "retryTelegramTest"),
        () => retryTelegramTest(latest.id, checkOnly),
      );
      retry.id = checkOnly ? "telegram-test-check" : "telegram-test-retry";
      retry.dataset.serverAction = "true";
      retry.dataset.telegramAction = checkOnly ? "check" : "send";
      panel.append(retry);
    }
  }
  const test = button(t("sendTelegramTest"), async () => {
    if (!confirm(t("confirmTelegramTest"))) return;
    const epoch = generation;
    flash("telegramTestRunning");
    await mutation("workspaceTelegramTest", { language: "ru" });
    if (epoch === generation && page === "profile") render();
  });
  test.id = "telegram-test";
  test.dataset.serverAction = "true";
  test.dataset.telegramAction = "new";
  panel.append(test);
}
async function retryTelegramTest(id, checkOnly) {
  const marker = `telegram-test:${id}`;
  if (
    !authenticated ||
    !navigator.onLine ||
    (!checkOnly && !writable()) ||
    notifying.has(marker)
  )
    return;
  const current = record.telegramTests?.[id];
  if (
    !current ||
    (!checkOnly &&
      !["READY", "FAILED", "NOT_CONFIGURED"].includes(current.status))
  )
    return;
  const epoch = generation,
    key = recordKey();
  notifying.add(marker);
  controls();
  try {
    const response = await rpc(
      checkOnly ? "workspaceStatus" : "workspaceNotify",
      { id },
    );
    if (epoch !== generation || key !== recordKey())
      throw Error("STALE_OPERATION");
    const result = checkOnly ? response.result?.notification : response;
    if (!result) throw Error("OPERATION_NOT_FOUND");
    const candidate = structuredClone(record);
    candidate.telegramTests[id] = { ...result, id };
    persist(candidate);
    record = candidate;
  } catch (error) {
    if (epoch !== generation || key !== recordKey())
      throw Error("STALE_OPERATION");
    if (
      checkOnly ||
      /^(OWNER_ONLY|PWA_READ_ONLY|SIGN_IN_REQUIRED|OPERATION_NOT_FOUND|STORAGE_ERROR)$/.test(
        error?.message,
      )
    )
      throw error;
    const candidate = structuredClone(record);
    candidate.telegramTests[id] = { ...current, status: "UNKNOWN" };
    persist(candidate);
    record = candidate;
  } finally {
    notifying.delete(marker);
    if (epoch === generation) {
      if (page === "profile") render();
      else controls();
    }
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
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && record.snapshot)
    renderNotification();
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
  measureLayout();
  if (keyboard)
    requestAnimationFrame(() => {
      if (document.activeElement !== active || !active.isConnected) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop || 0;
      const bottom = top + (viewport?.height || window.innerHeight);
      const bounds = active.getBoundingClientRect();
      if (bounds.top < top + 8 || bounds.bottom > bottom - 8)
        active.scrollIntoView({ block: "center", behavior: "auto" });
    });
}
window.visualViewport?.addEventListener("resize", keyboardLayout);
window.addEventListener("resize", keyboardLayout);
document.addEventListener("focusin", keyboardLayout);
document.addEventListener("focusout", () => setTimeout(keyboardLayout, 0));
function measureLayout() {
  const navigation = $("#navigation"),
    countBar = $("#count-bar");
  document.body.style.setProperty(
    "--workspace-navigation-height",
    `${navigation?.offsetHeight || 0}px`,
  );
  document.body.style.setProperty(
    "--workspace-bottom",
    `${(navigation?.offsetHeight || 0) + (countBar?.offsetHeight || 0)}px`,
  );
}
function observeLayout() {
  layoutObserver?.disconnect();
  for (const element of [
    document.querySelector("header"),
    $("#workspace-filters"),
    $("#navigation"),
    $("#count-bar"),
  ])
    if (element) layoutObserver?.observe(element);
  measureLayout();
}
if ("ResizeObserver" in window) {
  layoutObserver = new ResizeObserver(measureLayout);
}
window.addEventListener("resize", measureLayout);
observeLayout();
setLanguage(language);
controls();
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("./sw.js").catch(() => {});
