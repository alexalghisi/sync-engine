import { randomUUID } from "node:crypto";
import type { Db } from "../../src/server/db/pool";
import { createPool } from "../../src/server/db/pool";
import type { SeedResult } from "../../src/server/db/seed";
import { seedWorkspace } from "../../src/server/db/seed";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/syncengine_test";

export function testPool(): Db {
    return createPool(TEST_DATABASE_URL, 20);
}

/** Every test gets its own workspace, so tests never see each other's rows or sync actions. */
export function createWorkspace(db: Db, issues = 3): Promise<SeedResult> {
    return seedWorkspace(db, { workspaceId: randomUUID(), teamId: randomUUID(), issues, users: ["Ana", "Marco"] });
}

export async function issueIds(db: Db, workspaceId: string): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>("select id from issues where workspace_id = $1 order by sort_order", [workspaceId]);
    return rows.map((r) => r.id);
}
