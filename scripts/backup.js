import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = process.env.DATABASE_PATH || "./data/varka.sqlite";
const destination = process.argv[2];
if (!destination)
  throw new Error("Usage: npm run backup -- /path/to/new-backup.sqlite");
if (resolve(source) === resolve(destination) || existsSync(destination))
  throw new Error(
    "Choose a new backup filename; existing files are never overwritten.",
  );
mkdirSync(dirname(resolve(destination)), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  console.log(`SQLite backup saved to ${resolve(destination)}`);
} finally {
  db.close();
}
