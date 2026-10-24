const $ = (selector) => document.querySelector(selector);
const categories = [
  "Coffee",
  "Milk & alternatives",
  "Syrups & tea",
  "Food",
  "Supplies",
  "Other",
];
const categoryIcons = ["coffee", "milk", "syrups", "food", "supplies", "other"];
const units = ["kg", "g", "L", "ml", "pcs"];
const state = {
  items: [],
  movements: [],
  connected: false,
  loaded: false,
  lowOnly: false,
  view: "stock",
  selectedId: null,
  syncing: false,
};
let installPrompt;
let toastTimeout;
let pendingMovement;
const number = (value) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
const date = (value) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notice(message = "") {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
}
function toast(message) {
  clearTimeout(toastTimeout);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimeout = setTimeout(() => {
    $("#toast").hidden = true;
  }, 4000);
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      signal: AbortSignal.timeout(12_000),
      headers: {
        ...(options.body
          ? { "Content-Type": "application/json", "X-Inventory-Request": "1" }
          : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error(
      "Cannot reach the shop server. Check your connection and try again.",
    );
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(
      data.error || "This request could not be completed.",
    );
    error.status = response.status;
    throw error;
  }
  return { data, offline: response.headers.get("X-Inventory-Offline") === "1" };
}

function connected(value) {
  state.connected = value;
  const status = $("#connection");
  status.classList.toggle("offline", !value);
  status.replaceChildren(
    element("span", "status-dot"),
    document.createTextNode(value ? "Shop connected" : "Offline · view only"),
  );
  $("#add-item").disabled = !value;
  document.querySelectorAll(".row-action").forEach((button) => {
    button.disabled = !value;
  });
  for (const form of [$("#item-form"), $("#movement-form")])
    form.querySelector('[type="submit"]').disabled = !value;
}

function showLogin() {
  $("#workspace").hidden = true;
  $("#login-panel").hidden = false;
  $("#logout").hidden = true;
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("#password").focus();
}

async function refresh() {
  if (state.syncing) return;
  state.syncing = true;
  $("#refresh").disabled = true;
  try {
    const [items, movements] = await Promise.all([
      request("/api/items"),
      request("/api/movements"),
    ]);
    state.items = items.data.items;
    state.movements = movements.data.movements;
    state.loaded = true;
    connected(!items.offline && !movements.offline);
    $("#login-panel").hidden = true;
    $("#workspace").hidden = false;
    $("#synced").textContent =
      `${state.connected ? "Synced" : "Saved snapshot"} ${date(items.data.syncedAt)}`;
    notice(
      state.connected
        ? ""
        : "You’re viewing the last saved inventory on this device. Stock changes need a connection to the shop server.",
    );
    render();
  } catch (error) {
    connected(false);
    if (error.status === 401) {
      showLogin();
      notice("Your session has ended. Enter the shop password again.");
    } else {
      notice(error.message);
      if (!state.loaded) {
        $("#workspace").hidden = false;
        $("#item-list").replaceChildren(
          element(
            "p",
            "empty",
            "No saved inventory is available. Connect to the shop server and tap Refresh.",
          ),
        );
      }
    }
  } finally {
    state.syncing = false;
    $("#refresh").disabled = false;
  }
}

function render() {
  $("#stat-items").textContent = state.items.length;
  $("#stat-low").textContent = state.items.filter(
    (item) => item.lowStock,
  ).length;
  $("#stat-categories").textContent = new Set(
    state.items.map((item) => item.category),
  ).size;
  $("#item-count").textContent = state.items.length;
  const query = $("#search").value.trim().toLocaleLowerCase();
  const category = $("#category-filter").value;
  const filtered = state.items.filter(
    (item) =>
      (!query ||
        `${item.name} ${item.category}`.toLocaleLowerCase().includes(query)) &&
      (!category || item.category === category) &&
      (!state.lowOnly || item.lowStock),
  );
  const list = $("#item-list");
  list.replaceChildren();
  for (const item of filtered) {
    const row = element("article", "inventory-row");
    const identity = element("div", "item-identity");
    const iconId = categoryIcons[categories.indexOf(item.category)] || "other";
    const icon = element("span", `category-icon category-${iconId}`);
    icon.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `/icons/ui.svg#${iconId}`);
    svg.append(use);
    icon.append(svg);
    const description = element("div");
    description.append(
      element("div", "item-name", item.name),
      element("div", "item-category", item.category),
    );
    identity.append(icon, description);
    const stock = element("div", "stock-cell");
    const value = element("div", "stock-value", number(item.quantity));
    value.append(
      document.createTextNode(" "),
      element("span", "unit", item.unit),
    );
    stock.append(
      value,
      element(
        "div",
        "stock-minimum",
        `Min. ${number(item.minimum)} ${item.unit}`,
      ),
    );
    const status = element(
      "span",
      `stock-status${item.quantity === 0 ? " zero" : item.lowStock ? " low" : ""}`,
      `${item.quantity === 0 ? "○ Out of stock" : item.lowStock ? "↘ Running low" : "✓ Well stocked"}`,
    );
    const action = element("button", "row-action", "Update stock ↗");
    action.type = "button";
    action.disabled = !state.connected;
    action.setAttribute("aria-label", `Update stock for ${item.name}`);
    action.addEventListener("click", () => openMovement(item));
    row.append(identity, stock, status, action);
    list.append(row);
  }
  if (!filtered.length) {
    const empty = element("div", "empty");
    empty.append(
      element(
        "strong",
        "",
        state.items.length
          ? "No items match just yet."
          : "A fresh shelf. A fresh start.",
      ),
      element(
        "div",
        "",
        state.items.length
          ? "Try a different search or clear your filters."
          : "Add your first coffee, carton, or everyday essential.",
      ),
    );
    if (!state.items.length) {
      const button = element(
        "button",
        "button primary",
        "＋ Add your first item",
      );
      button.disabled = !state.connected;
      button.addEventListener("click", openItem);
      empty.append(button);
    }
    list.append(empty);
  }
  $("#results").textContent =
    state.view === "stock"
      ? `Showing ${filtered.length} of ${state.items.length} items`
      : `Showing ${state.movements.length} recent changes`;
  const activity = $("#activity-list");
  activity.replaceChildren();
  for (const movement of state.movements) {
    const row = element("article", "activity-row");
    const description = element("div");
    description.append(
      element("div", "activity-name", movement.itemName),
      element(
        "div",
        "activity-note",
        `${{ in: "Stock in", out: "Stock out", count: "Physical count", opening: "Opening stock" }[movement.type]}${movement.note ? ` · ${movement.note}` : ""}`,
      ),
      element("div", "activity-date", date(movement.createdAt)),
    );
    const amount = element(
      "div",
      "activity-amount",
      `${movement.delta > 0 ? "+" : ""}${number(movement.delta)} ${movement.unit}`,
    );
    amount.append(
      element(
        "small",
        "",
        `Balance ${number(movement.balance)} ${movement.unit}`,
      ),
    );
    row.append(description, amount);
    activity.append(row);
  }
  if (!state.movements.length)
    activity.append(
      element(
        "p",
        "empty",
        "Stock changes will appear here when you add your first item.",
      ),
    );
}

