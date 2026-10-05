import { z } from "zod";
import { issueCreateSchema, issueUpdateSchema } from "./domain";
import type { ModelName, ModelRecord, ModelRecords } from "./domain";

/** Upper bound on operations in one client transaction, so a single message can't hold the workspace lock for long. */
export const MAX_OPS_PER_TRANSACTION = 100;
export const MAX_TRANSACTIONS_PER_PUSH = 100;

const uuid = z.uuid();

export const operationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("create"), model: z.literal("Issue"), id: uuid, data: issueCreateSchema }),
    z.object({ kind: z.literal("update"), model: z.literal("Issue"), id: uuid, changes: issueUpdateSchema }),
    z.object({ kind: z.literal("archive"), model: z.literal("Issue"), id: uuid }),
    z.object({ kind: z.literal("delete"), model: z.literal("Issue"), id: uuid }),
]);

export const transactionSchema = z.object({
    id: uuid,
    ops: z.array(operationSchema).min(1).max(MAX_OPS_PER_TRANSACTION),
});

export type Operation = z.infer<typeof operationSchema>;
export type Transaction = z.infer<typeof transactionSchema>;

export const SYNC_ACTION_KINDS = ["insert", "update", "archive", "delete"] as const;
export type SyncActionKind = (typeof SYNC_ACTION_KINDS)[number];

/**
 * One row of the server's sync log. `data` is the full record for an insert and only
 * the changed fields otherwise. `txId` is the client transaction that caused it, which
 * is how a client recognises its own writes when they come back.
 */
export type SyncAction = {
    [M in ModelName]: {
        syncId: number;
        model: M;
        modelId: string;
        action: SyncActionKind;
        data: Partial<ModelRecords[M]>;
        txId: string | null;
    };
}[ModelName];

export interface BootstrapPayload {
    lastSyncId: number;
    records: ModelRecord[];
}

export type RejectionCode = "invalid" | "not_found" | "conflict" | "internal";

export type ClientMessage =
    | { type: "hello"; workspaceId: string; clientId: string; lastSyncId: number }
    | { type: "push"; transactions: Transaction[] };

export type ServerMessage =
    /** Catch-up or live deltas, always in ascending syncId order. */
    | { type: "deltas"; actions: SyncAction[] }
    /** Sent once after the catch-up deltas for a hello; from here on everything is live. */
    | { type: "ready"; lastSyncId: number }
    /** The client is too far behind (or the log was compacted past it) and must bootstrap again. */
    | { type: "bootstrap_required" }
    | { type: "ack"; txId: string; syncId: number }
    | { type: "reject"; txId: string; code: RejectionCode; message: string }
    | { type: "error"; message: string };

export const clientMessageSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("hello"),
        workspaceId: uuid,
        clientId: z.string().min(1).max(64),
        lastSyncId: z.number().int().nonnegative(),
    }),
    z.object({
        type: z.literal("push"),
        // Transactions are validated one by one so a single bad one is rejected on its own.
        transactions: z.array(z.unknown()).min(1).max(MAX_TRANSACTIONS_PER_PUSH),
    }),
]);
