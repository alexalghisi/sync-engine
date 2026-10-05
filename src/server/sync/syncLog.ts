import type { ModelName } from "../../shared/domain";
import type { SyncAction, SyncActionKind } from "../../shared/protocol";
import type { DbClient, Queryable } from "../db/pool";
import type { ActionDraft } from "../issues/issueRepository";

export const SYNC_CHANNEL = "sync_actions";

/** Payload of a NOTIFY: the sync id range one committed transaction appended. */
export interface SyncNotification {
    workspaceId: string;
    from: number;
    to: number;
}

interface SyncActionRow {
    sync_id: number;
    model: ModelName;
    model_id: string;
    action: SyncActionKind;
    data: Record<string, unknown>;
    tx_id: string | null;
}

const ACTION_SELECT = "sync_id, model, model_id, action, data, tx_id";

function actionFromRow(row: SyncActionRow): SyncAction {
    // The row's model column decides the shape of data; the log only ever holds what
    // the repositories wrote for that model.
    return {
        syncId: row.sync_id,
        model: row.model,
        modelId: row.model_id,
        action: row.action,
        data: row.data,
        txId: row.tx_id,
    } as SyncAction;
}

/**
 * Appends the actions of one transaction and schedules the NOTIFY, which Postgres only
 * delivers if and when the surrounding transaction commits. Must run while holding the
 * workspace lock so that sync ids are allocated in commit order.
 */
export async function appendActions(db: DbClient, workspaceId: string, txId: string | null, drafts: ActionDraft[]): Promise<SyncAction[]> {
    const { rows } = await db.query<SyncActionRow>(
        `insert into sync_actions (workspace_id, model, model_id, action, data, tx_id)
         select $1, d.model, d.model_id, d.action::sync_action_kind, d.data, $2
         from unnest($3::text[], $4::uuid[], $5::text[], $6::jsonb[]) with ordinality as d(model, model_id, action, data, ord)
         order by d.ord
         returning ${ACTION_SELECT}`,
        [
            workspaceId,
            txId,
            drafts.map((d) => d.model),
            drafts.map((d) => d.modelId),
            drafts.map((d) => d.action),
            drafts.map((d) => JSON.stringify(d.data)),
        ],
    );
    const actions = rows.map(actionFromRow).sort((a, b) => a.syncId - b.syncId);
    const first = actions[0];
    const last = actions.at(-1);
    if (first && last) {
        const notification: SyncNotification = { workspaceId, from: first.syncId, to: last.syncId };
        await db.query("select pg_notify($1, $2)", [SYNC_CHANNEL, JSON.stringify(notification)]);
    }
    return actions;
}

/** Serialises writers per workspace. Released automatically at commit or rollback. */
export async function lockWorkspace(db: DbClient, workspaceId: string): Promise<void> {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [workspaceId]);
}

export async function readActionRange(db: Queryable, workspaceId: string, from: number, to: number): Promise<SyncAction[]> {
    const { rows } = await db.query<SyncActionRow>(
        `select ${ACTION_SELECT} from sync_actions
         where workspace_id = $1 and sync_id between $2 and $3 order by sync_id`,
        [workspaceId, from, to],
    );
    return rows.map(actionFromRow);
}

export async function readActionsAfter(db: Queryable, workspaceId: string, afterSyncId: number, limit: number): Promise<SyncAction[]> {
    const { rows } = await db.query<SyncActionRow>(
        `select ${ACTION_SELECT} from sync_actions
         where workspace_id = $1 and sync_id > $2 order by sync_id limit $3`,
        [workspaceId, afterSyncId, limit],
    );
    return rows.map(actionFromRow);
}

export interface LogBounds {
    /** Clients below this must bootstrap: the actions before it are gone. */
    compactedThrough: number;
    /** The highest sync id that describes this workspace. */
    current: number;
}

export async function readLogBounds(db: Queryable, workspaceId: string): Promise<LogBounds> {
    const { rows } = await db.query<{ compacted_through: number; latest: number }>(
        `select coalesce((select compacted_through from sync_log_compaction where workspace_id = $1), 0) as compacted_through,
                coalesce((select max(sync_id) from sync_actions where workspace_id = $1), 0) as latest`,
        [workspaceId],
    );
    const row = rows[0] ?? { compacted_through: 0, latest: 0 };
    return { compactedThrough: row.compacted_through, current: Math.max(row.compacted_through, row.latest) };
}

export type CatchUp = { kind: "deltas"; actions: SyncAction[] } | { kind: "bootstrap_required" };

/**
 * Decides how a client that has applied everything up to `lastSyncId` gets current:
 * by replaying the missing actions, or, if they are gone or too many, by bootstrapping.
 */
export async function planCatchUp(db: Queryable, workspaceId: string, lastSyncId: number, maxActions: number): Promise<CatchUp> {
    const bounds = await readLogBounds(db, workspaceId);
    // A lastSyncId from the future means the client's data came from a different database.
    if (lastSyncId < bounds.compactedThrough || lastSyncId > bounds.current) return { kind: "bootstrap_required" };
    const actions = await readActionsAfter(db, workspaceId, lastSyncId, maxActions + 1);
    if (actions.length > maxActions) return { kind: "bootstrap_required" };
    return { kind: "deltas", actions };
}

/** Drops log entries up to and including `throughSyncId`; clients older than that will re-bootstrap. */
export async function compactLog(db: Queryable, workspaceId: string, throughSyncId: number): Promise<number> {
    const { rowCount } = await db.query("delete from sync_actions where workspace_id = $1 and sync_id <= $2", [workspaceId, throughSyncId]);
    await db.query(
        `insert into sync_log_compaction (workspace_id, compacted_through) values ($1, $2)
         on conflict (workspace_id) do update
         set compacted_through = greatest(sync_log_compaction.compacted_through, excluded.compacted_through)`,
        [workspaceId, throughSyncId],
    );
    return rowCount ?? 0;
}
