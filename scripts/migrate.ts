import { loadConfig } from "../src/server/config";
import { migrate } from "../src/server/db/migrate";
import { createPool, ensureDatabase } from "../src/server/db/pool";

const { databaseUrl } = loadConfig();
await ensureDatabase(databaseUrl);
const db = createPool(databaseUrl, 1);
const applied = await migrate(db);
console.log(applied.length ? `applied ${applied.join(", ")}` : "database is up to date");
await db.end();
