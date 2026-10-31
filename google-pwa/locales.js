export const en = {
  app: "Café inventory",
  skip: "Skip to inventory",
  stock: "Stock",
  catalog: "Catalog",
  team: "Team",
  profile: "Profile",
  signIn: "Sign in",
  loginTitle: "Connect to the café",
  username: "Username",
  password: "Password",
  endpoint: "Apps Script deployment URL",
  language: "Language",
  loginHelp:
    "Use your account email and individual VARKA access code, not your Google password.",
  privacy:
    "Passwords and login tokens are never stored. Saved inventory and drafts are unencrypted; use a trusted device. Offline access works only after this device has loaded the database.",
  online: "Connected",
  offline: "Offline · saved data",
  disconnected: "Sign in to synchronize",
  readOnly: "Read only",
  loading: "Loading the complete database…",
  refreshing: "Refreshing database; entered information is preserved…",
  refresh: "Synchronize database",
  refreshed: "Database refreshed. Entered information is preserved.",
  retry: "Retry safely",
  retryLoad: "Retry loading",
  loginFailed:
    "Could not sign in or load the database. Check your account, deployment URL, and connection, then retry.",
  search: "Search products",
  location: "Location",
  category: "Category",
  allProducts: "All products",
  allLocations: "All locations",
  allCategories: "All categories",
  resetFilters: "Reset filters",
  noProducts: "No products match these filters.",
  emptyCatalog: "There are no products yet. Add one in Catalog.",
  quantity: "Quantity",
  total: "Product total",
  approximate: "Approximate",
  low: "Low",
  active: "Active",
  inactive: "Inactive",
  activate: "Activate",
  deactivate: "Deactivate",
  recorded: "Last synchronized quantity",
  countedAt: "Last successful recount",
  notCounted: "Not counted",
  previouslyRecorded: "Previously recorded",
  unassigned: "Unassigned location",
  unit: "Unit of measurement",
  pcs: "pieces",
  l: "litres",
  kg: "kilograms",
  g: "grams",
  ml: "millilitres",
  syncQuantity: "Synchronize quantity",
  clear: "Clear entered information",
  clearConfirm:
    "Clear all pending local quantities and flags across every filter? Saved database quantities and unresolved submissions are not changed.",
  clearDone: "Pending local entries cleared. Saved quantities are unchanged.",
  pending: "Submission awaiting confirmation",
  pendingHelp:
    "The original request is saved. Retry uses the same request ID. Newer edits remain separate. Do not recreate this submission on another device.",
  countHelp:
    "Enter a count for every assigned location. Blank means not counted; zero is a valid count. Approximate and Low are independent manual flags.",
  confirmTitle: "Confirm quantity synchronization",
  entered: "Entered",
  uncounted: "Uncounted",
  lowTotal: "Marked Low",
  inactiveTotal: "Inactive products",
  scope: "Telegram notification",
  entireList: "Entire list",
  enteredOnly: "Only entered items",
  lowOnly: "Only items marked Low",
  scopeHelp:
    "All valid entered quantities are saved, regardless of this choice. Filters do not change submission or notification scope. Older values are labeled as previously recorded.",
  send: "Send",
  cancel: "Cancel",
  close: "Close",
  save: "Save",
  saving: "Saving…",
  saved: "Inventory saved",
  partial:
    "Some entries need attention. Accepted entries are saved; other drafts are preserved.",
  noEntries:
    "No quantities entered. A notification may still include previously recorded products.",
  telegramReady: "Inventory saved. Telegram notification is ready.",
  telegramSent: "Telegram notification sent.",
  telegramFailed:
    "Inventory saved; Telegram failed. Retry the notification without submitting quantities again.",
  telegramUnknown:
    "Inventory saved. Telegram delivery is unconfirmed. Automatic resend is blocked to avoid duplicates; ask the owner to check Telegram.",
  telegramMissing: "Inventory saved. Telegram is not configured on the server.",
  telegramEmpty: "Inventory saved. The selected notification list is empty.",
  retryNotification: "Retry notification only",
  notification: "Telegram delivery",
  databaseSaved: "Database outcome",
  uncertain:
    "The connection was interrupted. The operation may have saved. Use Retry safely; your drafts are preserved.",
  conflictTitle: "Review changed products",
  conflictHelp:
    "Another user changed this product. Your entered information is preserved. Recheck the physical count before using the current database version.",
  review: "Review conflict",
  useReviewed: "I rechecked — use current version",
  deletedDraft:
    "This product was deleted. The draft remains saved but cannot be submitted. Download a backup before clearing it.",
  backup: "Download saved count backup",
  conflictResolved:
    "The draft now uses the current version. Recheck all location inputs before submitting.",
  addProduct: "Add product",
  editProduct: "Edit product",
  deleteProduct: "Delete product",
  name: "Name",
  englishName: "English name (optional)",
  minimum: "Minimum quantity",
  locations: "Locations",
  reminder: "Recount reminder",
  off: "Off",
  interval: "Interval",
  hours: "Hours",
  days: "Days",
  reminderHelp:
    "Fixed intervals start after a successful recount, even if the quantity is unchanged. Inactive products are excluded. Consumption forecasting is not implemented.",
  confirmDelete:
    "Delete “{name}”? Its history is preserved. Deletion is distinct from reversible deactivation.",
  productSaved: "Product saved.",
  productDeleted: "Product deleted. Any pending count is preserved for review.",
  statusPending: "Saving product status…",
  statusDone: "Product status saved.",
  undo: "Undo",
  required: "Fields marked * are required.",
  selectLocation: "Choose one or more locations.",
  notes: "Shared notes",
  yellowCards: "Yellow Cards",
  addNote: "Add note",
  addCard: "Add Yellow Card",
  noteContent: "Note content",
  cardCode: "Database code",
  cardName: "Card name",
  size: "Size",
  cardCategory: "Card category",
  cardNote: "Card note",
  noNotes: "No shared notes yet.",
  noCards: "No Yellow Cards in this section.",
  otherCards: "Other codes",
  author: "Author",
  noName: "Name not provided",
  noAuthor: "Author not recorded",
  noteSaved: "Shared note saved.",
  cardSaved: "Yellow Card saved.",
  email: "Email",
  logout: "Log out",
  logoutHelp:
    "Logging out removes this account from the screen. Its local drafts remain scoped to this account and database on this trusted device.",
  remindersConfigured: "Scheduled recount reminders are configured.",
  remindersMissing:
    "Scheduled recount reminders are not configured. The owner must install the Apps Script trigger.",
  writesBlocked:
    "Changes require an online sign-in and server write permission.",
  legacy: "Previous counting-session drafts are preserved separately.",
  legacyLink: "Open previous count recovery",
  draftNotice:
    "Counting entries are saved continuously on this device. They are not a cross-device backup until synchronized.",
  lastSync: "Database loaded",
  restoreOffline: "Use saved inventory offline",
  storageError:
    "Device storage is full or blocked. Keep this page open; no new request was sent. Free device storage or download a backup.",
  localSaved: "Entered information saved on this device.",
  version: "VARKA · Workspace v4",
  filtersResult: "{shown} of {total} products",
  itemCount: { one: "{count} product", other: "{count} products" },
  INVALID_QUANTITY:
    "Enter a nonnegative number with at most eight decimal places. A comma or decimal point is accepted.",
  QUANTITY_RANGE: "The quantity exceeds the supported limit.",
  WHOLE_PIECES_REQUIRED: "Enter a whole number of pieces.",
  INCOMPLETE_LOCATIONS:
    "Fill every assigned location for a product, or leave all locations blank.",
  PRODUCT_DELETED: "The product was deleted. Your draft is preserved.",
  STOCK_CONFLICT:
    "A newer quantity was saved by another user. Recheck this count.",
  COUNT_SPEC_CONFLICT:
    "The product status, unit, or locations changed. Recheck this count.",
  CATALOG_CONFLICT:
    "The product was edited by another user. Refresh and review your changes.",
  CONFLICT:
    "Another user changed this record. Refresh and review your changes.",
  INVALID_SCOPE: "Choose a notification scope.",
  NO_SNAPSHOT: "Load the database before counting.",
  INVALID_REQUEST: "Check the form values and try again.",
  INVALID_PRODUCT: "Check the product fields and locations.",
  INVALID_INTERVAL: "Choose Off or a positive reminder interval.",
  SIGN_IN_REQUIRED: "Sign in online again to continue.",
  PWA_READ_ONLY: "The server is read only. Ask the owner to enable writes.",
  WORKSPACE_NOT_INSTALLED:
    "The updated Apps Script workspace is not installed. Ask the owner to run installWorkspace and redeploy.",
  INVALID_CARD_NUMBER:
    "Use an existing database-style code, for example A1, A2, C1, or D1.",
  CARD_EXISTS: "A Yellow Card with this code already exists.",
  PRODUCT_NAME_EXISTS: "A product with this name already exists.",
  OWNER_ONLY: "Only the owner can change this setting.",
  REQUEST_ID_REUSED:
    "This request ID belongs to different data. Keep the saved request and ask the owner to review.",
  unknownError:
    "The operation could not be completed. Your entered information is preserved. Check the connection and retry safely.",
  invalidUrl:
    "Use the deployed Apps Script /exec URL without extra parameters.",
  confirmLogout:
    "Log out? Your unsent drafts will remain on this trusted device for this account and database.",
};

