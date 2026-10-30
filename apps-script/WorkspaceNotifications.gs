/* Session-free workspace notifications. Telegram credentials remain private
 * Script Properties. Inventory commits never depend on Telegram availability.
 * An UNKNOWN delivery is intentionally not automatically retried: Telegram's
 * sendMessage API has no idempotency key for an ambiguous network outcome. */
function workspaceNotificationHash_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8,
  )
    .map((n) => ("0" + ((n + 256) % 256).toString(16)).slice(-2))
    .join("");
}

function workspaceNotificationWords_(language) {
  return language === "ru"
    ? {
        title: "VARKA · Остатки",
        all: "Весь каталог",
        entered: "Пересчитано в этой отправке",
        low: "Отмечено вручную: мало",
        inactive: "Неактивный",
        fresh: "Пересчитано сейчас",
        previous: "Ранее записано",
        uncounted: "Не пересчитано",
        approximate: "Примерно",
        lowFlag: "Мало",
        counted: "Последний пересчёт",
        reminder: "VARKA · Пора пересчитать",
        reminderHelp:
          "Подтвердите остаток новым пересчётом, даже если количество не изменилось.",
        none: "Нет подходящих товаров.",
        units: { l: "л", kg: "кг", pcs: "шт.", pack: "уп.", roll: "рул." },
      }
    : {
        title: "VARKA · Inventory",
        all: "Entire catalog",
        entered: "Counted in this submission",
        low: "Manually marked Low",
        inactive: "Inactive",
        fresh: "Fresh recount",
        previous: "Previously recorded",
        uncounted: "Not counted",
        approximate: "Approximate",
        lowFlag: "Low",
        counted: "Last recount",
        reminder: "VARKA · Recount due",
        reminderHelp:
          "Confirm the stock with a new recount, even if the quantity is unchanged.",
        none: "No matching products.",
        units: { l: "l", kg: "kg", pcs: "pcs", pack: "pack", roll: "roll" },
      };
}

function workspaceNotificationNumber_(value, language) {
  // Do not round accepted eight-decimal quantities merely for a notification.
  const text = Number(value).toFixed(8).replace(/\.?0+$/, "");
  return language === "ru" ? text.replace(".", ",") : text;
}

function workspaceNotificationDate_(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "";
  return Utilities.formatDate(
    new Date(value),
    prop_().getProperty("CAFE_TIMEZONE") || "Europe/Minsk",
    "dd.MM.yyyy HH:mm",
  );
}

function workspaceNotificationLines_(products, accepted, language, words) {
  const fresh = new Map(accepted.map((item) => [item.id, item]));
  return products.map((product) => {
    const recount = fresh.get(product.id);
    const source = recount || product;
    const name =
      language === "ru"
        ? product.ru || product.en || product.id
        : product.en || product.ru || product.id;
    const labels = [];
    if (!product.active) labels.push(words.inactive);
    if (source.approx) labels.push(words.approximate);
    if (source.low) labels.push(words.lowFlag);
    const flags = labels.length ? " [" + labels.join(", ") + "]" : "";
    const quantity =
      source.last === null || source.last === undefined
        ? words.uncounted
        : (recount ? words.fresh : words.previous) +
          ": " +
          workspaceNotificationNumber_(source.last, language) +
          " " +
          (words.units[source.unit || product.unit] ||
            source.unit ||
            product.unit);
    const date = workspaceNotificationDate_(source.lastCountedAt);
    return (
      product.id +
      " · " +
      name +
      flags +
      "\n" +
      quantity +
      (date ? "\n" + words.counted + ": " + date : "")
    );
  });
}

function workspaceNotificationChunks_(heading, lines) {
  const chunks = [];
  let current = heading;
  for (const line of lines) {
    // Product/name bounds keep a single item comfortably below Telegram's
    // limit. Avoid slicing a product in half or losing its freshness label.
    if (current.length + line.length + 2 > 3500) {
      chunks.push(current);
      current = heading;
    }
    current += "\n\n" + line;
  }
  chunks.push(current);
  return chunks;
}