function openItem() {
  if (!state.connected) return;
  $("#item-form").reset();
  $("#item-error").textContent = "";
  $("#item-dialog").showModal();
}

function movementType() {
  const type = $("#movement-type").value;
  $("#movement-quantity-label").textContent =
    type === "count"
      ? "Physical quantity on the shelf"
      : type === "out"
        ? "Quantity to remove"
        : "Quantity to add";
  $("#movement-quantity").min = type === "count" ? "0" : "0.001";
  $("#count-help").hidden = type !== "count";
}

function openMovement(item) {
  if (!state.connected) return;
  state.selectedId = item.id;
  pendingMovement = null;
  $("#movement-form").reset();
  movementType();
  $("#movement-error").textContent = "";
  $("#movement-title").textContent = item.name;
  $("#movement-current").textContent =
    `Currently on the shelf: ${number(item.quantity)} ${item.unit}`;
  $("#movement-dialog").showModal();
}

async function submit(form, errorElement, task) {
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  errorElement.textContent = "";
  form.querySelectorAll("[data-close]").forEach((button) => {
    button.disabled = true;
  });
  form.closest("dialog")?.setAttribute("data-saving", "true");
  try {
    await task();
  } catch (error) {
    errorElement.textContent = error.message;
    if (error.status === 401) showLogin();
  } finally {
    button.disabled = !state.connected && form.id !== "login-form";
    form.querySelectorAll("[data-close]").forEach((button) => {
      button.disabled = false;
    });
    form.closest("dialog")?.removeAttribute("data-saving");
  }
}

