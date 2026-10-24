import { openDatabase } from "../server/database.js";
import { createApp } from "../server/app.js";
import { provisionUser } from "../server/varka/auth.js";
// In-memory database isolates browser tests from the shop's actual inventory.
const db = openDatabase(":memory:");
provisionUser(db, {
  email: "owner@example.test",
  name: "Test owner",
  role: "owner",
  code: "browser-test-password",
});
const app = createApp({ db, password: "browser-test-password" });
const server = app.listen(3100, "127.0.0.1");
process.on("SIGTERM", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
