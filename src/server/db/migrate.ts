import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db } from "./pool";
import { withTransaction } from "./pool";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Applies pending `NNN_name.sql` files in order. Each file runs in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
    await db.query(`create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
    )`);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];

    for (const file of files) {
        const done = await db.query("select 1 from schema_migrations where name = $1", [file]);
        if (done.rowCount) continue;
        const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
        await withTransaction(db, async (client) => {
            await client.query(sql);
            await client.query("insert into schema_migrations (name) values ($1)", [file]);
        });
        applied.push(file);
    }
    return applied;
}
