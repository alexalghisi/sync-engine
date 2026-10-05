import type { ModelRecord, TeamRecord, UserRecord } from "../../shared/domain";
import type { BootstrapPayload } from "../../shared/protocol";
import type { Db } from "../db/pool";
import { listIssues } from "../issues/issueRepository";
import { readLogBounds } from "./syncLog";

/**
 * Full workspace state plus the sync id it corresponds to. Everything is read from one
 * repeatable-read snapshot; because writers commit in sync id order, that snapshot holds
 * exactly the actions up to `lastSyncId`, so replaying from there misses nothing.
 */
export async function loadBootstrap(db: Db, workspaceId: string): Promise<BootstrapPayload | null> {
    const client = await db.connect();
    try {
        await client.query("begin isolation level repeatable read read only");
        const workspace = await client.query("select 1 from workspaces where id = $1", [workspaceId]);
        if (!workspace.rowCount) {
            await client.query("commit");
            return null;
        }
        const bounds = await readLogBounds(client, workspaceId);
        const teams = await client.query<TeamRecord>("select id, key, name from teams where workspace_id = $1 order by key", [workspaceId]);
        const users = await client.query<UserRecord>("select id, name from users where workspace_id = $1 order by name", [workspaceId]);
        const issues = await listIssues(client, workspaceId, true);
        await client.query("commit");

        const records: ModelRecord[] = [
            ...teams.rows.map((data): ModelRecord => ({ model: "Team", data })),
            ...users.rows.map((data): ModelRecord => ({ model: "User", data })),
            ...issues.map((data): ModelRecord => ({ model: "Issue", data })),
        ];
        return { lastSyncId: bounds.current, records };
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        client.release();
    }
}
