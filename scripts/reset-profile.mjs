// Dev helper: clear the saved Profile so the next connection re-runs onboarding.
import Database from "better-sqlite3";
import { resolve } from "node:path";

const dbPath = process.env.SKILLOS_DB_PATH ?? resolve("storage/skillos.db");
const db = new Database(dbPath);
const info = db.prepare("DELETE FROM Profile").run();
console.log(`cleared Profile rows: ${info.changes} (db: ${dbPath})`);
db.close();
