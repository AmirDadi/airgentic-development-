import Database from "better-sqlite3";
import { buildApp } from "./app.js";
import { migrate } from "./db.js";

const dbPath = process.env.DB_PATH ?? "dashboard.db";
const db = new Database(dbPath);
migrate(db);

const app = buildApp(db, { logger: true });

const port = Number(process.env.PORT ?? 8787);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
