import { messages } from "./locales.js";
const $ = (selector) => document.querySelector(selector);
const state = {
  user: null,
  products: [],
  categories: [],
  zones: [],
  sessions: [],
  settings: {},
  view: "stock",
  connected: false,
  lowOnly: false,
  session: null,
  drafts: {},
  changes: [],
  pending: null,
  history: { entries: [], revisions: [], next: null },
  information: { cards: [], reminders: [] },
  storageOkay: true,
};
let lang =
  get("varka-language") || (navigator.language.startsWith("ru") ? "ru" : "en");
let refreshing;
let refreshAgain = false;
let installPrompt;
let toastTimer;
let fieldCounter = 0;
const t = (key) => messages[lang][key] || messages.en[key] || key;
const name = (item) => (lang === "ru" ? item.ru : item.en || item.ru);
const category = (value) => {
  const parts = value.split(" / ");
  return lang === "ru" ? parts[0] : parts[1] || parts[0];
};
const qty = (value) =>
  value === null || value === undefined
    ? t("unknown")
    : String(value).replace(".", lang === "ru" ? "," : ".");
const date = (value) =>
  value
    ? new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", {
        timeZone: "Europe/Minsk",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : t("dateUnknown");
const uuid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
function get(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function put(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* A retained operation can safely replay. */
  }
}
const key = (suffix) => `varka:${state.user?.email}:${suffix}`;
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(
  label,
  handler,
  { online = false, className = "button subtle compact" } = {},
) {
  const node = el("button", className, label);
  node.type = "button";
  if (online) node.dataset.online = "true";
  node.disabled = online && (!state.connected || Boolean(state.pending));
  node.addEventListener("click", () => guard(handler));
  return node;
}
function notice(message = "") {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 4000);
}
function friendly(error) {
  const ru = {
    CONFLICT:
      "Запись изменилась. Обновите данные и явно проверьте ввод; черновик сохранён.",
    ZONES_CHANGED:
      "Места хранения изменились. Обновите список и проверьте каждое место.",
    INVALID_QUANTITY:
      "Введите неотрицательное число до 1 000 000 000, не более восьми знаков после запятой. Штуки должны быть целыми.",
    OPENING_COUNT_REQUIRED: "Сначала выполните физический пересчёт товара.",
    INSUFFICIENT_STOCK:
      "Недостаточно записанного остатка. Сначала перепроверьте товар.",
    MISSING_COUNTS:
      "Заполните все позиции или явно оставьте пустые без изменений.",
    INCOMPLETE_ZONES:
      "Заполните каждое назначенное место хранения ровно один раз.",
    SIGN_IN_REQUIRED: "Войдите с правильным email и личным кодом доступа.",
    RATE_LIMIT: "Слишком много попыток. Повторите через 15 минут.",
    OWNER_ONLY: "Это действие доступно только владельцу.",
    OWN_SESSION_ONLY: "Можно изменять только свою инвентаризацию.",
    OWN_ENTRIES_ONLY: "Можно исправлять только свои записи.",
    NEWER_ENTRY_EXISTS:
      "Есть более новое движение. Допустимо исправить только историю.",
    PRODUCT_NAME_EXISTS: "Товар с таким названием уже существует.",
    UNIT_HAS_HISTORY: "Единицу нельзя менять после появления истории.",
    PACKAGING_NOTE_REQUIRED:
      "Укажите размер стакана/крышки или объём упаковки.",
    DEACTIVATE_BEFORE_ARCHIVE: "Сначала выключите товар.",
    INVALID_ACCESS_CODE: "Код доступа должен содержать от 12 до 200 символов.",
    ACCESS_CODE_REQUIRED: "Для нового сотрудника нужен код доступа.",
    SESSION_CLOSED: "Инвентаризация уже закрыта. Проверьте историю.",
    REQUEST_ID_REUSED: "Этот номер операции уже использован с другими данными.",
    LAST_OWNER: "Нельзя отключить последнего владельца.",
    INVALID_TEXT: "Проверьте обязательные текстовые поля и их длину.",
  };
  return lang === "ru" && ru[error.code]
    ? ru[error.code]
    : error.code === "CONFLICT" || error.code === "ZONES_CHANGED"
      ? `${t("reviewError")} ${error.message}`
      : error.message;
}
async function guard(callback) {
  try {
    await callback();
  } catch (error) {
    if (error.status === 401) loginView();
    notice(friendly(error));
  }
}

