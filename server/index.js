import { openDatabase } from "./database.js";
import { createApp } from "./app.js";
import { provisionUser } from "./varka/auth.js";
import { notificationWorker } from "./varka/notifications.js";

const db = openDatabase(process.env.DATABASE_PATH);
const production = process.env.NODE_ENV === "production";
if (
  process.env.OWNER_EMAIL &&
  process.env.APP_PASSWORD &&
  !db
    .prepare(
      "SELECT 1 FROM varka_users WHERE code_hash IS NOT NULL AND enabled=1 LIMIT 1",
    )
    .get()
)
  provisionUser(db, {
    email: process.env.OWNER_EMAIL,
    role: "owner",
    name: "Owner",
    code: process.env.APP_PASSWORD,
  });
if (
  process.env.APP_PASSWORD &&
  !db
    .prepare(
      "SELECT 1 FROM varka_users WHERE code_hash IS NOT NULL AND enabled=1 LIMIT 1",
    )
    .get()
)
  throw new Error(
    "Set OWNER_EMAIL with APP_PASSWORD to provision the first owner; development access cannot secure a configured deployment.",
  );
if (
  production &&
  !db
    .prepare(
      "SELECT 1 FROM varka_users WHERE role='owner' AND enabled=1 AND code_hash IS NOT NULL LIMIT 1",
    )
    .get()
)
  throw new Error(
    "Provision an owner with npm run user:add, or set OWNER_EMAIL and APP_PASSWORD for first startup.",
  );
const app = createApp({
  db,
  production,
  password: process.env.APP_PASSWORD,
  trustProxy: process.env.TRUST_PROXY === "1",
});
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const server = app.listen(port, host, () => {
  console.log(`Coffee inventory listening on ${host}:${port}`);
  if (
    !production &&
    !db
      .prepare(
        "SELECT 1 FROM varka_users WHERE code_hash IS NOT NULL AND enabled=1 LIMIT 1",
      )
      .get()
  )
    console.warn(
      "Development access is enabled. Set OWNER_EMAIL and APP_PASSWORD, or provision individual accounts, before sharing this server.",
    );
});
const deliver = notificationWorker(db, {
  token: process.env.TELEGRAM_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  enabled: process.env.TELEGRAM_DELIVERY_ENABLED === "true",
});
const notificationTimer = setInterval(
  () =>
    deliver().catch(() =>
      console.error("Notification worker failed. Inspect the delivery queue."),
    ),
  5000,
);
notificationTimer.unref();
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(notificationTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