function workspaceNotification_(request, result, products, email) {
  const options = request.notification || {};
  const language = options.language === "ru" ? "ru" : "en";
  const scope = options.scope || "ENTERED";
  if (!["ALL", "ENTERED", "LOW"].includes(scope))
    throw Error("INVALID_NOTIFICATION_SCOPE");
  if (
    !Array.isArray(options.lowIds || []) ||
    (options.lowIds || []).some((id) => typeof id !== "string")
  )
    throw Error("INVALID_LOW_ITEMS");
  const accepted = result.accepted || [];
  const acceptedIds = new Set(accepted.map((item) => item.id));
  const lowIds = new Set(options.lowIds || []);
  // These IDs are the manual Low flags from the immutable confirmed snapshot,
  // not quantity-threshold calculations, search results, or current filters.
  const selected = products
    .filter((product) =>
      scope === "ALL"
        ? true
        : scope === "ENTERED"
          ? acceptedIds.has(product.id)
          : lowIds.has(product.id),
    )
    .map((product) => ({ ...product, low: lowIds.has(product.id) }));
  const words = workspaceNotificationWords_(language);
  const label =
    scope === "ALL" ? words.all : scope === "LOW" ? words.low : words.entered;
  const lines = workspaceNotificationLines_(
    selected,
    accepted,
    language,
    words,
  );
  const messages = workspaceNotificationChunks_(
    words.title + "\n" + label,
    lines.length ? lines : [words.none],
  );
  const configured = Boolean(
    prop_().getProperty("TELEGRAM_TOKEN") &&
    prop_().getProperty("TELEGRAM_CHAT_ID"),
  );
  return {
    version: 1,
    status: configured ? "READY" : "NOT_CONFIGURED",
    scope: scope,
    language: language,
    messages: messages,
    delivery: messages.map(() => ({ state: "READY" })),
    createdAt: new Date().toISOString(),
  };
}

function workspaceNotificationPublic_(notification) {
  return {
    status: notification.status,
    scope: notification.scope,
    language: notification.language,
    delivered: notification.delivery.filter((item) => item.state === "SENT")
      .length,
    total: notification.delivery.length,
    error: notification.error || null,
  };
}