async function api(path, { method = "GET", body, operationId } = {}) {
  let response;
  try {
    response = await fetch(`/api/varka${path}`, {
      method,
      headers: {
        ...(method !== "GET"
          ? { "Content-Type": "application/json", "X-Inventory-Request": "1" }
          : {}),
        ...(operationId ? { "Idempotency-Key": operationId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(t("networkError"));
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(t("networkError"));
  }
  if (!response.ok) {
    const error = new Error(data.error || t("networkError"));
    Object.assign(error, { status: response.status, code: data.code });
    throw error;
  }
  return { data, offline: response.headers.get("X-Inventory-Offline") === "1" };
}
function online(value) {
  state.connected = value;
  $("#connection").textContent = t(value ? "connected" : "offline");
  $("#connection").classList.toggle("offline", !value);
  document.querySelectorAll("[data-online]").forEach((node) => {
    node.disabled =
      !value || Boolean(state.pending) || node.dataset.locked === "true";
  });
  document
    .querySelectorAll(
      "#count-list input,#count-list select,#keep-current,#incomplete,#clear-draft",
    )
    .forEach((node) => {
      node.disabled = Boolean(state.pending);
    });
  $("#primary-action").disabled = !value || Boolean(state.pending);
  $("#session-refresh").disabled = !value || Boolean(state.pending);
  $("#submit-count").disabled =
    !value || Boolean(state.pending) || !state.storageOkay;
  $("#retry").disabled = !value;
  $("#logout").disabled = Boolean(state.pending);
  $("#pending").hidden = !state.pending;
}
function loginView() {
  $("#workspace").hidden = true;
  $("#login-panel").hidden = false;
  $("#logout").hidden = true;
  $("#form-dialog").close();
  state.user = null;
  state.session = null;
}
function persistDraft() {
  if (!state.session || !state.user) return;
  try {
    put(key(`draft:${state.session.id}`), {
      session: state.session,
      drafts: state.drafts,
      changes: state.changes,
      keepCurrent: $("#keep-current").checked,
      incomplete: $("#incomplete").checked,
    });
    put(key("current-session"), state.session.id);
    state.storageOkay = true;
    $("#draft-status").textContent = t("savedLocal");
  } catch {
    state.storageOkay = false;
    $("#draft-status").textContent = t("storageFailed");
    notice(t("storageFailed"));
  }
  updateCountSummary();
}
function restoreDraft(sessionId) {
  const saved = get(key(`draft:${sessionId}`));
  if (!saved) return false;
  state.session = saved.session;
  state.drafts = saved.drafts || {};
  state.changes = saved.changes || [];
  $("#keep-current").checked = Boolean(saved.keepCurrent);
  $("#incomplete").checked = Boolean(saved.incomplete);
  return true;
}
function effective(item) {
  const change = state.changes.find((change) => change.id === item.id);
  return change
    ? { ...item, active: change.active, zones: change.zones }
    : item;
}

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      const result = await api("/bootstrap");
      const data = result.data;
      const changedUser = state.user?.email !== data.user.email;
      Object.assign(state, {
        user: data.user,
        products: data.products,
        categories: data.categories,
        zones: data.zones,
        sessions: data.sessions,
        settings: data.settings,
        syncedAt: data.syncedAt,
      });
      if (changedUser) {
        state.pending = get(key("pending"));
        state.session = null;
        state.drafts = {};
        state.changes = [];
        const savedSession = get(key("current-session"));
        if (savedSession) restoreDraft(savedSession);
      }
      online(!result.offline);
      $("#login-panel").hidden = true;
      $("#workspace").hidden = false;
      $("#logout").hidden = Boolean(state.user.development);
      notice(
        result.offline
          ? t("offlineNotice")
          : state.user.development
            ? t("devNotice")
            : "",
      );
      if (state.view === "history") await loadHistory(false);
      if (state.view === "information") await loadInformation();
      render();
    } catch (error) {
      online(false);
      if (error.status === 401) {
        loginView();
        notice(t("signinRequired"));
      } else notice(error.message);
    } finally {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        queueMicrotask(refresh);
      }
    }
  })();
  return refreshing;
}

async function perform(pending) {
  try {
    const { data } = await api(pending.path, {
      method: "POST",
      body: pending.body,
      operationId: pending.id,
    });
    remove(key("pending"));
    state.pending = null;
    if (pending.path === "/sessions" && data.session) {
      state.session = data.session;
      state.drafts = {};
      state.changes = [];
      state.view = "count";
      $("#keep-current").checked = false;
      $("#incomplete").checked = false;
      persistDraft();
    }
    if (pending.path.endsWith("/refresh") && data.session) {
      state.session = data.session;
      persistDraft();
    }
    if (pending.path.endsWith("/submit")) {
      remove(key(`draft:${data.sessionId}`));
      remove(key("current-session"));
      state.session = null;
      state.drafts = {};
      state.changes = [];
    }
    $("#form-dialog").close();
    await refresh();
    toast(t(pending.path.endsWith("/submit") ? "complete" : "saved"));
    return data;
  } catch (error) {
    if (error.status >= 400 && error.status < 500) {
      remove(key("pending"));
      state.pending = null;
    }
    online(state.connected);
    throw error;
  }
}
async function write(path, body) {
  if (!state.connected) throw new Error(t("offlineNotice"));
  if (state.pending) throw new Error(t("unsaved"));
  const pending = { path, body, id: uuid() };
  // Persist the operation BEFORE sending; never store login/access codes here.
  try {
    put(key("pending"), pending);
  } catch {
    throw new Error(t("storageFailed"));
  }
  state.pending = pending;
  online(state.connected);
  return perform(pending);
}

