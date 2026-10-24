export function initializeVarka(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS varka_schema_migrations(version INTEGER PRIMARY KEY)",
  );
  const version =
    db
      .prepare("SELECT MAX(version) AS version FROM varka_schema_migrations")
      .get().version || 0;
  if (version > 1)
    throw new Error("VARKA database schema is newer than this application.");
  if (version === 1) return;
  try {
    db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS varka_users (
      email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('owner','staff')),
      code_hash TEXT, enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS varka_auth_sessions (
      token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES varka_users(email), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varka_login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS varka_products (
      id TEXT PRIMARY KEY, ru TEXT NOT NULL, en TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
      unit TEXT NOT NULL, sleeve INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0, minimum TEXT, hours INTEGER NOT NULL DEFAULT 24,
      notes TEXT NOT NULL DEFAULT '', zones TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS varka_stock (
      product_id TEXT PRIMARY KEY REFERENCES varka_products(id), quantity TEXT,
      checked_at TEXT, checked_by TEXT NOT NULL DEFAULT '', accuracy TEXT NOT NULL DEFAULT '',
      manual_low INTEGER NOT NULL DEFAULT 0, last_at TEXT, last_event TEXT, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS varka_inventory_sessions (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
      snapshot TEXT NOT NULL, missing TEXT NOT NULL DEFAULT '[]', closed_at TEXT, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS varka_session_journal (
      seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varka_events (
      seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, product_id TEXT NOT NULL REFERENCES varka_products(id),
      action TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'CAFE', quantity TEXT NOT NULL,
      before_quantity TEXT, after_quantity TEXT, unit TEXT NOT NULL, ru TEXT NOT NULL, en TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL, author_name TEXT NOT NULL DEFAULT '', recorded_at TEXT NOT NULL, counted_at TEXT,
      accuracy TEXT NOT NULL DEFAULT 'EXACT', manual_low INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
      session_id TEXT, corrects_event TEXT, reason TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
      batch_id TEXT, locations TEXT NOT NULL DEFAULT '[]', legacy_row TEXT
    );
    CREATE INDEX IF NOT EXISTS varka_events_product ON varka_events(product_id,seq DESC);
    CREATE INDEX IF NOT EXISTS varka_events_session ON varka_events(session_id,seq);
    CREATE TABLE IF NOT EXISTS varka_operations (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, request_hash TEXT NOT NULL,
      response TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varka_batches (
      id TEXT PRIMARY KEY, session_id TEXT, actor TEXT NOT NULL, status TEXT, kind TEXT NOT NULL,
      payload TEXT NOT NULL, legacy_hash TEXT, hash_encoding TEXT, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varka_revisions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, actor TEXT NOT NULL, mode TEXT NOT NULL,
      reason TEXT NOT NULL, parent_id TEXT, payload TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varka_cards (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, size TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, author TEXT NOT NULL,
      author_name TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varka_reminders (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL,
      author_name TEXT NOT NULL DEFAULT '', editor TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varka_notification_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'LOW' CHECK(mode IN ('LOW','ALL')), version INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO varka_notification_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS varka_outbox (
      id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      error TEXT, message_id TEXT
    );
    CREATE TABLE IF NOT EXISTS varka_migration_runs (
      fingerprint TEXT PRIMARY KEY, filename TEXT NOT NULL, report TEXT NOT NULL, imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS varka_legacy_rows (
      sheet TEXT NOT NULL, row_number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(sheet,row_number)
    );
    CREATE TABLE IF NOT EXISTS varka_audit (
      seq INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
      product_id TEXT, payload TEXT NOT NULL, at TEXT NOT NULL
    );
    INSERT INTO varka_schema_migrations(version) VALUES(1);
    COMMIT;
  `);
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