function workspaceDeliver_(operationId, email, allowReminder) {
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const claim = v3Lock_(() => {
      const operation = workspaceOperation_(operationId);
      if (!operation || operation.actor !== email)
        throw Error("OPERATION_NOT_FOUND");
      if (
        operation.kind !== "count" &&
        !(
          allowReminder === true &&
          operation.kind === "reminder" &&
          email === "system:reminders"
        )
      )
        throw Error("INVALID_OPERATION_KIND");
      if (operation.kind === "count" && operation.result.state !== "COMMITTED")
        throw Error("INVENTORY_NOT_CONFIRMED");
      const notification = operation.result.notification;
      if (!notification || notification.version !== 1)
        throw Error("NOTIFICATION_NOT_AVAILABLE");
      if (notification.status === "SENT" || notification.status === "UNKNOWN")
        return { done: workspaceNotificationPublic_(notification) };
      if (operation.kind === "reminder") {
        const reminder = operation.result.reminder;
        if (!reminder || !reminder.productId || !reminder.countVersion)
          throw Error("INVALID_REMINDER");
        const current = workspaceProducts_().find(
          (product) => product.id === reminder.productId,
        );
        // A recount, status change, or interval edit may have happened after
        // scheduler enumeration. Recheck at the actual delivery claim.
        if (
          !current ||
          !current.active ||
          !(Number(current.reminderHours) > 0) ||
          !current.lastCountedAt ||
          (current.lastCountId || current.lastCountedAt) !==
            reminder.countVersion ||
          !Number.isFinite(Date.parse(current.lastCountedAt)) ||
          Date.now() <
            Date.parse(current.lastCountedAt) +
              Number(current.reminderHours) * 3600000
        )
          return {
            done: {
              ...workspaceNotificationPublic_(notification),
              status: "DEFERRED",
              error: "REMINDER_NOT_DUE",
            },
          };
      }
      const token = prop_().getProperty("TELEGRAM_TOKEN");
      const chat = prop_().getProperty("TELEGRAM_CHAT_ID");
      if (!token || !chat) {
        notification.status = "NOT_CONFIGURED";
        notification.error = "TELEGRAM_NOT_CONFIGURED";
        workspaceWriteResult_(operation, operation.result);
        return { done: workspaceNotificationPublic_(notification) };
      }
      const index = notification.delivery.findIndex(
        (item) => item.state !== "SENT",
      );
      if (index < 0) {
        notification.status = "SENT";
        notification.error = null;
        workspaceWriteResult_(operation, operation.result);
        return { done: workspaceNotificationPublic_(notification) };
      }
      if (notification.delivery[index].state === "UNKNOWN") {
        notification.status = "UNKNOWN";
        workspaceWriteResult_(operation, operation.result);
        return { done: workspaceNotificationPublic_(notification) };
      }
      // Persist UNKNOWN *before* making a non-idempotent external call. Another
      // invocation, or an interrupted execution, may never send this again.
      notification.delivery[index] = { state: "UNKNOWN" };
      notification.status = "UNKNOWN";
      notification.error = null;
      workspaceWriteResult_(operation, operation.result);
      return {
        index: index,
        text: notification.messages[index],
        token: token,
        chat: chat,
      };
    });
    if (claim.done) return claim.done;
    let outcome;
    try {
      const response = UrlFetchApp.fetch(
        "https://api.telegram.org/bot" + claim.token + "/sendMessage",
        {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify({ chat_id: claim.chat, text: claim.text }),
          muteHttpExceptions: true,
        },
      );
      const code = response.getResponseCode();
      let body;
      try {
        body = JSON.parse(response.getContentText());
      } catch (ignored) {
        body = null;
      }
      if (
        code === 200 &&
        body &&
        body.ok === true &&
        body.result &&
        body.result.message_id
      )
        outcome = { state: "SENT", messageId: body.result.message_id };
      else if (
        [400, 401, 403, 404, 409, 429].includes(code) &&
        body &&
        body.ok === false
      )
        outcome = { state: "FAILED", error: "TELEGRAM_REJECTED" };
      else outcome = { state: "UNKNOWN", error: "TELEGRAM_DELIVERY_UNKNOWN" };
    } catch (ignored) {
      // Fetch errors can contain the URL and bot token. Never return/log them.
      outcome = { state: "UNKNOWN", error: "TELEGRAM_DELIVERY_UNKNOWN" };
    }
    const updated = v3Lock_(() => {
      const operation = workspaceOperation_(operationId);
      if (!operation || operation.actor !== email)
        throw Error("OPERATION_NOT_FOUND");
      const notification = operation.result.notification;
      notification.delivery[claim.index] = outcome;
      notification.status =
        outcome.state === "SENT"
          ? notification.delivery.every((item) => item.state === "SENT")
            ? "SENT"
            : "READY"
          : outcome.state;
      notification.error = outcome.error || null;
      workspaceWriteResult_(operation, operation.result);
      return workspaceNotificationPublic_(notification);
    });
    if (updated.status !== "READY") return updated;
  }
  return v3Lock_(() =>
    workspaceNotificationPublic_(
      workspaceOperation_(operationId).result.notification,
    ),
  );
}

function workspaceRemindersConfigured_() {
  return ScriptApp.getProjectTriggers().some(
    (trigger) => trigger.getHandlerFunction() === "workspaceReminderTick_",
  );
}