function matches(item) {
  const search = $("#search").value.toLocaleLowerCase();
  return (
    (!search ||
      `${item.ru} ${item.en} ${item.id}`
        .toLocaleLowerCase()
        .includes(search)) &&
    (!$("#category-filter").value ||
      item.category === $("#category-filter").value) &&
    (!state.lowOnly || item.low)
  );
}
function identity(item) {
  const root = el("div", "product-identity");
  const description = el("div");
  description.append(
    el("div", "product-title", name(item)),
    el(
      "div",
      "product-detail",
      `${category(item.category)}${item.notes ? ` · ${item.notes}` : ""}`,
    ),
  );
  root.append(el("span", "product-id", item.id), description);
  return root;
}
function empty(target, message) {
  target.append(el("p", "empty", message));
}
function statuses(item) {
  const root = el("div", "status-list");
  if (!item.active) root.append(el("span", "status unknown", t("inactive")));
  else
    root.append(
      el(
        "span",
        `status ${item.quantity === null ? "unknown" : item.quantity === "0" ? "zero" : item.low ? "low" : ""}`,
        t(
          item.quantity === null
            ? "unknown"
            : item.quantity === "0"
              ? "out"
              : item.low
                ? "low"
                : "wellStocked",
        ),
      ),
    );
  if (item.stale && item.quantity !== null)
    root.append(el("span", "status overdue", t("overdue")));
  if (item.accuracy === "ESTIMATED")
    root.append(el("span", "status unknown", t("estimated")));
  return root;
}
function renderStock() {
  const list = $("#stock-list");
  list.replaceChildren();
  for (const item of state.products.filter(
    (item) => item.active && matches(item),
  )) {
    const row = el("article", "stock-row");
    const balance = el("div", "balance-cell");
    const value = el("div", "quantity-value", qty(item.quantity));
    if (item.quantity !== null)
      value.append(document.createTextNode(" "), el("small", "", item.unit));
    balance.append(
      value,
      el(
        "div",
        "product-detail",
        item.minimum === null
          ? t("noMinimum")
          : `${t("minimum")}: ${qty(item.minimum)} ${item.unit}`,
      ),
    );
    const actions = el("div", "actions");
    actions.append(
      button(t("receive"), () => movementDialog(item, "RECEIVE"), {
        online: true,
      }),
      button(t("waste"), () => movementDialog(item, "WASTE"), { online: true }),
    );
    if (item.quantity === null)
      actions.querySelectorAll("button").forEach((button) => {
        button.disabled = true;
        button.dataset.locked = "true";
      });
    row.append(identity(item), balance, statuses(item), actions);
    list.append(row);
  }
  if (!list.children.length)
    empty(list, state.products.length ? t("noResults") : t("noItems"));
}
function renderCatalog() {
  const list = $("#catalog-list");
  list.replaceChildren();
  for (const source of state.products.filter(
    (item) => ($("#show-inactive").checked || item.active) && matches(item),
  )) {
    const item = effective(source);
    const row = el("article", "catalog-row");
    const details = el(
      "div",
      "product-detail",
      `${item.unit}${item.sleeve ? ` · ${t("sleeves")}` : ""} · ${item.hours} h`,
    );
    const actions = el("div", "actions");
    actions.append(
      button(t("edit"), () => productDialog(source), { online: true }),
    );
    if (!source.active)
      actions.append(
        button(
          t("archive"),
          async () => {
            if (confirm(t("confirmArchive")))
              await write("/products", {
                id: source.id,
                version: source.version,
                action: "archive",
              });
          },
          { online: true },
        ),
      );
    row.append(identity(item), details, statuses(item), actions);
    list.append(row);
  }
  if (!list.children.length) empty(list, t("noResults"));
  $("#staged-changes").hidden = !state.changes.length;
  $("#staged-changes").textContent = `${t("staged")}: ${state.changes.length}`;
}
function renderSessions() {
  const current = state.session;
  $("#session-picker").hidden = Boolean(current);
  $("#count-workspace").hidden = !current;
  const list = $("#session-list");
  list.replaceChildren();
  for (const item of state.sessions) {
    const row = el("article", "session-line");
    const description = el("div");
    description.append(
      el("strong", "", `${t("session")} · ${date(item.createdAt)}`),
      el(
        "p",
        "",
        `${item.owner} · ${item.status} · ${item.checked}/${item.total}`,
      ),
    );
    row.append(
      description,
      button(
        t(item.mine && item.status === "OPEN" ? "resume" : "view"),
        async () => {
          if (!restoreDraft(item.id) || item.status !== "OPEN") {
            const result = await api(
              `/sessions/${encodeURIComponent(item.id)}`,
            );
            state.session = result.data.session;
            state.drafts = {};
            state.changes = [];
          } else if (state.connected) {
            const result = await api(
              `/sessions/${encodeURIComponent(item.id)}`,
            );
            state.session = result.data.session;
          }
          render();
          persistDraft();
        },
        { online: !get(key(`draft:${item.id}`)) },
      ),
    );
    list.append(row);
  }
  if (!list.children.length) empty(list, t("noSessions"));
  if (!current) return;
  $("#session-name").textContent =
    `${t("session")} · ${date(current.createdAt)} · ${current.status}`;
  $("#submit-form").hidden =
    current.status !== "OPEN" || current.owner !== state.user.email;
  $("#session-refresh").hidden =
    current.status !== "OPEN" || current.owner !== state.user.email;
  $("#clear-draft").hidden =
    current.status !== "OPEN" || current.owner !== state.user.email;
  const countList = $("#count-list");
  countList.replaceChildren();
  for (const spec of current.items) {
    const source = state.products.find((item) => item.id === spec.id) || {
      ...spec,
      quantity: spec.previous ?? null,
      checkedAt: null,
      manualLow: false,
      revision: spec.revision || "",
      active: false,
      archived: true,
      zones: spec.zones || [],
      notes: "",
      category: spec.category || "",
    };
    const item = effective(source);
    if (!matches(item)) continue;
    countList.append(countRow(item, spec));
  }
  if (!countList.children.length) empty(countList, t("noResults"));
  updateCountSummary();
}
function draftFor(item) {
  if (!state.drafts[item.id])
    state.drafts[item.id] = {
      revision: item.revision,
      unit: "BASE",
      value: "",
      approx: false,
      low: item.manualLow,
      countedAt: new Date().toISOString(),
      locations: item.zones.length
        ? item.zones.map((zoneId) => ({ zoneId, value: "", unit: "BASE" }))
        : undefined,
    };
  return state.drafts[item.id];
}
function entered(entry) {
  return (
    entry &&
    (entry.locations
      ? entry.locations.some((location) => location.value.trim() !== "")
      : entry.value?.trim() !== "")
  );
}
function total(entry, item) {
  try {
    const convert = (value, unit) => {
      const match = /^(\d+)(?:[.,](\d{1,8}))?$/.exec(value.trim());
      if (!match) return null;
      return (
        (BigInt(match[1]) * 100000000n +
          BigInt((match[2] || "").padEnd(8, "0"))) *
        (unit === "SLEEVE_25" ? 25n : 1n)
      );
    };
    const values = entry.locations
      ? entry.locations.map((location) =>
          convert(location.value, location.unit),
        )
      : [convert(entry.value, entry.unit)];
    if (values.includes(null)) return "—";
    const atoms = values.reduce((a, b) => a + b, 0n);
    const fraction = String(atoms % 100000000n)
      .padStart(8, "0")
      .replace(/0+$/, "");
    return `${qty(`${atoms / 100000000n}${fraction ? `.${fraction}` : ""}`)} ${item.unit}`;
  } catch {
    return "—";
  }
}
function updateCountSummary() {
  const enteredCount = Object.values(state.drafts).filter(entered).length;
  $("#count-summary").textContent =
    `${enteredCount} ${t("entered")} · ${Math.max(0, (state.session?.remaining || 0) - enteredCount)} ${t("untouched")}`;
  $("#submit-count").disabled =
    !state.connected || Boolean(state.pending) || !state.storageOkay;
}
function countRow(item, spec) {
  const row = el("article", "count-row");
  row.dataset.productId = item.id;
  const heading = el("div", "count-heading");
  const current = el(
    "div",
    "",
    `${t("current")}: ${qty(item.quantity)}${item.quantity === null ? "" : ` ${item.unit}`}`,
  );
  current.append(
    el("div", "product-detail", `${t("checked")}: ${date(item.checkedAt)}`),
  );
  heading.append(identity(item), current);
  row.append(heading);
  if (
    spec.checked ||
    state.session.status !== "OPEN" ||
    state.session.owner !== state.user.email ||
    item.archived ||
    !item.active
  ) {
    row.append(
      el(
        "p",
        "product-detail",
        spec.checked
          ? `${t("checked")}: ${qty(spec.countedQuantity)} ${item.unit}`
          : !item.active
            ? t("inactive")
            : state.session.status,
      ),
    );
    return row;
  }
  const entry = state.drafts[item.id];
  const fields = el("div", "zone-inputs");
  const displayTotal = el(
    "span",
    "count-total",
    entry && entered(entry) ? total(entry, item) : "—",
  );
  const edit = (callback) => {
    if (state.pending) return;
    const draft = draftFor(item);
    callback(draft);
    draft.countedAt = new Date().toISOString();
    persistDraft();
    displayTotal.textContent = entered(draft) ? total(draft, item) : "—";
  };
  const zoneIds = item.zones.length ? item.zones : ["unassigned"];
  for (const zoneId of zoneIds) {
    const container = el("div");
    const id = `quantity-${item.id}-${zoneId}`;
    const label = el(
      "label",
      "",
      zoneId === "unassigned"
        ? `${t("quantity")} (${item.unit})`
        : state.zones.find((zone) => zone.id === zoneId)?.[lang] || zoneId,
    );
    label.htmlFor = id;
    const controls = el("div", "quantity-input");
    const input = el("input");
    input.id = id;
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.maxLength = 40;
    input.placeholder = "—";
    const saved =
      zoneId === "unassigned"
        ? entry
        : entry?.locations?.find((location) => location.zoneId === zoneId);
    input.value = saved?.value || "";
    input.disabled = Boolean(state.pending);
    input.addEventListener("input", () =>
      edit((draft) => {
        if (zoneId === "unassigned") draft.value = input.value;
        else {
          if (!draft.locations)
            draft.locations = zoneIds.map((zoneId) => ({
              zoneId,
              value: "",
              unit: "BASE",
            }));
          let location = draft.locations.find(
            (location) => location.zoneId === zoneId,
          );
          if (!location) {
            location = { zoneId, value: "", unit: "BASE" };
            draft.locations.push(location);
          }
          location.value = input.value;
        }
      }),
    );
    controls.append(input);
    if (item.sleeve === 25) {
      const unit = el("select");
      unit.setAttribute("aria-label", `${label.textContent} · ${t("unit")}`);
      unit.append(
        new Option(`${t("baseUnit")} (${item.unit})`, "BASE"),
        new Option(t("sleeves"), "SLEEVE_25"),
      );
      unit.value = saved?.unit || "BASE";
      unit.disabled = Boolean(state.pending);
      unit.addEventListener("change", () =>
        edit((draft) => {
          if (zoneId === "unassigned") draft.unit = unit.value;
          else
            draft.locations.find(
              (location) => location.zoneId === zoneId,
            ).unit = unit.value;
        }),
      );
      controls.append(unit);
    }
    container.append(label, controls);
    fields.append(container);
  }
  row.append(fields);
  const flags = el("div", "count-flags");
  const choices = el("div", "actions");
  for (const [field, label] of [
    ["approx", "approx"],
    ["low", "lowFlag"],
  ]) {
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.checked = entry?.[field] ?? (field === "low" && item.manualLow);
    checkbox.disabled = Boolean(state.pending);
    const wrapper = el("label", "check-label");
    wrapper.append(checkbox, document.createTextNode(t(label)));
    checkbox.addEventListener("change", () =>
      edit((draft) => {
        draft[field] = checkbox.checked;
      }),
    );
    choices.append(wrapper);
  }
  flags.append(choices, displayTotal);
  row.append(flags);
  if (entry && entry.revision !== item.revision) {
    const warning = el("div", "conflict", t("changed"));
    warning.append(
      button(t("review"), () => {
        if (!confirm(t("confirmReview"))) return;
        entry.revision = item.revision;
        if (item.zones.length)
          entry.locations = item.zones.map(
            (zoneId) =>
              entry.locations?.find(
                (location) => location.zoneId === zoneId,
              ) || { zoneId, value: "", unit: "BASE" },
          );
        else {
          delete entry.locations;
          entry.value ||= "";
        }
        entry.countedAt = new Date().toISOString();
        persistDraft();
        render();
      }),
    );
    row.append(warning);
  }
  return row;
}

