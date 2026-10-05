import type { IssueChanges, IssueCreateInput, IssuePriority, IssueRecord, IssueStatus, IssueWritableField } from "../../shared/domain";
import type { SyncActionKind } from "../../shared/protocol";
import type { DbClient, Queryable } from "../db/pool";
import { MutationError } from "../errors";

/** What a single operation changed, before it gets a sync id. */
export interface ActionDraft {
    model: "Issue";
    modelId: string;
    action: SyncActionKind;
    data: Partial<IssueRecord>;
}

interface IssueRow {
    id: string;
    team_id: string;
    title: string;
    description: string;
    status: IssueStatus;
    priority: IssuePriority;
    assignee_id: string | null;
    sort_order: number;
    created_at: Date;
    updated_at: Date;
    archived_at: Date | null;
}

const COLUMNS: Record<IssueWritableField, string> = {
    title: "title",
    description: "description",
    status: "status",
    priority: "priority",
    assigneeId: "assignee_id",
    sortOrder: "sort_order",
};

export const ISSUE_SELECT = `id, team_id, title, description, status, priority, assignee_id, sort_order,
    created_at, updated_at, archived_at`;

export function issueFromRow(row: IssueRow): IssueRecord {
    return {
        id: row.id,
        teamId: row.team_id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        assigneeId: row.assignee_id,
        sortOrder: row.sort_order,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        archivedAt: row.archived_at?.toISOString() ?? null,
    };
}

async function assertAssigneeInWorkspace(db: DbClient, workspaceId: string, assigneeId: string | null | undefined): Promise<void> {
    if (assigneeId == null) return;
    const { rowCount } = await db.query("select 1 from users where id = $1 and workspace_id = $2", [assigneeId, workspaceId]);
    if (!rowCount) throw new MutationError("invalid", `unknown assignee ${assigneeId}`);
}

export async function insertIssue(db: DbClient, workspaceId: string, id: string, input: IssueCreateInput): Promise<ActionDraft> {
    await assertAssigneeInWorkspace(db, workspaceId, input.assigneeId);
    const { rows } = await db.query<IssueRow>(
        `insert into issues (id, workspace_id, team_id, title, description, status, priority, assignee_id, sort_order)
         select $1, $2, t.id, $4, $5, $6, $7, $8, $9 from teams t where t.id = $3 and t.workspace_id = $2
         returning ${ISSUE_SELECT}`,
        [
            id,
            workspaceId,
            input.teamId,
            input.title,
            input.description ?? "",
            input.status ?? "backlog",
            input.priority ?? 0,
            input.assigneeId ?? null,
            input.sortOrder,
        ],
    );
    const row = rows[0];
    if (!row) throw new MutationError("not_found", `unknown team ${input.teamId}`);
    return { model: "Issue", modelId: id, action: "insert", data: issueFromRow(row) };
}

export async function updateIssue(db: DbClient, workspaceId: string, id: string, changes: IssueChanges): Promise<ActionDraft> {
    await assertAssigneeInWorkspace(db, workspaceId, changes.assigneeId);
    const fields = Object.keys(changes) as IssueWritableField[];
    const assignments = fields.map((field, i) => `${COLUMNS[field]} = $${i + 3}`);
    const { rows } = await db.query<{ updated_at: Date }>(
        `update issues set ${assignments.join(", ")}, updated_at = now()
         where id = $1 and workspace_id = $2 returning updated_at`,
        [id, workspaceId, ...fields.map((f) => changes[f])],
    );
    const row = rows[0];
    if (!row) throw new MutationError("not_found", `unknown issue ${id}`);
    return { model: "Issue", modelId: id, action: "update", data: { ...changes, updatedAt: row.updated_at.toISOString() } };
}

export async function archiveIssue(db: DbClient, workspaceId: string, id: string): Promise<ActionDraft> {
    const { rows } = await db.query<{ archived_at: Date; updated_at: Date }>(
        `update issues set archived_at = coalesce(archived_at, now()), updated_at = now()
         where id = $1 and workspace_id = $2 returning archived_at, updated_at`,
        [id, workspaceId],
    );
    const row = rows[0];
    if (!row) throw new MutationError("not_found", `unknown issue ${id}`);
    return {
        model: "Issue",
        modelId: id,
        action: "archive",
        data: { archivedAt: row.archived_at.toISOString(), updatedAt: row.updated_at.toISOString() },
    };
}

export async function deleteIssue(db: DbClient, workspaceId: string, id: string): Promise<ActionDraft> {
    const { rowCount } = await db.query("delete from issues where id = $1 and workspace_id = $2", [id, workspaceId]);
    if (!rowCount) throw new MutationError("not_found", `unknown issue ${id}`);
    return { model: "Issue", modelId: id, action: "delete", data: {} };
}

export async function findIssue(db: Queryable, workspaceId: string, id: string): Promise<IssueRecord | null> {
    const { rows } = await db.query<IssueRow>(`select ${ISSUE_SELECT} from issues where id = $1 and workspace_id = $2`, [id, workspaceId]);
    return rows[0] ? issueFromRow(rows[0]) : null;
}

export async function listIssues(db: Queryable, workspaceId: string, includeArchived: boolean): Promise<IssueRecord[]> {
    const { rows } = await db.query<IssueRow>(
        `select ${ISSUE_SELECT} from issues
         where workspace_id = $1 and ($2 or archived_at is null)
         order by sort_order, id`,
        [workspaceId, includeArchived],
    );
    return rows.map(issueFromRow);
}