$("#item-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submit(event.currentTarget, $("#item-error"), async () => {
    const form = new FormData($("#item-form"));
    await request("/api/items", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        category: form.get("category"),
        unit: form.get("unit"),
        quantity: Number(form.get("quantity")),
        minimum: Number(form.get("minimum")),
      }),
    });
    $("#item-dialog").close();
    await refresh();
    toast("A new essential, on the shelf.");
  });
});

$("#movement-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submit(event.currentTarget, $("#movement-error"), async () => {
    const form = new FormData($("#movement-form"));
    const body = JSON.stringify({
      type: form.get("type"),
      quantity: Number(form.get("quantity")),
      note: form.get("note"),
    });
    if (!pendingMovement || pendingMovement.body !== body)
      pendingMovement = { body, key: crypto.randomUUID() };
    await request(`/api/items/${state.selectedId}/movements`, {
      method: "POST",
      body,
      headers: { "Idempotency-Key": pendingMovement.key },
    });
    pendingMovement = null;
    $("#movement-dialog").close();
    await refresh();
    toast("Stock updated. You’re all set.");
  });
});

$("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submit(event.currentTarget, $("#login-error"), async () => {
    await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ password: $("#password").value }),
    });
    $("#password").value = "";
    $("#logout").hidden = false;
    await refresh();
  });
});

$("#logout").addEventListener("click", async () => {
  try {
    await request("/api/session", { method: "DELETE", body: "{}" });
    if ("caches" in window) await caches.delete("daily-stock-data-v1");
    state.items = [];
    state.movements = [];
    state.loaded = false;
    pendingMovement = null;
    render();
    notice("Shop locked. Saved inventory was cleared from this device.");
    showLogin();
  } catch (error) {
    notice(error.message);
  }
});

for (const category of categories) {
  $("#category-filter").append(new Option(category, category));
  $("#item-category").append(new Option(category, category));
}
for (const unit of units) $("#item-unit").append(new Option(unit, unit));
$("#add-item").addEventListener("click", openItem);
$("#refresh").addEventListener("click", refresh);
$("#search").addEventListener("input", render);
$("#category-filter").addEventListener("change", render);
$("#low-filter").addEventListener("click", () => {
  state.lowOnly = !state.lowOnly;
  $("#low-filter").setAttribute("aria-pressed", state.lowOnly);
  render();
});
$("#movement-type").addEventListener("change", movementType);
for (const view of ["stock", "activity"])
  $(`#${view}-tab`).addEventListener("click", () => {
    state.view = view;
    for (const name of ["stock", "activity"]) {
      $(`#${name}-view`).hidden = name !== view;
      $(`#${name}-tab`).setAttribute("aria-pressed", name === view);
      $(`#${name}-tab`).classList.toggle("active", name === view);
    }
    render();
  });
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
document.querySelectorAll("dialog").forEach((dialog) =>
  dialog.addEventListener("cancel", (event) => {
    if (dialog.dataset.saving) event.preventDefault();
  }),
);
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
window.addEventListener("appinstalled", () => {
  $("#install").hidden = true;
});
if (matchMedia("(display-mode: standalone)").matches || navigator.standalone)
  $("#install").hidden = true;
window.addEventListener("online", refresh);
window.addEventListener("offline", () => {
  connected(false);
  notice(
    "You’re offline. Your saved shelf is available to view; reconnect to record changes.",
  );
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && $("#login-panel").hidden)
    refresh();
});
setInterval(() => {
  if (
    document.visibilityState === "visible" &&
    $("#login-panel").hidden &&
    !document.querySelector("dialog[open]")
  )
    refresh();
}, 30_000);

async function start() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    try {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    } catch {
      notice(
        "Offline setup is unavailable in this browser. Inventory still works while connected.",
      );
    }
  }
  try {
    const { data } = await request("/api/session");
    if (!data.authenticated) {
      showLogin();
      connected(true);
      return;
    }
    $("#logout").hidden = !data.passwordRequired;
  } catch {
    /* The service worker may still have the last inventory snapshot. */
  }
  await refresh();
}
start();