export const ru = {
  app: "Склад кофейни",
  skip: "Перейти к складу",
  stock: "Склад",
  catalog: "Каталог",
  team: "Команда",
  profile: "Профиль",
  signIn: "Войти",
  loginTitle: "Подключиться к кофейне",
  username: "Имя пользователя",
  password: "Пароль",
  endpoint: "URL развёртывания Apps Script",
  language: "Язык",
  loginHelp:
    "Используйте почту аккаунта и личный код доступа VARKA, а не пароль Google.",
  privacy:
    "Пароли и токены входа не сохраняются. Данные склада и черновики на устройстве не зашифрованы: используйте доверенное устройство. Работа без сети доступна только после загрузки базы на это устройство.",
  online: "Подключено",
  offline: "Без сети · сохранённые данные",
  disconnected: "Войдите для синхронизации",
  readOnly: "Только чтение",
  loading: "Загружаем полную базу…",
  refreshing: "Обновляем базу; введённые данные сохраняются…",
  refresh: "Синхронизировать базу",
  refreshed: "База обновлена. Введённые данные сохранены.",
  retry: "Безопасно повторить",
  retryLoad: "Повторить загрузку",
  loginFailed:
    "Не удалось войти или загрузить базу. Проверьте аккаунт, URL развёртывания и соединение, затем повторите.",
  search: "Поиск товаров",
  location: "Место хранения",
  category: "Категория",
  allProducts: "Все товары",
  allLocations: "Все места",
  allCategories: "Все категории",
  resetFilters: "Сбросить фильтры",
  noProducts: "По этим фильтрам товары не найдены.",
  emptyCatalog: "Товаров пока нет. Добавьте товар в каталоге.",
  quantity: "Количество",
  total: "Итого по товару",
  approximate: "Примерно",
  low: "Мало",
  active: "Активен",
  inactive: "Неактивен",
  activate: "Активировать",
  deactivate: "Деактивировать",
  recorded: "Последнее сохранённое количество",
  countedAt: "Последний успешный пересчёт",
  notCounted: "Не пересчитано",
  previouslyRecorded: "Сохранено ранее",
  unassigned: "Место не назначено",
  unit: "Единица измерения",
  pcs: "штуки",
  l: "литры",
  kg: "килограммы",
  g: "граммы",
  ml: "миллилитры",
  syncQuantity: "Синхронизировать количество",
  clear: "Очистить введённую информацию",
  clearConfirm:
    "Очистить все локальные несохранённые количества и отметки во всех фильтрах? Сохранённые количества в базе и неподтверждённые отправки не изменятся.",
  clearDone: "Локальные записи очищены. Сохранённые количества не изменены.",
  pending: "Отправка ожидает подтверждения",
  pendingHelp:
    "Исходный запрос сохранён. Повтор использует тот же идентификатор. Более новые правки остаются отдельно. Не создавайте эту отправку заново на другом устройстве.",
  countHelp:
    "Введите количество для каждого назначенного места. Пусто — не пересчитано; ноль — корректный пересчёт. «Примерно» и «Мало» — независимые ручные отметки.",
  confirmTitle: "Подтвердите синхронизацию количества",
  entered: "Введено",
  uncounted: "Не пересчитано",
  lowTotal: "Отмечено «Мало»",
  inactiveTotal: "Неактивных товаров",
  scope: "Уведомление в Telegram",
  entireList: "Весь список",
  enteredOnly: "Только введённые товары",
  lowOnly: "Только товары с отметкой «Мало»",
  scopeHelp:
    "Все корректно введённые количества сохраняются независимо от выбора. Фильтры не меняют состав отправки или уведомления. Старые значения отмечаются как сохранённые ранее.",
  send: "Отправить",
  cancel: "Отмена",
  close: "Закрыть",
  save: "Сохранить",
  saving: "Сохраняем…",
  saved: "Данные склада сохранены",
  partial:
    "Некоторые записи требуют внимания. Принятые записи сохранены, остальные черновики оставлены.",
  noEntries:
    "Количество не введено. Уведомление всё ещё может включать ранее сохранённые товары.",
  telegramReady: "Склад сохранён. Уведомление Telegram готово к отправке.",
  telegramSent: "Уведомление Telegram отправлено.",
  telegramFailed:
    "Склад сохранён, но Telegram не отправлен. Повторите только уведомление, без повторной отправки количества.",
  telegramUnknown:
    "Склад сохранён. Доставка Telegram не подтверждена. Автоповтор заблокирован во избежание дублей; попросите владельца проверить Telegram.",
  telegramMissing: "Склад сохранён. Telegram не настроен на сервере.",
  telegramEmpty: "Склад сохранён. Выбранный список уведомления пуст.",
  retryNotification: "Повторить только уведомление",
  notification: "Доставка Telegram",
  databaseSaved: "Результат сохранения в базе",
  uncertain:
    "Соединение прервано. Операция могла сохраниться. Используйте безопасный повтор; черновики сохранены.",
  conflictTitle: "Проверьте изменённые товары",
  conflictHelp:
    "Другой пользователь изменил товар. Ваши данные сохранены. Проверьте фактическое количество перед использованием текущей версии базы.",
  review: "Проверить конфликт",
  useReviewed: "Проверено — использовать текущую версию",
  deletedDraft:
    "Товар удалён. Черновик сохранён, но его нельзя отправить. Скачайте резервную копию перед очисткой.",
  backup: "Скачать резервную копию пересчёта",
  conflictResolved:
    "Черновик использует текущую версию. Проверьте значения во всех местах перед отправкой.",
  addProduct: "Добавить товар",
  editProduct: "Изменить товар",
  deleteProduct: "Удалить товар",
  name: "Название",
  englishName: "Английское название (необязательно)",
  minimum: "Минимальное количество",
  locations: "Места хранения",
  reminder: "Напоминание о пересчёте",
  off: "Выключено",
  interval: "Интервал",
  hours: "Часы",
  days: "Дни",
  reminderHelp:
    "Фиксированный интервал отсчитывается от успешного пересчёта, даже если количество не изменилось. Неактивные товары исключены. Прогноз расхода не реализован.",
  confirmDelete:
    "Удалить «{name}»? История сохранится. Удаление отличается от обратимой деактивации.",
  productSaved: "Товар сохранён.",
  productDeleted: "Товар удалён. Несохранённый пересчёт оставлен для проверки.",
  statusPending: "Сохраняем статус товара…",
  statusDone: "Статус товара сохранён.",
  undo: "Отменить",
  required: "Поля со * обязательны.",
  selectLocation: "Выберите одно или несколько мест хранения.",
  notes: "Общие заметки",
  yellowCards: "Жёлтые карточки",
  addNote: "Добавить заметку",
  addCard: "Добавить жёлтую карточку",
  noteContent: "Текст заметки",
  cardCode: "Код в базе",
  cardName: "Название карточки",
  size: "Размер",
  cardCategory: "Категория карточки",
  cardNote: "Примечание карточки",
  noNotes: "Общих заметок пока нет.",
  noCards: "В этом разделе нет жёлтых карточек.",
  otherCards: "Другие коды",
  author: "Автор",
  noName: "Имя не указано",
  noAuthor: "Автор не сохранён",
  noteSaved: "Общая заметка сохранена.",
  cardSaved: "Жёлтая карточка сохранена.",
  email: "Почта",
  logout: "Выйти",
  logoutHelp:
    "Выход убирает аккаунт с экрана. Локальные черновики остаются привязаны к этому аккаунту и базе на доверенном устройстве.",
  remindersConfigured: "Плановые напоминания о пересчёте настроены.",
  remindersMissing:
    "Плановые напоминания о пересчёте не настроены. Владельцу нужно установить триггер Apps Script.",
  writesBlocked:
    "Для изменений требуется вход с сетью и разрешение записи на сервере.",
  legacy: "Черновики предыдущих сеансов пересчёта сохранены отдельно.",
  legacyLink: "Открыть восстановление предыдущего пересчёта",
  draftNotice:
    "Пересчёт непрерывно сохраняется на этом устройстве. До синхронизации это не межустройственная резервная копия.",
  lastSync: "База загружена",
  restoreOffline: "Открыть сохранённый склад без сети",
  storageError:
    "Хранилище устройства заполнено или заблокировано. Не закрывайте страницу: новый запрос не отправлен. Освободите место или скачайте резервную копию.",
  localSaved: "Введённые данные сохранены на устройстве.",
  version: "VARKA · Рабочее пространство v4",
  filtersResult: "{shown} из {total} товаров",
  itemCount: {
    one: "{count} товар",
    few: "{count} товара",
    many: "{count} товаров",
    other: "{count} товара",
  },
  INVALID_QUANTITY:
    "Введите неотрицательное число: не более восьми знаков после запятой. Допустимы запятая и точка.",
  QUANTITY_RANGE: "Количество превышает допустимый предел.",
  WHOLE_PIECES_REQUIRED: "Введите целое число штук.",
  INCOMPLETE_LOCATIONS:
    "Заполните все места хранения товара или оставьте их все пустыми.",
  PRODUCT_DELETED: "Товар удалён. Ваш черновик сохранён.",
  STOCK_CONFLICT:
    "Другой пользователь сохранил новое количество. Проверьте пересчёт.",
  COUNT_SPEC_CONFLICT:
    "Статус, единица или места хранения изменились. Проверьте пересчёт.",
  CATALOG_CONFLICT:
    "Товар изменён другим пользователем. Обновите базу и проверьте правки.",
  CONFLICT:
    "Запись изменена другим пользователем. Обновите базу и проверьте правки.",
  INVALID_SCOPE: "Выберите состав уведомления.",
  NO_SNAPSHOT: "Загрузите базу перед пересчётом.",
  INVALID_REQUEST: "Проверьте поля формы и повторите.",
  INVALID_PRODUCT: "Проверьте поля товара и места хранения.",
  INVALID_INTERVAL: "Выберите «Выключено» или положительный интервал.",
  SIGN_IN_REQUIRED: "Для продолжения войдите заново с сетью.",
  PWA_READ_ONLY:
    "Сервер доступен только для чтения. Попросите владельца разрешить запись.",
  WORKSPACE_NOT_INSTALLED:
    "Обновлённое рабочее пространство Apps Script не установлено. Попросите владельца выполнить installWorkspace и обновить развёртывание.",
  INVALID_CARD_NUMBER:
    "Используйте код существующего формата базы, например A1, A2, C1 или D1.",
  CARD_EXISTS: "Жёлтая карточка с таким кодом уже существует.",
  PRODUCT_NAME_EXISTS: "Товар с таким названием уже существует.",
  OWNER_ONLY: "Только владелец может изменить эту настройку.",
  REQUEST_ID_REUSED:
    "Идентификатор запроса относится к другим данным. Сохраните запрос и попросите владельца проверить.",
  unknownError:
    "Не удалось завершить операцию. Введённые данные сохранены. Проверьте соединение и используйте безопасный повтор.",
  invalidUrl:
    "Используйте URL развёртывания Apps Script с окончанием /exec без дополнительных параметров.",
  confirmLogout:
    "Выйти? Неотправленные черновики останутся на этом доверенном устройстве для этого аккаунта и базы.",
};

