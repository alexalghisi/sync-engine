import type { IssueRecord, ModelName, ModelRecord } from "../../shared/domain";
import type { Operation, SyncAction, Transaction } from "../../shared/protocol";

export type RecordKey = `${ModelName}:${string}`;

export function recordKey(model: ModelName, id: string): RecordKey {
    return `${model}:${id}`;
}

export function parseRecordKey(key: RecordKey): { model: ModelName; id: string } {
    const separator = key.indexOf(":");
    return { model: key.slice(0, separator) as ModelName, id: key.slice(separator + 1) };
}

/** A local transaction waiting for the server. `seq` fixes the order it was made in. */
export interface PendingTransaction extends Transaction {
    seq: number;
    createdAt: string;
}

/** Applies one server action to the confirmed state of a record. */
export function applyAction(current: ModelRecord | undefined, action: SyncAction): ModelRecord | undefined {
    switch (action.action) {
        case "insert":
            // Inserts always carry the full record; see appendActions on the server.
            return { model: action.model, data: action.data } as ModelRecord;
        case "update":
        case "archive":
            if (!current) return undefined;
            return { model: current.model, data: { ...current.data, ...action.data } } as ModelRecord;
        case "delete":
            return undefined;
    }
}

/**
 * Applies one local operation on top of a record, the way the server is expected to. The
 * result is only a prediction: once the server's actions arrive, they replace it.
 */
export function applyOperation(current: ModelRecord | undefined, op: Operation, at: string): ModelRecord | undefined {
    const issue = current?.model === "Issue" ? current.data : undefined;
    switch (op.kind) {
        case "create": {
            if (current) return current; // the server will reject the duplicate id
            const data: IssueRecord = {
                id: op.id,
                teamId: op.data.teamId,
                title: op.data.title,
                description: op.data.description ?? "",
                status: op.data.status ?? "backlog",
                priority: op.data.priority ?? 0,
                assigneeId: op.data.assigneeId ?? null,
                sortOrder: op.data.sortOrder,
                createdAt: at,
                updatedAt: at,
                archivedAt: null,
            };
            return { model: "Issue", data };
        }
        case "update":
            return issue ? { model: "Issue", data: { ...issue, ...op.changes, updatedAt: at } } : current;
        case "archive":
            return issue ? { model: "Issue", data: { ...issue, archivedAt: issue.archivedAt ?? at, updatedAt: at } } : current;
        case "delete":
            return undefined;
    }
}
