import { quantity } from "./model.js";
import { navigationLabel } from "./ui.js";

// Google Sheets workflows. All authoritative validation remains in Apps Script.
export function createFeatures(host) {
  const $ = (selector) => document.querySelector(selector);
  const tr = (en, ru) => (host.record().language === "ru" ? ru : en);
  const node = (tag, value, className) => {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  let view = "stock";
  const root = $("#feature-content");
  const dialog = $("#feature-dialog");
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const fields = [
      ...dialog.querySelectorAll("input,select,textarea,button,[tabindex]"),
    ].filter(
      (field) =>
        !field.disabled && field.tabIndex >= 0 && field.getClientRects().length,
    );
    const first = fields[0],
      last = fields.at(-1),
      active = document.activeElement;
    if (!first) return;
    // Native dialogs can send reverse-Tab from the first field to browser chrome.
    // Keep both directions predictable, including after an error-summary focus.
    if (
      event.shiftKey &&
      (active === first || active === dialog || active.tabIndex < 0)
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || active === dialog || active.tabIndex < 0)
    ) {
      event.preventDefault();
      first.focus();
    }
  });
  let formOpener;
  let labelId = 0;
  dialog.addEventListener("close", () => {
    if (formOpener?.isConnected && !formOpener.disabled)
      formOpener.focus({ preventScroll: true });
    else if (!$("#workspace").hidden)
      $("#view-heading").focus({ preventScroll: true });
  });
  function action(label, handler, { write = true, local = false } = {}) {
    const button = node("button", label);
    button.type = "button";
    button.dataset.feature = local ? "local" : write ? "write" : "read";
    button.addEventListener("click", () => host.guard(handler));
    return button;
  }
  function panel(title) {
    const card = node("section", undefined, "panel");
    if (title) card.append(node("h2", title));
    return card;
  }
  function showForm(title, fields, onSubmit, { local = false } = {}) {
    formOpener = document.activeElement;
    const form = $("#feature-form");
    form.lang = host.record().language || "en";
    const heading = node("div", undefined, "form-heading");
    const titleNode = node("h2", title);
    titleNode.id = "form-title";
    const help = node(
      "p",
      tr(
        "Fields marked * are required. Changes are saved only when you choose Save.",
        "Поля со * обязательны. Изменения сохраняются только после нажатия «Сохранить».",
      ),
      "help",
    );
    help.id = "form-instructions";
    heading.append(titleNode, help);
    const error = node("p", "", "form-error");
    error.id = "form-error";
    error.tabIndex = -1;
    error.setAttribute("role", "alert");
    dialog.setAttribute("aria-labelledby", titleNode.id);
    dialog.setAttribute("aria-describedby", help.id);
    form.replaceChildren(heading, error);
    const getters = {};
    for (const field of fields) {
      const label = node("label");
      const caption = node("span", field.label);
      caption.id = `form-label-${++labelId}`;
      label.append(caption);
      if (field.required) {
        const marker = node("span", "*", "required-marker");
        marker.setAttribute("aria-hidden", "true");
        label.append(marker);
      }
      const input = document.createElement(
        field.options
          ? "select"
          : field.type === "textarea"
            ? "textarea"
            : "input",
      );
      if (field.options) {
        for (const [value, caption] of field.options) {
          const option = node("option", caption);
          option.value = value;
          input.append(option);
        }
      } else if (field.type !== "textarea") input.type = field.type || "text";
      input.name = field.name;
      input.setAttribute("aria-labelledby", caption.id);
      input.required = Boolean(field.required);
      if (field.type === "checkbox") {
        input.checked = Boolean(field.value);
        label.className = "check";
      } else input.value = field.value ?? "";
      if (field.max) input.maxLength = field.max;
      if (field.decimal) input.inputMode = "decimal";
      if (field.readOnly) input.readOnly = true;
      label.append(input);
      form.append(label);
      getters[field.name] = () =>
        field.type === "checkbox" ? input.checked : input.value;
    }
    const save = node("button", tr("Save", "Сохранить"));
    save.className = "primary";
    save.type = "submit";
    save.dataset.feature = local ? "local" : "write";
    const cancel = node("button", tr("Cancel", "Отмена"));
    cancel.type = "button";
    cancel.addEventListener("click", () => dialog.close());
    const footer = node("div", undefined, "form-actions");
    footer.append(cancel, save);
    form.append(footer);
    form.onsubmit = (event) => {
      event.preventDefault();
      host.guard(async () => {
        const values = Object.fromEntries(
          Object.entries(getters).map(([key, read]) => [key, read()]),
        );
        await onSubmit(values);
        dialog.close();
      });
    };
    dialog.showModal();
    controls();
    // Opening runs inside host.guard, which briefly disables controls. Focus
    // after that guard finishes rather than leaving focus on a disabled input.
    setTimeout(() => {
      if (dialog.open)
        form
          .querySelector(
            "input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
          )
          ?.focus();
    }, 0);
  }
  const zones = () => host.record().snapshot?.zones || [];
  const zoneFields = (selected) =>
    zones().map((z) => ({
      name: `zone:${z.id}`,
      label: `${z.ru} / ${z.en}`,
      type: "checkbox",
      value: selected?.includes(z.id),
    }));
  const selectedZones = (values) =>
    zones()
      .filter((z) => values[`zone:${z.id}`])
      .map((z) => z.id);
  function movement(product, kind) {
    showForm(
      `${kind === "RECEIVE" ? tr("Delivery", "Приход") : tr("Waste", "Списание")} · ${product.ru}`,
      [
        {
          name: "quantity",
          label: tr("Quantity", "Количество"),
          required: true,
          decimal: true,
          max: 30,
        },
        {
          name: "unit",
          label: tr("Input unit", "Единица ввода"),
          value: "BASE",
          options: [
            ["BASE", product.unit],
            ...(product.sleeve ? [["SLEEVE_25", "×25 pcs"]] : []),
          ],
        },
        {
          name: "note",
          label: tr("Reason / note", "Причина / примечание"),
          required: kind === "WASTE",
          max: 500,
        },
        {
          name: "approx",
          label: tr("Estimated", "Приблизительно"),
          type: "checkbox",
        },
        {
          name: "low",
          label: tr("Manually mark low", "Мало"),
          type: "checkbox",
        },
      ],
      async (values) => {
        const parsed = quantity(
          values.quantity,
          product.unit,
          values.unit === "SLEEVE_25",
        );
        if (parsed.scaled === 0n)
          throw Error(
            tr(
              "Delivery/waste must be positive.",
              "Количество должно быть больше нуля.",
            ),
          );
        await host.mutate("movement", {
          action: kind,
          note: values.note,
          items: [
            {
              id: product.id,
              revision: product.legacyRevision,
              value: parsed.value,
              unit: values.unit,
              approx: values.approx,
              low: values.low,
            },
          ],
        });
      },
    );
  }
  function productForm(product) {
    const categories = [
      ...new Set((host.record().snapshot.catalog || []).map((p) => p.category)),
    ];
    showForm(
      product
        ? `${tr("Edit", "Изменить")} · ${product.ru}`
        : tr("New product", "Новый товар"),
      [
        {
          name: "ru",
          label: "Название RU",
          required: true,
          value: product?.ru,
          max: 160,
        },
        { name: "en", label: "Name EN", value: product?.en, max: 160 },
        {
          name: "category",
          label: tr("Category", "Категория"),
          value: product?.category || categories[0],
          options: categories.map((c) => [c, c]),
        },
        {
          name: "unit",
          label: tr("Unit", "Единица"),
          value: product?.unit || "pcs",
          options: ["l", "kg", "pcs", "pack", "roll"].map((v) => [v, v]),
        },
        {
          name: "kind",
          label: tr("Packaging", "Упаковка"),
          value: product?.sleeve ? "cup" : "other",
          options: [
            ["other", tr("Other / base units", "Другое / базовые единицы")],
            ["cup", tr("Cup · sleeve 25", "Стакан · туба 25")],
            ["lid", tr("Lid · sleeve 25", "Крышка · туба 25")],
          ],
        },
        {
          name: "noMinimum",
          label: tr("No minimum threshold", "Без минимального остатка"),
          type: "checkbox",
          value: product?.minimum == null,
        },
        {
          name: "minimum",
          label: tr("Minimum", "Минимум"),
          value: product?.minimum ?? "",
          decimal: true,
        },
        {
          name: "hours",
          label: tr("Check interval (hours)", "Период проверки (часов)"),
          value: product?.hours || 24,
          required: true,
        },
        {
          name: "notes",
          label: tr("Packaging size / notes", "Размер упаковки / примечания"),
          value: product?.notes,
          max: 500,
        },
        {
          name: "active",
          label: tr("Active", "Активен"),
          type: "checkbox",
          value: product ? product.active : true,
        },
        ...zoneFields(product?.zones),
      ],
      async (values) => {
        if (!values.noMinimum) quantity(values.minimum, values.unit);
        if (
          !/^\d+$/.test(values.hours) ||
          Number(values.hours) < 1 ||
          Number(values.hours) > 8760
        )
          throw Error(
            tr(
              "Check interval must be 1–8760 whole hours.",
              "Период проверки: от 1 до 8760 целых часов.",
            ),
          );
        if (
          (values.unit === "pack" || values.kind !== "other") &&
          !values.notes.trim()
        )
          throw Error(
            tr("Enter the packaging size.", "Укажите размер упаковки."),
          );
        if (values.kind !== "other" && values.unit !== "pcs")
          throw Error(
            tr(
              "Cups/lids must use pieces.",
              "Стаканы и крышки учитываются в штуках.",
            ),
          );
        await host.mutate("catalog", {
          changes: [
            {
              key: crypto.randomUUID(),
              action: "save",
              ...(product
                ? { productId: product.id, version: product.version }
                : {}),
              zones: selectedZones(values),
              product: { ...values, hours: values.hours },
            },
          ],
        });
      },
    );
  }
  async function loadView(next) {
    view = next;
    const record = host.record();
    if (host.online() && host.supported()) {
      if (next === "information")
        record.information = await host.rpc("information");
      if (next === "history")
        record.history = await host.rpc("history", { offset: 0 });
      if (next === "profile") record.settings = await host.rpc("settings");
      host.persist();
    }
    render();
  }
  function historyEntries(card) {
    const history = host.record().history;
    if (!history) {
      card.append(
        node(
          "p",
          tr(
            "Open this screen online once to save history for offline viewing.",
            "Откройте историю онлайн, чтобы сохранить её на устройстве.",
          ),
        ),
      );
      return;
    }
    if (!(history.entries || []).length) {
      const empty = panel(tr("No stock movements yet", "Движений пока нет"));
      empty.append(
        node(
          "p",
          tr(
            "Recorded counts, deliveries and waste will appear here after synchronization.",
            "После синхронизации здесь появятся пересчёты, приход и списания.",
          ),
        ),
      );
      card.append(empty);
    }
    for (const entry of history.entries || []) {
      const row = panel(`${entry.ru} · ${entry.action}`);
      row.append(
        node(
          "p",
          `${entry.previous ?? "?"} → ${entry.quantity ?? "?"} ${entry.unit}`,
        ),
        node(
          "p",
          `${entry.authorName || entry.by} · ${new Date(entry.countedAt || entry.at).toLocaleString()}`,
        ),
      );
      if (entry.reason) row.append(node("p", entry.reason));
      const revisions = (history.revisions || []).filter(
        (r) => r.sessionId === entry.sessionId,
      );
      const corrected = revisions
        .flatMap((r) => r.corrections || [])
        .filter((c) => c.id === entry.id)
        .at(-1);
      if (corrected)
        row.append(
          node(
            "p",
            `${tr("Corrected value", "Исправленное значение")}: ${corrected.quantity} ${entry.unit}`,
          ),
        );
      if (entry.editable)
        row.append(
          action(tr("Correct my entry", "Исправить мою запись"), () => {
            showForm(
              tr(
                "Append correction (original history is retained)",
                "Добавить исправление (история сохраняется)",
              ),
              [
                {
                  name: "value",
                  label: tr("Correct quantity", "Правильное количество"),
                  value: corrected?.quantity ?? entry.quantity,
                  required: true,
                  decimal: true,
                },
                {
                  name: "reason",
                  label: tr("Reason", "Причина"),
                  required: true,
                  max: 500,
                },
                {
                  name: "mode",
                  label: tr("Correction mode", "Режим исправления"),
                  options: [
                    ["HISTORY_ONLY", tr("History only", "Только история")],
                    [
                      "CURRENT",
                      tr(
                        "History and current stock (if no newer movement)",
                        "История и остаток (если нет новых движений)",
                      ),
                    ],
                  ],
                },
              ],
              async (values) => {
                const parsed = quantity(values.value, entry.unit);
                await host.mutate("correction", {
                  sessionId: entry.sessionId,
                  revisionVersion: revisions.at(-1)?.operationId || "",
                  mode: values.mode,
                  reason: values.reason,
                  changes: [
                    {
                      id: entry.id,
                      version: entry.version,
                      value: parsed.value,
                    },
                  ],
                });
              },
            );
          }),
        );
      card.append(row);
    }
    for (const revision of history.revisions || [])
      card.append(
        node(
          "p",
          `${revision.authorName || revision.by} · ${revision.mode} · ${revision.reason}`,
        ),
      );
    if (history.more)
      card.append(
        action(
          tr("Load more history", "Загрузить ещё"),
          async () => {
            const more = await host.rpc("history", {
              offset: history.entries.length,
            });
            history.entries.push(...more.entries);
            history.more = more.more;
            history.revisions = more.revisions;
            host.persist();
            render();
          },
          { write: false },
        ),
      );
  }
  function noteForm(note) {
    showForm(
      tr("Reminder", "Напоминание"),
      [
        {
          name: "text",
          label: tr("Text", "Текст"),
          type: "textarea",
          required: true,
          max: 1000,
          value: note?.text,
        },
        {
          name: "done",
          label: tr("Completed", "Выполнено"),
          type: "checkbox",
          value: note?.done,
        },
      ],
      (values) =>
        host.mutate("reminder", {
          ...values,
          id: note?.id || crypto.randomUUID(),
          ...(note ? { version: note.version } : {}),
        }),
    );
  }
  function cardForm() {
    showForm(
      tr("Add yellow card", "Добавить жёлтую карточку"),
      [
        {
          name: "code",
          label: tr("Card number", "Номер карточки"),
          required: true,
        },
        {
          name: "name",
          label: tr("Name", "Название"),
          required: true,
          max: 160,
        },
        { name: "size", label: tr("Size", "Размер"), max: 100 },
        {
          name: "category",
          label: tr("Category", "Категория"),
          required: true,
          max: 100,
        },
        { name: "note", label: tr("Note", "Примечание"), max: 500 },
      ],
      (values) => host.mutate("card", { ...values, action: "add" }),
    );
  }
  function render() {
    const record = host.record(),
      snapshot = record.snapshot;
    $("#feature-navigation").hidden = !snapshot;
    root.replaceChildren();
    const stock = view === "stock";
    root.lang = record.language || "en";
    document.body.dataset.counting = String(
      stock && record.session?.status === "OPEN",
    );
    $("#stock-overview").hidden = !stock;
    $("#feature-reload").hidden = stock;
    for (const id of [
      "products",
      "submit-panel",
      "search-panel",
      "conflicts-panel",
    ]) {
      const element = $(`#${id}`);
      if (!stock) element.hidden = true;
      else if (id === "products" || id === "search-panel")
        element.hidden = false;
    }
    $("#start").hidden = !stock;
    if (!snapshot) return;
    const titles = {
      stock: tr("Stock & count", "Остатки и пересчёт"),
      catalog: tr("Catalog", "Каталог"),
      sessions: tr("Sessions", "Сессии"),
      history: tr("History", "История"),
      information: tr("Information", "Информация"),
      profile: tr("Profile", "Профиль"),
    };
    const labels = {
      ...titles,
      stock: tr("Stock", "Остатки"),
      sessions: tr("Counts", "Сессии"),
      information: tr("Team", "Команда"),
    };
    $("#view-heading").textContent = titles[view];
    $("#view-heading").lang = record.language || "en";
    document.title = `${titles[view]} · VARKA`;
    for (const button of $("#feature-navigation").querySelectorAll("button")) {
      navigationLabel(
        button,
        labels[button.dataset.view],
        button.dataset.view === view,
        record.language || "en",
      );
    }
    if (!host.supported())
      root.append(
        node(
          "p",
          tr(
            "Update PwaBridge.gs and run installPwaFeatures to enable the full workflows.",
            "Обновите PwaBridge.gs и запустите installPwaFeatures для новых функций.",
          ),
        ),
      );
    if (stock) {
      const tools = panel(tr("Deliveries and waste", "Приход и списание"));
      const selector = document.createElement("select");
      selector.id = "movement-product";
      selector.setAttribute(
        "aria-label",
        tr("Product for delivery or waste", "Товар для прихода или списания"),
      );
      for (const product of snapshot.stock.products) {
        const option = node("option", `${product.ru} / ${product.en || ""}`);
        option.value = product.id;
        selector.append(option);
      }
      tools.append(selector);
      for (const [kind, label] of [
        ["RECEIVE", tr("Record delivery", "Записать приход")],
        ["WASTE", tr("Record waste", "Записать списание")],
      ])
        tools.append(
          action(label, () => {
            const product = snapshot.stock.products.find(
              (p) => p.id === selector.value,
            );
            if (!product || product.last === null)
              throw Error(
                tr("Count the product first.", "Сначала пересчитайте товар."),
              );
            movement(product, kind);
          }),
        );
      root.append(tools);
    }
    if (view === "catalog") {
      if (record.productChanges?.length) {
        const staged = panel(
          tr("Staged for this count", "Изменения для текущего пересчёта"),
        );
        staged.append(
          node(
            "p",
            record.productChanges
              .map(
                (change) =>
                  `${change.id}: ${change.active ? "ON" : "OFF"} · ${change.zones.join(", ")}`,
              )
              .join(" / "),
          ),
          action(
            tr("Discard staged checklist changes", "Отменить изменения списка"),
            () => {
              if (
                !confirm(
                  tr(
                    "Discard these checklist changes and their affected count drafts?",
                    "Отменить изменения списка и связанные черновики пересчёта?",
                  ),
                )
              )
                return;
              for (const change of record.productChanges)
                delete record.drafts[change.id];
              record.productChanges = [];
              host.persist();
              host.render();
            },
            { local: true },
          ),
        );
        root.append(staged);
      }
      root.append(
        action(tr("Add product", "Добавить товар"), () => productForm()),
      );
      for (const product of snapshot.catalog || []) {
        const card = panel(product.ru);
        card.append(
          node(
            "p",
            `${product.en || ""} · ${product.category} · ${product.unit} · ${product.active ? tr("Active", "Активен") : tr("Inactive", "Неактивен")}`,
          ),
          node(
            "p",
            `${tr("Minimum", "Минимум")}: ${product.minimum ?? "—"} · ${product.hours || 24} h · ${(product.zones || []).join(", ")}`,
          ),
          action(tr("Edit product", "Изменить товар"), () =>
            productForm(product),
          ),
          action(
            product.active
              ? tr("Deactivate", "Выключить")
              : tr("Activate", "Включить"),
            () =>
              host.mutate("catalog", {
                changes: [
                  {
                    key: crypto.randomUUID(),
                    action: "active",
                    productId: product.id,
                    version: product.version,
                    active: !product.active,
                  },
                ],
              }),
          ),
        );
        if (!product.active)
          card.append(
            action(tr("Archive", "Архивировать"), async () => {
              if (
                confirm(
                  tr(
                    "Archive this inactive product? History will remain.",
                    "Архивировать выключенный товар? История сохранится.",
                  ),
                )
              )
                await host.mutate("catalog", {
                  changes: [
                    {
                      key: crypto.randomUUID(),
                      action: "archive",
                      productId: product.id,
                      version: product.version,
                    },
                  ],
                });
            }),
          );
        if (record.session?.status === "OPEN")
          card.append(
            action(
              tr(
                "Stage status/zones with this count",
                "Статус/места вместе с пересчётом",
              ),
              () => {
                showForm(
                  product.ru,
                  [
                    {
                      name: "active",
                      label: tr(
                        "Active after submission",
                        "Активен после отправки",
                      ),
                      type: "checkbox",
                      value: product.active,
                    },
                    ...zoneFields(product.zones),
                  ],
                  (values) => {
                    if (
                      record.drafts[product.id] &&
                      !confirm(
                        tr(
                          "This changes the checklist. Discard the existing draft for this product?",
                          "Список изменится. Удалить текущий черновик этого товара?",
                        ),
                      )
                    )
                      return;
                    record.productChanges ||= [];
                    record.productChanges = record.productChanges.filter(
                      (c) => c.id !== product.id,
                    );
                    record.productChanges.push({
                      id: product.id,
                      version: product.version,
                      active: values.active,
                      zones: selectedZones(values),
                    });
                    delete record.drafts[product.id];
                    host.persist();
                    host.render();
                    host.message(
                      tr(
                        "Staged locally. Submit counts to commit all changes together.",
                        "Сохранено локально. Отправьте пересчёт для атомарного сохранения.",
                      ),
                    );
                  },
                  { local: true },
                );
              },
              { local: true },
            ),
          );
        root.append(card);
      }
    }
    if (view === "sessions") {
      if (!(snapshot.recent || []).length)
        root.append(
          node(
            "p",
            tr(
              "No recent sessions. Start a count from Stock when you are online.",
              "Нет недавних сессий. Начните пересчёт в разделе «Остатки», когда будете онлайн.",
            ),
            "panel empty-state",
          ),
        );
      for (const session of snapshot.recent || []) {
        const card = panel(
          `${session.status} · ${session.authorName || session.by}`,
        );
        card.append(
          node(
            "p",
            `${session.id} · ${new Date(session.created).toLocaleString()}`,
          ),
        );
        if (session.by === host.config().email && session.status === "OPEN")
          card.append(
            action(
              tr("Resume session", "Продолжить сессию"),
              () => host.resumeSession(session.id),
              { write: false },
            ),
          );
        root.append(card);
      }
      if (record.session?.status === "OPEN")
        root.append(
          action(
            tr(
              "Add newly activated products to checklist",
              "Добавить новые активные товары в список",
            ),
            () => host.mutate("expand", { sessionId: record.session.id }),
          ),
        );
    }
    if (view === "history") historyEntries(root);
    if (view === "information") {
      const info = record.information;
      root.append(
        action(tr("Add reminder", "Добавить напоминание"), () => noteForm()),
        action(tr("Add yellow card", "Добавить жёлтую карточку"), cardForm),
      );
      if (!info)
        root.append(
          node(
            "p",
            tr(
              "Open online to save team information on this device.",
              "Откройте онлайн для сохранения информации на устройстве.",
            ),
          ),
        );
      if (info && !info.notes?.length && !info.cards?.length)
        root.append(
          node(
            "p",
            tr(
              "No reminders or yellow cards yet. Add the first one for your team.",
              "Напоминаний и карточек пока нет. Добавьте первую запись для команды.",
            ),
            "panel empty-state",
          ),
        );
      for (const note of info?.notes || []) {
        const card = panel(`${note.done ? "✓ " : ""}${note.text}`);
        card.append(
          node("p", note.authorName || note.by || ""),
          action(tr("Edit reminder", "Изменить напоминание"), () =>
            noteForm(note),
          ),
          action(
            note.done
              ? tr("Reopen", "Открыть снова")
              : tr("Mark done", "Выполнено"),
            () =>
              host.mutate("reminder", {
                id: note.id,
                version: note.version,
                text: note.text,
                done: !note.done,
              }),
          ),
        );
        root.append(card);
      }
      for (const item of info?.cards || []) {
        const card = panel(`${item.id} · ${item.name}`);
        card.append(
          node("p", `${item.size} · ${item.category} · ${item.note}`),
          node("p", item.authorName || item.by || ""),
          action(tr("Remove card", "Убрать карточку"), async () => {
            if (
              confirm(
                tr(
                  "Remove this card? Its source record is retained.",
                  "Убрать карточку? Исходная запись сохранится.",
                ),
              )
            )
              await host.mutate("card", {
                action: "remove",
                code: item.id,
                version: item.version,
              });
          }),
        );
        root.append(card);
      }
    }
    if (view === "profile") {
      const card = panel(tr("My profile", "Мой профиль"));
      if (record.recoveryArchives?.length)
        card.append(
          action(
            tr(
              "Download original count backups",
              "Скачать резервные копии пересчётов",
            ),
            host.downloadRecovery,
            { local: true },
          ),
        );
      card.append(
        node("p", `${host.config().email} · ${snapshot.profile?.name || ""}`),
        action(tr("Change display name", "Изменить имя"), () => {
          showForm(
            tr("Display name", "Отображаемое имя"),
            [
              {
                name: "name",
                label: tr("Name", "Имя"),
                value: snapshot.profile?.name || "",
                max: 80,
              },
            ],
            (values) => host.mutate("profile", values),
          );
        }),
      );
      const language = action(
        tr("Switch to Russian", "Переключить на английский"),
        () => {
          record.language = record.language === "ru" ? "en" : "ru";
          host.persist();
          render();
        },
        { local: true },
      );
      card.append(language);
      if (record.settings?.canManage)
        card.append(
          action(
            tr("Telegram report settings", "Настройки отчётов Telegram"),
            () => {
              showForm(
                tr(
                  "Reports (enabling can send future real messages)",
                  "Отчёты (включение разрешает реальные сообщения)",
                ),
                [
                  {
                    name: "enabled",
                    label: tr("Reports enabled", "Отчёты включены"),
                    type: "checkbox",
                    value: record.settings.enabled,
                  },
                  {
                    name: "mode",
                    label: tr("Report content", "Содержимое отчёта"),
                    value: record.settings.mode,
                    options: [
                      ["LOW", tr("Low/out products", "Заканчивающиеся товары")],
                      ["ALL", tr("All active products", "Все активные товары")],
                    ],
                  },
                ],
                (values) =>
                  host.mutate("settings", {
                    ...values,
                    version: record.settings.version,
                  }),
              );
            },
          ),
        );
      else
        card.append(
          node(
            "p",
            tr(
              "Report settings are owner-only. Access codes remain managed in private Apps Script Properties.",
              "Настройки отчётов доступны владельцу. Коды доступа управляются в приватных свойствах Apps Script.",
            ),
          ),
        );
      root.append(card);
    }
    controls();
  }
  function controls() {
    const pending = host.pending(),
      blocked = host.busy() || pending;
    $("#feature-navigation")
      .querySelectorAll("button")
      .forEach((button) => (button.disabled = host.busy()));
    document.querySelectorAll("[data-feature]").forEach((button) => {
      const type = button.dataset.feature;
      button.disabled =
        blocked ||
        (type !== "local" && (!host.online() || !host.supported())) ||
        (type === "write" && !host.writable());
    });
    dialog
      .querySelectorAll("input,select,textarea")
      .forEach((input) => (input.disabled = blocked));
  }
  for (const button of $("#feature-navigation").querySelectorAll("button"))
    button.addEventListener("click", () =>
      host.guard(async () => {
        // Re-render stock first to restore the count form's conditional visibility.
        view = button.dataset.view;
        host.render();
        await loadView(view);
        host.focusView();
      }),
    );
  $("#feature-reload").addEventListener("click", () =>
    host.guard(() => loadView(view)),
  );
  return {
    render,
    controls,
    refreshView: () => loadView(view),
    stock: () => {
      view = "stock";
    },
    clear: () => {
      dialog.close();
      $("#feature-form").onsubmit = null;
      $("#feature-form").replaceChildren();
      view = "stock";
    },
  };
}
