import type { Operation, RejectionCode, SyncAction, Transaction } from "../../shared/protocol";
import type { Db, DbClient } from "../db/pool";
import { toMutationError } from "../errors";
import type { ActionDraft } from "../issues/issueRepository";
import { archiveIssue, deleteIssue, insertIssue, updateIssue } from "../issues/issueRepository";
import { appendActions, lockWorkspace } from "./syncLog";

export type MutationResult =
    | { ok: true; syncId: number; actions: SyncAction[]; duplicate: boolean }
    | { ok: false; code: RejectionCode; message: string };

function applyOperation(db: DbClient, workspaceId: string, op: Operation): Promise<ActionDraft> {
    switch (op.kind) {
        case "create":
            return insertIssue(db, workspaceId, op.id, op.data);
        case "update":
            return updateIssue(db, workspaceId, op.id, op.changes);
        case "archive":
            return archiveIssue(db, workspaceId, op.id);
        case "delete":
            return deleteIssue(db, workspaceId, op.id);
    }
}

/**
 * The only write path. GraphQL mutations and websocket transactions both end up here, so
 * every change is validated the same way and lands in the sync log in the same database
 * transaction as the change itself.
 */
export class MutationService {
    constructor(private readonly db: Db) {}

    async apply(workspaceId: string, tx: Transaction): Promise<MutationResult> {
        const client = await this.db.connect();
        try {
            await client.query("begin");
            await lockWorkspace(client, workspaceId);

            const previous = await client.query<{ last_sync_id: number }>(
                "select last_sync_id from applied_transactions where tx_id = $1 and workspace_id = $2",
                [tx.id, workspaceId],
            );
            const replayed = previous.rows[0];
            if (replayed) {
                await client.query("commit");
                return { ok: true, syncId: replayed.last_sync_id, actions: [], duplicate: true };
            }

            const drafts: ActionDraft[] = [];
            for (const op of tx.ops) drafts.push(await applyOperation(client, workspaceId, op));
            const actions = await appendActions(client, workspaceId, tx.id, drafts);
            const syncId = actions.at(-1)?.syncId ?? 0;
            await client.query("insert into applied_transactions (tx_id, workspace_id, last_sync_id) values ($1, $2, $3)", [
                tx.id,
                workspaceId,
                syncId,
            ]);
            await client.query("commit");
            return { ok: true, syncId, actions, duplicate: false };
        } catch (error) {
            await client.query("rollback");
            const rejection = toMutationError(error);
            if (!rejection) throw error;
            return { ok: false, code: rejection.code, message: rejection.message };
        } finally {
            client.release();
        }
    }
}