async function loadHistory(more = false) {
  const { data } = await api(
    `/history${more && state.history.next ? `?before=${state.history.next}` : ""}`,
  );
  state.history = {
    ...data,
    entries: more ? [...state.history.entries, ...data.entries] : data.entries,
  };
  renderHistory();
}
function renderHistory() {
  const list = $("#history-list");
  list.replaceChildren();
  for (const entry of state.history.entries) {
    const row = el("article", "history-row");
    const description = el("div");
    description.append(
      el("strong", "", name(entry)),
      el(
        "p",
        "",
        `${t({ CHECK: "physicalCount", RECEIVE: "receive", WASTE: "waste" }[entry.action] || entry.action)} · ${entry.authorName || entry.actor} · ${date(entry.at)}`,
      ),
    );
    if (entry.note || entry.reason)
      description.append(el("p", "", entry.note || entry.reason));
    if (entry.source !== "CAFE")
      description.append(el("p", "", `${t("legacyArea")}: ${entry.source}`));
    const annotation = state.history.revisions
      .flatMap((revision) => revision.corrections)
      .filter((correction) => correction.id === entry.id)[0];
    if (annotation)
      description.append(
        el(
          "p",
          "",
          `${t("corrected")}: ${qty(annotation.quantity)} ${entry.unit}`,
        ),
      );
    const amount = el(
      "div",
      "history-amount",
      `${entry.action === "WASTE" ? "−" : entry.action === "RECEIVE" ? "+" : ""}${qty(entry.quantity)} ${entry.unit}`,
    );
    amount.append(el("small", "", `${t("current")}: ${qty(entry.after)}`));
    row.append(description, amount);
    if (
      entry.action === "CHECK" &&
      entry.sessionId &&
      entry.actor === state.user?.email
    )
      row.append(
        button(t("correction"), () => correctionDialog(entry), {
          online: true,
        }),
      );
    list.append(row);
  }
  if (!list.children.length) empty(list, t("noHistory"));
  $("#more-history").hidden = !state.history.next;
}
async function loadInformation() {
  state.information = (await api("/information")).data;
  renderInformation();
}
function renderInformation() {
  const notes = $("#reminder-list");
  notes.replaceChildren();
  for (const note of state.information.reminders) {
    const row = el("article", `information-row${note.done ? " done" : ""}`);
    const description = el("div");
    description.append(
      el("strong", "", note.text),
      el("p", "", note.authorName || note.author),
    );
    const actions = el("div", "actions");
    actions.append(
      button(
        t(note.done ? "open" : "done"),
        () =>
          write("/reminders", {
            id: note.id,
            version: note.version,
            text: note.text,
            done: !note.done,
          }),
        { online: true },
      ),
      button(t("edit"), () => noteDialog(note), { online: true }),
    );
    row.append(description, actions);
    notes.append(row);
  }
  if (!notes.children.length) empty(notes, t("noResults"));
  const cards = $("#card-list");
  cards.replaceChildren();
  for (const card of state.information.cards) {
    const row = el("article", "information-row");
    const description = el("div");
    description.append(
      el("strong", "", `${card.id} · ${card.name}`),
      el("p", "", `${card.size}${card.note ? ` · ${card.note}` : ""}`),
    );
    row.append(
      description,
      button(
        t("remove"),
        async () => {
          if (confirm(t("confirmRemove")))
            await write("/cards", {
              id: card.id,
              version: card.version,
              action: "remove",
            });
        },
        { online: true },
      ),
    );
    cards.append(row);
  }
  if (!cards.children.length) empty(cards, t("noResults"));
}

