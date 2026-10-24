import { parseArgs } from "node:util";
import { inspectWorkbook, importWorkbook } from "../server/varka/import.js";
import { openDatabase } from "../server/database.js";

try {
  const { values, positionals } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      database: { type: "string" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1 || (values.apply && !values.database))
    throw new Error(
      "Usage: npm run import:varka -- workbook.xlsx [--apply --database ./data/new-varka.sqlite]",
    );
  const plan = await inspectWorkbook(positionals[0]);
  if (!values.apply)
    console.log(
      JSON.stringify(
        { ...plan.report, mode: "DRY_RUN", databaseChanged: false },
        null,
        2,
      ),
    );
  else {
    const db = openDatabase(values.database);
    try {
      console.log(
        JSON.stringify(
          {
            ...importWorkbook(db, plan),
            mode: "IMPORTED",
            database: values.database,
          },
          null,
          2,
        ),
      );
    } finally {
      db.close();
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
