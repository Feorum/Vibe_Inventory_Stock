import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { initializeVarka } from "./varka/schema.js";

export function openDatabase(filename = "./data/varka.sqlite") {
  if (filename !== ":memory:")
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
  `);
  const version =
    db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()
      .version ?? 0;
  if (version < 1) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        category TEXT NOT NULL,
        unit TEXT NOT NULL,
        quantity_milli INTEGER NOT NULL DEFAULT 0 CHECK(quantity_milli >= 0),
        minimum_milli INTEGER NOT NULL DEFAULT 0 CHECK(minimum_milli >= 0),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE movements (
        id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id),
        type TEXT NOT NULL CHECK(type IN ('in','out','count','opening')),
        delta_milli INTEGER NOT NULL,
        balance_milli INTEGER NOT NULL CHECK(balance_milli >= 0),
        note TEXT NOT NULL DEFAULT '',
        request_key TEXT UNIQUE,
        request_payload TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX movements_recent ON movements(id DESC);
      INSERT INTO schema_migrations(version) VALUES (1);
      COMMIT;
    `);
  }
  if (version > 1) {
    db.close();
    throw new Error("Database schema is newer than this application.");
  }
  try {
    initializeVarka(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