export const dictionaries = { en, ru };
Object.assign(en, {
  productCountError: "{name}: {error}",
  savedRefreshFailed:
    "The change was saved, but refreshing the database failed. Use Synchronize database; do not repeat the save.",
  pack: "packs",
  roll: "rolls",
  timeUnit: "Interval time unit",
  signInAgain: "Sign in online",
  checkDelivery: "Check delivery status",
  accountCache: "Saved inventory for {account}",
  archiveDeleted: "Keep in backup only — exclude deleted product",
  INVALID_LOGIN:
    "The username or password is incorrect, or this account is not permitted.",
  LOGIN_RATE_LIMIT:
    "Too many sign-in attempts. Wait 15 minutes before trying again.",
  INVALID_UNIT: "Choose a supported unit of measurement.",
  INVALID_ZONES:
    "Choose valid locations and enter a quantity for every assigned location.",
  INVALID_REQUIRED: "Complete the required fields.",
  INVALID_TEXT: "The text is too long or contains unsupported characters.",
  INVALID_ID:
    "The request identifier is invalid. Keep the draft and ask the owner to review.",
  EXISTING_CATEGORY_REQUIRED: "Choose an existing category from the database.",
  UNIT_HAS_HISTORY:
    "A product with stock history cannot change units. Create a separate product instead.",
  PRODUCT_CHANGED:
    "The product status, unit, or locations changed. Recheck the count.",
  INVALID_CATALOG: "Check the product fields before saving.",
  INVALID_STATUS: "Choose a valid active status.",
  INVALID_COUNT: "The count request is invalid. Your draft is preserved.",
  INVALID_FLAGS: "The count flags are invalid. Your draft is preserved.",
  OPERATION_NOT_FOUND:
    "This operation was not found for your account. Keep your saved request and ask the owner to review.",
  CATALOG_RECOVERY_CONFLICT:
    "An interrupted catalog update conflicts with a newer update. Keep the saved request and ask the owner to reconcile it.",
  COMMIT_UNCONFIRMED:
    "The database outcome is not confirmed. Keep your request and use Retry safely.",
  NO_SNAPSHOT: "Load the database before counting.",
  partial:
    "Some entries conflicted or failed. Review the listed products. Accepted entries are saved; other drafts are preserved.",
});
Object.assign(ru, {
  productCountError: "{name}: {error}",
  savedRefreshFailed:
    "Изменение сохранено, но обновить базу не удалось. Нажмите «Синхронизировать базу»; не повторяйте сохранение.",
  pack: "упаковки",
  roll: "рулоны",
  timeUnit: "Единица интервала",
  signInAgain: "Войти с сетью",
  checkDelivery: "Проверить доставку",
  accountCache: "Сохранённый склад для {account}",
  archiveDeleted: "Оставить в резервной копии — исключить удалённый товар",
  INVALID_LOGIN:
    "Неверное имя пользователя или пароль либо доступ аккаунту не разрешён.",
  LOGIN_RATE_LIMIT:
    "Слишком много попыток входа. Подождите 15 минут и повторите.",
  INVALID_UNIT: "Выберите поддерживаемую единицу измерения.",
  INVALID_ZONES:
    "Выберите допустимые места и введите количество для каждого назначенного места.",
  INVALID_REQUIRED: "Заполните обязательные поля.",
  INVALID_TEXT: "Текст слишком длинный или содержит недопустимые символы.",
  INVALID_ID:
    "Недопустимый идентификатор запроса. Сохраните черновик и попросите владельца проверить.",
  EXISTING_CATEGORY_REQUIRED: "Выберите существующую категорию базы.",
  UNIT_HAS_HISTORY:
    "Нельзя менять единицу товара с историей остатков. Создайте отдельный товар.",
  PRODUCT_CHANGED:
    "Статус, единица или места товара изменились. Проверьте пересчёт.",
  INVALID_CATALOG: "Проверьте поля товара перед сохранением.",
  INVALID_STATUS: "Выберите корректный статус активности.",
  INVALID_COUNT: "Некорректный запрос пересчёта. Черновик сохранён.",
  INVALID_FLAGS: "Некорректные отметки пересчёта. Черновик сохранён.",
  OPERATION_NOT_FOUND:
    "Операция не найдена для вашего аккаунта. Сохраните запрос и попросите владельца проверить.",
  CATALOG_RECOVERY_CONFLICT:
    "Прерванное обновление каталога конфликтует с новой правкой. Сохраните запрос и попросите владельца согласовать изменения.",
  COMMIT_UNCONFIRMED:
    "Результат сохранения в базе не подтверждён. Сохраните запрос и используйте безопасный повтор.",
  NO_SNAPSHOT: "Загрузите базу перед пересчётом.",
  partial:
    "Некоторые записи конфликтуют или не сохранены. Проверьте указанные товары. Принятые записи сохранены, остальные черновики оставлены.",
});
Object.assign(en, {
  version: "VARKA · Workspace v4.1",
  tipsMode: "Tips",
  syncQuantityCompact: "Sync quantities",
  tipsModeHelp:
    "Show optional explanations and usage tips. Safety warnings and errors always remain visible.",
  searchCards: "Search cards",
  savedInventoryOpened:
    "Saved inventory opened. Sign in online to synchronize.",
  cardsSearchResult: "{shown} of {total} Yellow Cards",
  noMatchingCards: "No Yellow Cards match this search.",
  cardDetails: "Card details",
  clearCardSearch: "Clear card search",
  teamSections: "Team sections",
  recordedShort: "Recorded",
  countedAtShort: "Counted",
  telegramSettings: "Telegram notifications",
  telegramConfigured:
    "Bot token and destination chat are configured. Send a test to verify delivery.",
  telegramNotConfigured: "Telegram is not configured yet.",
  telegramTokenMissing: "The bot token is missing in Apps Script Properties.",
  telegramChatMissing:
    "The destination chat ID is missing in Apps Script Properties.",
  telegramSetupUnavailable:
    "Update and redeploy the Apps Script bridge to use Telegram setup checks.",
  telegramSetupInstructions: "Telegram setup instructions",
  telegramSetupBot:
    "Create or open your bot with @BotFather in Telegram. Store its token privately as TELEGRAM_TOKEN in Apps Script → Project Settings → Script Properties.",
  telegramSetupChat:
    "Start a conversation with the bot, or add it to your café group and send a message. Find the chat ID using the owner-only listWorkspaceTelegramChats function in Apps Script, then store it privately as TELEGRAM_CHAT_ID.",
  telegramSetupDeploy:
    "Redeploy the existing Apps Script web app as a New version, refresh the database here, then send a test. Never paste a bot token into this app or into chat.",
  telegramSetupOwnerOnly:
    "The owner configures the bot and verifies delivery. No bot credentials are shown in this app.",
  sendTelegramTest: "Send test notification",
  confirmTelegramTest:
    "Send a test message to the configured Telegram chat? No inventory quantities will change.",
  telegramTestSent: "Telegram test message delivered.",
  telegramTestReady: "Telegram test message is ready to send.",
  telegramTestFailed:
    "The test was rejected by Telegram. Check the server configuration, then retry only the test notification.",
  telegramTestUnknown:
    "Test delivery is unconfirmed. Check the Telegram chat. Resending is blocked to avoid a duplicate; you can check delivery status.",
  telegramTestMissing:
    "The test could not be sent because Telegram credentials are missing on the server.",
  retryTelegramTest: "Retry test notification only",
  telegramTestRunning: "Sending Telegram test…",
  TELEGRAM_SETUP_NOT_AVAILABLE:
    "Update the Apps Script Telegram setup code and redeploy the web app.",
  TELEGRAM_NOT_CONFIGURED:
    "Set the bot token and destination chat ID privately in Apps Script Properties.",
});
Object.assign(ru, {
  version: "VARKA · Рабочее пространство v4.1",
  tipsMode: "Подсказки",
  syncQuantityCompact: "Отправить остатки",
  tipsModeHelp:
    "Показывать необязательные пояснения и советы по работе. Предупреждения безопасности и ошибки видны всегда.",
  searchCards: "Поиск жёлтых карточек",
  savedInventoryOpened:
    "Сохранённый склад открыт. Для синхронизации войдите с сетью.",
  cardsSearchResult: "{shown} из {total} жёлтых карточек",
  noMatchingCards: "По этому запросу жёлтые карточки не найдены.",
  cardDetails: "Подробности карточки",
  clearCardSearch: "Очистить поиск карточек",
  teamSections: "Разделы команды",
  recordedShort: "Сохранено",
  countedAtShort: "Пересчёт",
  telegramSettings: "Уведомления Telegram",
  telegramConfigured:
    "Токен бота и чат назначения настроены. Отправьте тест для проверки доставки.",
  telegramNotConfigured: "Telegram пока не настроен.",
  telegramTokenMissing:
    "В свойствах скрипта Apps Script отсутствует токен бота.",
  telegramChatMissing:
    "В свойствах скрипта Apps Script отсутствует ID чата назначения.",
  telegramSetupUnavailable:
    "Обновите код Apps Script и его развёртывание, чтобы проверить настройку Telegram.",
  telegramSetupInstructions: "Инструкция по настройке Telegram",
  telegramSetupBot:
    "Создайте или откройте своего бота через @BotFather в Telegram. Сохраните токен только в Apps Script → Настройки проекта → Свойства скрипта под именем TELEGRAM_TOKEN.",
  telegramSetupChat:
    "Начните диалог с ботом или добавьте его в группу кофейни и отправьте сообщение. Получите ID чата через функцию listWorkspaceTelegramChats в Apps Script, доступную только владельцу, и сохраните его как TELEGRAM_CHAT_ID.",
  telegramSetupDeploy:
    "Обновите существующее веб-развёртывание Apps Script до новой версии, синхронизируйте базу здесь и отправьте тест. Не вставляйте токен бота в приложение или переписку.",
  telegramSetupOwnerOnly:
    "Владелец настраивает бота и проверяет доставку. Данные доступа к боту в приложении не показываются.",
  sendTelegramTest: "Отправить тестовое уведомление",
  confirmTelegramTest:
    "Отправить тестовое сообщение в настроенный чат Telegram? Количества товаров не изменятся.",
  telegramTestSent: "Тестовое сообщение Telegram доставлено.",
  telegramTestReady: "Тестовое сообщение Telegram готово к отправке.",
  telegramTestFailed:
    "Telegram отклонил тест. Проверьте настройки на сервере и повторите только тестовое уведомление.",
  telegramTestUnknown:
    "Доставка теста не подтверждена. Проверьте чат Telegram. Повторная отправка заблокирована во избежание дубля; можно проверить статус доставки.",
  telegramTestMissing:
    "Тест не отправлен: на сервере отсутствуют данные доступа к Telegram.",
  retryTelegramTest: "Повторить только тестовое уведомление",
  telegramTestRunning: "Отправляем тест Telegram…",
  TELEGRAM_SETUP_NOT_AVAILABLE:
    "Обновите код настройки Telegram в Apps Script и веб-развёртывание.",
  TELEGRAM_NOT_CONFIGURED:
    "Сохраните токен бота и ID чата только в свойствах скрипта Apps Script.",
});
export function translate(language, key, values = {}) {
  let value = dictionaries[language]?.[key] ?? en[key] ?? en.unknownError;
  if (typeof value === "object")
    value =
      value[new Intl.PluralRules(language).select(values.count)] || value.other;
  return value.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}
export function errorKey(error) {
  const message = String(error?.message || error || "");
  const code = message.split(":")[0];
  if (Object.hasOwn(en, code)) return code;
  if (/\/exec URL|Invalid URL/.test(message)) return "invalidUrl";
  if (/timed out|interrupted|Connection closed/.test(message))
    return "uncertain";
  if (/_NOT_INSTALLED/.test(message)) return "WORKSPACE_NOT_INSTALLED";
  if (/CONFLICT/.test(message)) return "CONFLICT";
  return "unknownError";
}
