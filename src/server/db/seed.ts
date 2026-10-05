import { randomUUID } from "node:crypto";
import { ISSUE_STATUSES } from "../../shared/domain";
import type { Db } from "./pool";
import { withTransaction } from "./pool";

export interface SeedOptions {
    workspaceId: string;
    teamId: string;
    issues: number;
    users?: readonly string[];
}

export interface SeedResult {
    workspaceId: string;
    teamId: string;
    userIds: string[];
}

const DEFAULT_USERS = ["Ana Pop", "Marco Bianchi", "Ioana Rus", "Luca Moretti", "Elena Dobre", "Sam Carter"];

const VERBS = ["Fix", "Add", "Remove", "Refactor", "Investigate", "Speed up", "Document", "Migrate", "Polish", "Test"];
const SUBJECTS = [
    "sync catch-up after long offline periods",
    "keyboard shortcuts in the issue list",
    "IndexedDB quota handling",
    "websocket reconnect backoff",
    "priority icon alignment",
    "bootstrap payload size",
    "archived issues filter",
    "assignee picker search",
    "transaction rollback toast",
    "dark mode contrast in the sidebar",
    "GraphQL error codes",
    "sort order rebalancing",
    "notification fan-out latency",
    "issue detail scroll position",
    "presence indicators",
];

export function issueTitle(n: number): string {
    const verb = VERBS[n % VERBS.length] ?? "Fix";
    const subject = SUBJECTS[(n * 7 + Math.floor(n / VERBS.length)) % SUBJECTS.length] ?? "it";
    return `${verb} ${subject}`;
}

/**
 * Replaces the workspace with fresh demo data. Seeding bypasses the mutation service, so
 * it also moves the compaction watermark: any client still holding the old data has a
 * lastSyncId below it and is told to bootstrap again instead of replaying a log that no
 * longer describes the database. The watermark consumes a sequence value, so no action
 * can ever share it.
 */
export async function seedWorkspace(db: Db, options: SeedOptions): Promise<SeedResult> {
    const { workspaceId, teamId, issues } = options;
    const names = options.users ?? DEFAULT_USERS;
    const userIds = names.map(() => randomUUID());

    await withTransaction(db, async (client) => {
        await client.query("delete from workspaces where id = $1", [workspaceId]);
        await client.query("insert into workspaces (id, name) values ($1, 'Demo')", [workspaceId]);
        await client.query("insert into teams (id, workspace_id, key, name) values ($1, $2, 'ENG', 'Engineering')", [
            teamId,
            workspaceId,
        ]);
        await client.query(
            "insert into users (id, workspace_id, name) select unnest($1::uuid[]), $2, unnest($3::text[])",
            [userIds, workspaceId, names],
        );

        const ids: string[] = [];
        const titles: string[] = [];
        const statuses: string[] = [];
        const priorities: number[] = [];
        const assignees: (string | null)[] = [];
        for (let i = 0; i < issues; i++) {
            ids.push(randomUUID());
            titles.push(issueTitle(i));
            statuses.push(ISSUE_STATUSES[i % ISSUE_STATUSES.length] ?? "backlog");
            priorities.push((i * 3 + 1) % 5);
            assignees.push(i % 4 === 0 ? null : (userIds[i % userIds.length] ?? null));
        }
        await client.query(
            `insert into issues (id, workspace_id, team_id, title, status, priority, assignee_id, sort_order)
             select t.id, $1, $2, t.title, t.status, t.priority, t.assignee, t.ord
             from unnest($3::uuid[], $4::text[], $5::text[], $6::smallint[], $7::uuid[])
                  with ordinality as t(id, title, status, priority, assignee, ord)`,
            [workspaceId, teamId, ids, titles, statuses, priorities, assignees],
        );
        await client.query(
            `insert into sync_log_compaction (workspace_id, compacted_through)
             select $1, nextval('sync_actions_sync_id_seq')
             on conflict (workspace_id) do update set compacted_through = excluded.compacted_through`,
            [workspaceId],
        );
    });

    return { workspaceId, teamId, userIds };
}