// Explicit owner/editor setup; ordinary browser users cannot call this through
// the bridge. Installing never sends a message or alters an existing trigger.
function installWorkspaceReminders() {
  v4Owner_();
  if (prop_().getProperty("WORKSPACE_INSTALLED") !== "1")
    throw Error("WORKSPACE_NOT_INSTALLED");
  if (!workspaceRemindersConfigured_())
    ScriptApp.newTrigger("workspaceReminderTick_")
      .timeBased()
      .everyHours(1)
      .create();
  return { configured: workspaceRemindersConfigured_() };
}

// One deterministic reminder operation per product's successful recount time.
// A movement, catalog edit, refresh, visit, or failed count cannot reset it.
function workspaceReminderTick() {
  v4Owner_();
  return workspaceReminderTick_();
}
function workspaceReminderTick_() {
  if (prop_().getProperty("WORKSPACE_INSTALLED") !== "1") return;
  if (prop_().getProperty("PWA_WRITES_ENABLED") !== "true") return;
  const language =
    prop_().getProperty("WORKSPACE_REMINDER_LANGUAGE") === "ru" ? "ru" : "en";
  const ids = v3Lock_(() =>
    workspaceProducts_()
      .filter(
        (product) =>
          product.active &&
          Number(product.reminderHours) > 0 &&
          product.lastCountedAt &&
          Number.isFinite(Date.parse(product.lastCountedAt)) &&
          Date.now() >=
            Date.parse(product.lastCountedAt) +
              Number(product.reminderHours) * 3600000,
      )
      .map((product) => product.id),
  );
  const results = [];
  for (const productId of ids) {
    const operationId = v3Lock_(() => {
      const product = workspaceProducts_().find(
        (item) => item.id === productId,
      );
      if (
        !product ||
        !product.active ||
        !(Number(product.reminderHours) > 0) ||
        !product.lastCountedAt ||
        Date.now() <
          Date.parse(product.lastCountedAt) +
            Number(product.reminderHours) * 3600000
      )
        return null;
      const sheet = book_().getSheetByName("WorkspaceReminders");
      if (!sheet) throw Error("WORKSPACE_NOT_INSTALLED");
      const version = product.lastCountId || product.lastCountedAt;
      const rows = sheet.getDataRange().getValues();
      const index = rows.findIndex(
        (row, i) => i > 0 && row[0] === product.id && row[1] === version,
      );
      const id =
        "reminder-" + workspaceNotificationHash_(product.id + ":" + version);
      let operation = workspaceOperation_(id);
      if (!operation) {
        const words = workspaceNotificationWords_(language);
        const lines = workspaceNotificationLines_(
          [product],
          [],
          language,
          words,
        );
        const messages = workspaceNotificationChunks_(
          words.reminder,
          lines.concat([words.reminderHelp]),
        );
        const notification = {
          version: 1,
          status: "READY",
          scope: "REMINDER",
          language: language,
          messages: messages,
          delivery: messages.map(() => ({ state: "READY" })),
          createdAt: new Date().toISOString(),
        };
        operation = workspaceAppendOperation_(
          id,
          "system:reminders",
          "reminder",
          id,
          {
            id: id,
            reminder: { productId: product.id, countVersion: version },
            notification: notification,
          },
        );
      }
      if (index < 0) {
        sheet.appendRow([
          product.id,
          version,
          operation.result.notification.status,
          id,
          new Date().toISOString(),
        ]);
        SpreadsheetApp.flush();
      }
      const status = operation.result.notification.status;
      return status === "SENT" || status === "UNKNOWN" ? null : id;
    });
    if (!operationId) continue;
    const result = workspaceDeliver_(operationId, "system:reminders", true);
    v3Lock_(() => {
      const sheet = book_().getSheetByName("WorkspaceReminders");
      const rows = sheet.getDataRange().getValues();
      const index = rows.findIndex((row, i) => i > 0 && row[3] === operationId);
      if (index > 0) {
        sheet.getRange(index + 1, 3).setValue(result.status);
        sheet.getRange(index + 1, 5).setValue(new Date().toISOString());
        SpreadsheetApp.flush();
      }
    });
    results.push({ id: productId, notification: result });
  }
  return { processed: results.length, results: results };
}
