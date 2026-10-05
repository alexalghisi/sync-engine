import { migrate } from "../src/server/db/migrate";
import { createPool, ensureDatabase } from "../src/server/db/pool";
import { seedWorkspace } from "../src/server/db/seed";
import { E2E_DATABASE_URL, E2E_TEAM_ID, E2E_WORKSPACE_ID } from "./fixtures";

export default async function globalSetup(): Promise<void> {
    await ensureDatabase(E2E_DATABASE_URL);
    const db = createPool(E2E_DATABASE_URL, 1);
    try {
        await migrate(db);
        await seedWorkspace(db, { workspaceId: E2E_WORKSPACE_ID, teamId: E2E_TEAM_ID, issues: 500 });
    } finally {
        await db.end();
    }
}