function render() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  $("#language").textContent = lang === "ru" ? "EN" : "RU";
  if (!state.user) return;
  for (const view of [
    "stock",
    "count",
    "catalog",
    "history",
    "information",
    "profile",
  ]) {
    $(`#view-${view}`).hidden = view !== state.view;
    $(`[data-view="${view}"]`).classList.toggle("active", view === state.view);
    $(`[data-view="${view}"]`).setAttribute(
      "aria-current",
      view === state.view ? "page" : "false",
    );
  }
  $("#heading").textContent = t(`${state.view}Title`);
  $("#subtitle").textContent = t(`${state.view}Subtitle`);
  $("#section-label").textContent = t(state.view).toUpperCase();
  $("#stats").hidden = state.view !== "stock";
  $("#filters").hidden = !["stock", "count", "catalog"].includes(state.view);
  $("#primary-action").hidden = !["stock", "count", "catalog"].includes(
    state.view,
  );
  $("#primary-action").textContent = t(
    state.view === "catalog" ? "addProduct" : "startCount",
  );
  const active = state.products.filter((item) => item.active);
  $("#stat-active").textContent = active.length;
  $("#stat-low").textContent = active.filter((item) => item.low).length;
  $("#stat-check").textContent = active.filter(
    (item) => item.stale || item.quantity === null,
  ).length;
  $("#product-total").textContent =
    `${state.products.length} ${t("allProducts")}`;
  $("#synced").textContent =
    `${t(state.connected ? "synced" : "snapshot")} ${date(state.syncedAt)}`;
  $("#search").placeholder = t("search");
  const selectedCategory = $("#category-filter").value;
  $("#category-filter").replaceChildren(
    new Option(t("allCategories"), ""),
    ...state.categories.map((value) => new Option(category(value), value)),
  );
  $("#category-filter").value = selectedCategory;
  $("#identity").textContent = `${state.user.email} · ${t(state.user.role)}`;
  $("#display-name").value = state.user.name;
  $("#owner-settings").hidden = state.user.role !== "owner";
  $("#alerts-enabled").checked = state.settings.enabled;
  $("#report-mode").value = state.settings.mode || "LOW";
  renderStock();
  renderCatalog();
  renderSessions();
  renderHistory();
  renderInformation();
  online(state.connected);
}

