import { parseArgs } from "node:util";
import { openDatabase } from "../server/database.js";
import { provisionUser } from "../server/varka/auth.js";

const { values, positionals } = parseArgs({
  options: {
    role: { type: "string", default: "staff" },
    name: { type: "string" },
    database: { type: "string" },
  },
  allowPositionals: true,
});
try {
  if (positionals.length !== 1)
    throw new Error(
      "Usage: VARKA_ACCESS_CODE=... npm run user:add -- email@example.com --role owner [--database path]",
    );
  if (!process.env.VARKA_ACCESS_CODE)
    throw new Error(
      "Set VARKA_ACCESS_CODE securely in your shell/environment; it is never printed.",
    );
  const db = openDatabase(values.database || process.env.DATABASE_PATH);
  try {
    console.log(
      JSON.stringify(
        provisionUser(db, {
          email: positionals[0],
          name: values.name,
          role: values.role,
          code: process.env.VARKA_ACCESS_CODE,
        }),
      ),
    );
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
