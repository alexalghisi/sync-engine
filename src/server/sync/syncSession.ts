import { z } from "zod";
import type { ServerMessage, SyncAction } from "../../shared/protocol";
import { clientMessageSchema, transactionSchema } from "../../shared/protocol";
import type { Db } from "../db/pool";
import type { MutationService } from "./mutationService";
import type { Logger, SyncHub, SyncSubscriber } from "./syncHub";
import { planCatchUp } from "./syncLog";

export interface SessionDeps {
    db: Db;
    hub: SyncHub;
    mutations: MutationService;
    maxCatchUpActions: number;
    logger: Logger;
}

export interface SessionTransport {
    send(message: ServerMessage): void;
    close(): void;
}

/** Large catch-ups are split so no single frame grows unbounded. */
export const DELTA_CHUNK_SIZE = 1_000;

const txIdOnly = z.object({ id: z.uuid() });

/**
 * One client connection. After `hello` it streams every action with a sync id above the
 * client's cursor exactly once, in order: first the catch-up from the log, then live
 * actions from the hub. Live actions that arrive while the catch-up query runs are held
 * back and de-duplicated against it, so neither a gap nor a repeat is possible.
 */
export class SyncSession implements SyncSubscriber {
    private workspaceId: string | null = null;
    private cursor = 0;
    private held: SyncAction[] | null = null;
    private unsubscribe: (() => void) | null = null;
    private queue: Promise<void> = Promise.resolve();
    private closed = false;

    constructor(
        private readonly deps: SessionDeps,
        private readonly transport: SessionTransport,
    ) {}

    receive(raw: string): void {
        this.enqueue(() => this.handle(raw));
    }

    close(): void {
        this.closed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    deliver(actions: SyncAction[]): void {
        if (this.held) this.held.push(...actions);
        else this.sendFresh(actions);
    }

    resync(): void {
        if (this.workspaceId) this.enqueue(() => this.catchUp());
    }

    private enqueue(task: () => Promise<void>): void {
        this.queue = this.queue.then(task).catch((error: unknown) => {
            // Database trouble is not the client's fault: drop the connection and let it
            // reconnect and resend, rather than rejecting work that may well succeed later.
            this.deps.logger.error("sync session failed", error);
            this.transport.send({ type: "error", message: "internal error" });
            this.transport.close();
        });
    }

    private async handle(raw: string): Promise<void> {
        if (this.closed) return;
        const parsed = clientMessageSchema.safeParse(safeJson(raw));
        if (!parsed.success) {
            this.transport.send({ type: "error", message: "malformed message" });
            return;
        }
        const message = parsed.data;
        switch (message.type) {
            case "hello":
                if (this.workspaceId) {
                    this.transport.send({ type: "error", message: "already subscribed" });
                    return;
                }
                this.workspaceId = message.workspaceId;
                this.cursor = message.lastSyncId;
                this.unsubscribe = this.deps.hub.subscribe(message.workspaceId, this);
                await this.catchUp();
                return;
            case "push":
                await this.push(message.transactions);
                return;
        }
    }

    private async catchUp(): Promise<void> {
        const workspaceId = this.workspaceId;
        if (!workspaceId || this.closed) return;
        // Subscribed before the query starts: anything committed after the query's snapshot
        // is guaranteed to come through deliver() and land in `held`.
        this.held ??= [];
        const plan = await planCatchUp(this.deps.db, workspaceId, this.cursor, this.deps.maxCatchUpActions);
        const held = this.held;
        this.held = null;

        if (plan.kind === "bootstrap_required") {
            this.unsubscribe?.();
            this.unsubscribe = null;
            this.workspaceId = null;
            this.transport.send({ type: "bootstrap_required" });
            return;
        }
        this.sendFresh(plan.actions);
        this.sendFresh(held);
        this.transport.send({ type: "ready", lastSyncId: this.cursor });
    }

    private async push(transactions: unknown[]): Promise<void> {
        const workspaceId = this.workspaceId;
        if (!workspaceId) {
            this.transport.send({ type: "error", message: "send hello first" });
            return;
        }
        for (const raw of transactions) {
            if (this.closed) return;
            const tx = transactionSchema.safeParse(raw);
            if (!tx.success) {
                const id = txIdOnly.safeParse(raw);
                if (id.success) this.transport.send({ type: "reject", txId: id.data.id, code: "invalid", message: tx.error.message });
                else this.transport.send({ type: "error", message: "transaction without an id" });
                continue;
            }
            const result = await this.deps.mutations.apply(workspaceId, tx.data);
            this.transport.send(
                result.ok
                    ? { type: "ack", txId: tx.data.id, syncId: result.syncId }
                    : { type: "reject", txId: tx.data.id, code: result.code, message: result.message },
            );
        }
    }

    private sendFresh(actions: readonly SyncAction[]): void {
        if (this.closed) return;
        const fresh = actions.filter((a) => a.syncId > this.cursor);
        for (const chunk of chunkByTransaction(fresh, DELTA_CHUNK_SIZE)) this.transport.send({ type: "deltas", actions: chunk });
        const last = fresh.at(-1);
        if (last) this.cursor = last.syncId;
    }
}

/**
 * Splits actions into frames of roughly `size`, never separating the actions of one
 * transaction: a client confirms its own transaction when the first of them arrives, so
 * they must all arrive together.
 */
export function chunkByTransaction(actions: readonly SyncAction[], size: number): SyncAction[][] {
    const chunks: SyncAction[][] = [];
    let current: SyncAction[] = [];
    for (const action of actions) {
        const previous = current.at(-1);
        const continuesTransaction = previous !== undefined && action.txId !== null && previous.txId === action.txId;
        if (current.length >= size && !continuesTransaction) {
            chunks.push(current);
            current = [];
        }
        current.push(action);
    }
    if (current.length) chunks.push(current);
    return chunks;
}

function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}
