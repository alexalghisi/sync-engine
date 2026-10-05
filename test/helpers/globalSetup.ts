import { migrate } from "../../src/server/db/migrate";
import { createPool, ensureDatabase } from "../../src/server/db/pool";
import { TEST_DATABASE_URL } from "./db";

export default async function setup(): Promise<void> {
    await ensureDatabase(TEST_DATABASE_URL);
    const db = createPool(TEST_DATABASE_URL, 1);
    try {
        await migrate(db);
    } finally {
        await db.end();
    }
}