function field(
  container,
  label,
  { value = "", type = "text", required = true, options, maxLength = 200 } = {},
) {
  const id = `field-${++fieldCounter}`;
  const wrapper = el("div");
  const caption = el("label", "", label);
  caption.htmlFor = id;
  const input = el(
    options ? "select" : type === "textarea" ? "textarea" : "input",
  );
  input.id = id;
  if (options)
    input.append(
      ...options.map((option) => new Option(option.label, option.value)),
    );
  else if (type !== "textarea") input.type = type;
  input.required = required;
  input.maxLength = maxLength;
  input.value =
    options && (value === "" || value === null || value === undefined)
      ? (options[0]?.value ?? "")
      : (value ?? "");
  wrapper.append(caption, input);
  container.append(wrapper);
  return input;
}
function checkbox(container, label, checked = false) {
  const wrapper = el("label", "check-label");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  wrapper.append(input, document.createTextNode(label));
  container.append(wrapper);
  return input;
}
function dialog(title, build) {
  if (!state.connected || state.pending) {
    notice(t(state.pending ? "unsaved" : "offlineNotice"));
    return;
  }
  $("#dialog-title").textContent = title;
  $("#dialog-fields").replaceChildren();
  $("#dialog-error").textContent = "";
  $("#dialog-save").hidden = false;
  const submit = build($("#dialog-fields"));
  $("#dialog-form").onsubmit = async (event) => {
    event.preventDefault();
    if ($("#dialog-save").disabled) return;
    $("#dialog-save").disabled = true;
    $("#form-dialog").dataset.saving = "1";
    try {
      await submit?.();
    } catch (error) {
      $("#dialog-error").textContent = friendly(error);
      if (error.status === 401) loginView();
    } finally {
      $("#dialog-save").disabled = false;
      delete $("#form-dialog").dataset.saving;
    }
  };
  $("#form-dialog").showModal();
}
function movementDialog(item, action) {
  dialog(t(action === "WASTE" ? "stockOut" : "stockIn"), (container) => {
    container.append(
      el(
        "p",
        "muted",
        `${name(item)} · ${t("current")}: ${qty(item.quantity)} ${item.unit}`,
      ),
    );
    const value = field(container, t("quantity"));
    value.inputMode = "decimal";
    value.maxLength = 40;
    const unit = field(container, t("unit"), {
      value: "BASE",
      options: [
        { value: "BASE", label: `${t("baseUnit")} (${item.unit})` },
        ...(item.sleeve === 25
          ? [{ value: "SLEEVE_25", label: t("sleeves") }]
          : []),
      ],
    });
    const note = field(container, t(action === "WASTE" ? "reason" : "note"), {
      type: "textarea",
      required: action === "WASTE",
      maxLength: 500,
    });
    return () =>
      write("/movements", {
        action,
        note: note.value,
        items: [
          {
            id: item.id,
            revision: item.revision,
            value: value.value,
            unit: unit.value,
            approx: false,
            low: false,
          },
        ],
      });
  });
}
function productDialog(source = null) {
  const item = source ? effective(source) : null;
  dialog(t(source ? "edit" : "addProduct"), (container) => {
    const ru = field(container, t("nameRu"), {
      value: item?.ru,
      maxLength: 160,
    });
    const en = field(container, t("nameEn"), {
      value: item?.en,
      required: false,
      maxLength: 160,
    });
    const categoryInput = field(container, t("category"), {
      value: item?.category || state.categories[0],
      options: state.categories.map((value) => ({
        value,
        label: category(value),
      })),
    });
    const unit = field(container, t("unit"), {
      value: item?.unit || "kg",
      options: ["l", "kg", "pcs", "pack", "roll"].map((value) => ({
        value,
        label: value,
      })),
    });
    const sleeve = checkbox(container, t("sleeve"), item?.sleeve === 25);
    const noMinimum = checkbox(
      container,
      t("unsetMinimum"),
      item ? item.minimum === null : true,
    );
    const minimum = field(container, t("minimum"), {
      value: item?.minimum || "0",
    });
    minimum.inputMode = "decimal";
    minimum.disabled = noMinimum.checked;
    noMinimum.onchange = () => {
      minimum.disabled = noMinimum.checked;
    };
    const hours = field(container, t("hours"), {
      value: String(item?.hours || 24),
      type: "number",
    });
    hours.min = "1";
    hours.max = "8760";
    hours.step = "1";
    const notes = field(container, t("notes"), {
      value: item?.notes,
      required: false,
      type: "textarea",
      maxLength: 500,
    });
    const active = checkbox(container, t("active"), item?.active ?? true);
    container.append(el("label", "", t("zones")));
    const assigned = state.zones.map((zone) => [
      zone.id,
      checkbox(container, zone[lang], item?.zones.includes(zone.id)),
    ]);
    const stage =
      source &&
      state.session?.status === "OPEN" &&
      state.session.owner === state.user.email
        ? checkbox(container, t("stage"), false)
        : null;
    if (stage) {
      const controls = [
        ru,
        en,
        categoryInput,
        unit,
        sleeve,
        noMinimum,
        minimum,
        hours,
        notes,
      ];
      const requirements = new Map(
        controls.map((control) => [control, control.required]),
      );
      stage.onchange = () => {
        for (const control of controls) {
          control.disabled =
            stage.checked || (control === minimum && noMinimum.checked);
          control.required = !stage.checked && requirements.get(control);
        }
      };
    }
    return async () => {
      const selectedZones = assigned
        .filter(([, node]) => node.checked)
        .map(([id]) => id);
      if (stage?.checked) {
        state.changes = state.changes.filter(
          (change) => change.id !== source.id,
        );
        state.changes.push({
          id: source.id,
          version: source.version,
          active: active.checked,
          zones: selectedZones,
        });
        state.session.items = state.session.items.filter(
          (spec) => spec.id !== source.id,
        );
        if (active.checked)
          state.session.items.push({
            ...source,
            zones: selectedZones,
            previous: source.quantity,
            checked: false,
          });
        if (!active.checked) delete state.drafts[source.id];
        persistDraft();
        $("#form-dialog").close();
        render();
        toast(t("staged"));
        return;
      }
      await write("/products", {
        ...(source ? { id: source.id, version: source.version } : {}),
        product: {
          ru: ru.value,
          en: en.value,
          category: categoryInput.value,
          unit: unit.value,
          sleeve: sleeve.checked ? 25 : 0,
          minimum: noMinimum.checked ? null : minimum.value,
          hours: Number(hours.value),
          notes: notes.value,
          active: active.checked,
          zones: selectedZones,
        },
      });
    };
  });
}
function noteDialog(note = null) {
  dialog(t("reminders"), (container) => {
    const input = field(container, t("note"), {
      type: "textarea",
      value: note?.text,
      maxLength: 1000,
    });
    return () =>
      write("/reminders", {
        id: note?.id || uuid(),
        ...(note ? { version: note.version } : {}),
        text: input.value,
        done: note?.done || false,
      });
  });
}
function cardDialog() {
  dialog(t("yellowCards"), (container) => {
    const id = field(container, t("cardCode"), { maxLength: 20 });
    const name = field(container, t("name"), { maxLength: 160 });
    const size = field(container, t("size"), {
      required: false,
      maxLength: 100,
    });
    const categoryInput = field(container, t("category"), {
      value: "A",
      maxLength: 100,
    });
    const note = field(container, t("note"), {
      required: false,
      type: "textarea",
      maxLength: 500,
    });
    return () =>
      write("/cards", {
        action: "add",
        id: id.value,
        name: name.value,
        size: size.value,
        category: categoryInput.value,
        note: note.value,
      });
  });
}
async function correctionDialog(entry) {
  const { data } = await api(`/history/${encodeURIComponent(entry.id)}`);
  dialog(t("correction"), (container) => {
    container.append(
      el(
        "p",
        "muted",
        `${name(entry)} · ${t("original")}: ${qty(entry.quantity)} ${entry.unit}`,
      ),
    );
    const value = field(container, t("quantity"), { value: entry.quantity });
    value.inputMode = "decimal";
    const mode = field(container, t("correctionMode"), {
      value: "HISTORY_ONLY",
      options: [
        { value: "HISTORY_ONLY", label: t("historyOnly") },
        { value: "CURRENT", label: t("affectCurrent") },
      ],
    });
    const reason = field(container, t("correctionReason"), {
      type: "textarea",
      maxLength: 500,
    });
    const parent =
      state.history.revisions.find(
        (revision) => revision.sessionId === entry.sessionId,
      )?.id || null;
    return () =>
      write(`/sessions/${encodeURIComponent(entry.sessionId)}/corrections`, {
        mode: mode.value,
        reason: reason.value,
        parentId: parent,
        changes: [{ id: entry.id, version: data.version, value: value.value }],
      });
  });
}
async function userDialog() {
  const { data } = await api("/admin/users");
  dialog(t("staffAccess"), (container) => {
    container.append(el("p", "hint", t("accountHelp")));
    const list = el("div", "dialog-list");
    const email = field(container, t("email"), { type: "email" });
    const name = field(container, t("displayName"), {
      required: false,
      maxLength: 80,
    });
    const role = field(container, t("role"), {
      options: [
        { value: "staff", label: t("staff") },
        { value: "owner", label: t("owner") },
      ],
    });
    const enabled = checkbox(container, t("enabled"), true);
    const code = field(container, t("newAccessCode"), {
      type: "password",
      required: false,
    });
    code.autocomplete = "new-password";
    code.minLength = 12;
    for (const user of data.users.filter(
      (user) => user.email !== "developer@local.invalid",
    )) {
      const row = el("article", "information-row");
      row.append(
        el(
          "span",
          "product-detail",
          `${user.email} · ${t(user.role)}${user.provisioned ? "" : " · —"}`,
        ),
        button(t("edit"), () => {
          email.value = user.email;
          name.value = user.name;
          role.value = user.role;
          enabled.checked = Boolean(user.enabled);
          code.value = "";
        }),
      );
      list.append(row);
    }
    container.prepend(list);
    return async () => {
      // Access codes are deliberately excluded from persistent operation/draft storage.
      await api("/admin/users", {
        method: "POST",
        operationId: uuid(),
        body: {
          email: email.value,
          name: name.value,
          role: role.value,
          enabled: enabled.checked,
          ...(code.value ? { code: code.value } : {}),
        },
      });
      code.value = "";
      $("#form-dialog").close();
      await refresh();
      toast(t("saved"));
    };
  });
}
async function deliveryDialog() {
  const { data } = await api("/admin/notifications");
  dialog(t("deliveryQueue"), (container) => {
    $("#dialog-save").hidden = true;
    if (!data.reports.length)
      container.append(el("p", "muted", t("noReports")));
    for (const report of data.reports) {
      const row = el("article", "information-row");
      const description = el("div");
      description.append(
        el("strong", "", report.status),
        el(
          "p",
          "",
          `${date(report.createdAt)} · ${report.attempts}${report.error ? ` · ${report.error}` : ""}`,
        ),
      );
      row.append(description);
      if (["FAILED", "UNKNOWN"].includes(report.status))
        row.append(
          button(
            t("retry"),
            async () => {
              if (
                report.status === "UNKNOWN" &&
                !confirm(t("deliveryUncertain"))
              )
                return;
              await write("/admin/notifications/retry", {
                id: report.id,
                acknowledgeDuplicateRisk: report.status === "UNKNOWN",
              });
            },
            { online: true },
          ),
        );
      container.append(row);
    }
    return null;
  });
}

$("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  guard(async () => {
    const submit = event.target.querySelector('[type="submit"]');
    submit.disabled = true;
    $("#login-error").textContent = "";
    try {
      await api("/session", {
        method: "POST",
        body: { email: $("#email").value, code: $("#code").value },
      });
      $("#code").value = "";
      if ("caches" in window) await caches.delete("varka-data-v2");
      await refresh();
    } catch (error) {
      $("#login-error").textContent = friendly(error);
    } finally {
      submit.disabled = false;
    }
  });
});
$("#logout").addEventListener("click", () =>
  guard(async () => {
    await api("/session", { method: "DELETE", body: {} });
    if ("caches" in window) await caches.delete("varka-data-v2");
    state.products = [];
    state.history = { entries: [], revisions: [] };
    state.information = { cards: [], reminders: [] };
    loginView();
    notice(t("locked"));
  }),
);
$("#language").addEventListener("click", () => {
  lang = lang === "ru" ? "en" : "ru";
  try {
    put("varka-language", lang);
  } catch {}
  render();
});
document.querySelectorAll("[data-view]").forEach((node) =>
  node.addEventListener("click", () =>
    guard(async () => {
      state.view = node.dataset.view;
      render();
      if (state.view === "history") await loadHistory();
      if (state.view === "information") await loadInformation();
    }),
  ),
);
$("#refresh").addEventListener("click", refresh);
$("#retry").addEventListener("click", () =>
  guard(async () => {
    if (state.pending) await perform(state.pending);
  }),
);
$("#primary-action").addEventListener("click", () =>
  guard(async () => {
    if (state.view === "catalog") productDialog();
    else {
      await write("/sessions", {});
    }
  }),
);
$("#search").addEventListener("input", () => {
  renderStock();
  renderCatalog();
  renderSessions();
});
$("#category-filter").addEventListener("change", render);
$("#low-filter").addEventListener("click", () => {
  state.lowOnly = !state.lowOnly;
  $("#low-filter").setAttribute("aria-pressed", state.lowOnly);
  render();
});
$("#show-inactive").addEventListener("change", renderCatalog);
$("#session-back").addEventListener("click", () => {
  persistDraft();
  state.session = null;
  state.drafts = {};
  state.changes = [];
  remove(key("current-session"));
  render();
});
$("#clear-draft").addEventListener("click", () => {
  if (state.pending || !confirm(t("confirmClear"))) return;
  state.drafts = {};
  persistDraft();
  render();
});
$("#session-refresh").addEventListener("click", () =>
  guard(async () => {
    if (state.session)
      await write(`/sessions/${encodeURIComponent(state.session.id)}/refresh`, {
        version: state.session.version,
      });
  }),
);
$("#keep-current").addEventListener("change", persistDraft);
$("#incomplete").addEventListener("change", persistDraft);
$("#submit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  guard(async () => {
    if (!state.session || !state.storageOkay || !confirm(t("confirmSubmit")))
      return;
    const items = Object.entries(state.drafts)
      .filter(([, entry]) => entered(entry))
      .map(([id, entry]) => ({ id, ...entry }));
    await write(`/sessions/${encodeURIComponent(state.session.id)}/submit`, {
      version: state.session.version,
      items,
      blankPolicy: $("#keep-current").checked ? "KEEP_CURRENT" : "REQUIRE_ALL",
      incomplete: $("#incomplete").checked,
      productChanges: state.changes,
    });
  });
});
$("#more-history").addEventListener("click", () =>
  guard(() => loadHistory(true)),
);
$("#add-note").addEventListener("click", () => noteDialog());
$("#add-card").addEventListener("click", cardDialog);
$("#profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  guard(() =>
    write("/profile", {
      name: $("#display-name").value,
      version: state.user.version,
    }),
  );
});
$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  guard(() =>
    write("/notification-settings", {
      enabled: $("#alerts-enabled").checked,
      mode: $("#report-mode").value,
      version: state.settings.version,
    }),
  );
});
$("#manage-users").addEventListener("click", () => guard(userDialog));
$("#delivery-queue").addEventListener("click", () => guard(deliveryDialog));
document.querySelectorAll("[data-close]").forEach((node) =>
  node.addEventListener("click", () => {
    if (!node.closest("dialog").dataset.saving) node.closest("dialog").close();
  }),
);
$("#form-dialog").addEventListener("cancel", (event) => {
  if ($("#form-dialog").dataset.saving) event.preventDefault();
});
$("#form-dialog").addEventListener("close", () => {
  $("#dialog-fields").replaceChildren();
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
});
$("#install").addEventListener("click", async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    installPrompt = null;
  } else $("#install-dialog").showModal();
});
if (matchMedia("(display-mode: standalone)").matches || navigator.standalone)
  $("#install").hidden = true;
window.addEventListener("appinstalled", () => {
  $("#install").hidden = true;
});
window.addEventListener("offline", () => {
  online(false);
  notice(t("offlineNotice"));
});
window.addEventListener("online", refresh);
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    state.user &&
    !$("#form-dialog").open
  )
    refresh();
});
setInterval(() => {
  if (
    state.user &&
    document.visibilityState === "visible" &&
    !$("#form-dialog").open &&
    state.view !== "count" &&
    !state.pending
  )
    refresh();
}, 30_000);

async function start() {
  render();
  for (const selector of [
    '#profile-form [type="submit"]',
    '#settings-form [type="submit"]',
  ])
    $(selector).dataset.online = "true";
  if ("serviceWorker" in navigator && window.isSecureContext) {
    try {
      await navigator.serviceWorker.register("/varka-sw.js");
      await navigator.serviceWorker.ready;
    } catch {
      notice(t("offlineHelp"));
    }
  }
  try {
    const { data } = await api("/session");
    if (!data.user) {
      loginView();
      return;
    }
  } catch {
    /* A saved bootstrap snapshot may be available offline. */
  }
  await refresh();
}
start();
