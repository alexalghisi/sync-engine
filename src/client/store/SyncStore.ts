import { action, computed, makeObservable, observable, runInAction } from "mobx";
import type { ModelName, ModelRecord } from "../../shared/domain";
import type { BootstrapPayload, SyncAction } from "../../shared/protocol";
import { ObjectPool } from "../models/ObjectPool";
import type { PendingTransaction, RecordKey } from "./records";
import { applyAction, applyOperation, parseRecordKey, recordKey } from "./records";

/** What a batch of server actions changed in the confirmed state, for persisting it. */
export interface ConfirmedDelta {
    lastSyncId: number;
    upserts: ModelRecord[];
    deletes: RecordKey[];
    /** Local transactions that are now part of the confirmed state. */
    confirmed: string[];
}

/**
 * Two layers of state. The confirmed layer is exactly what the server has told us, up to
 * `lastSyncId`. The pending layer holds local transactions it has not confirmed yet. The object
 * pool the UI reads is always confirmed state with the pending transactions replayed on
 * top, in order.
 *
 * That one rule covers the hard cases: an optimistic write is a pending transaction; a
 * rollback is dropping it and replaying the rest; and a client's own write coming back
 * from the server moves from the pending layer into the confirmed one in the same step,
 * so it is never applied twice and never flickers.
 */
export class SyncStore {
    readonly pool = new ObjectPool();
    lastSyncId = 0;
    private readonly confirmedState = new Map<RecordKey, ModelRecord>();
    private readonly pending = observable.array<PendingTransaction>([], { deep: false });
    /** Acks that arrived before the deltas they refer to. */
    private readonly acked = new Map<string, number>();

    constructor() {
        makeObservable(this, {
            lastSyncId: observable,
            pendingCount: computed,
            pendingKeys: computed,
            reset: action,
            addLocal: action,
            applyActions: action,
            acknowledge: action,
            reject: action,
        });
    }

    get pendingCount(): number {
        return this.pending.length;
    }

    /** Records with local changes the server has not confirmed yet. */
    get pendingKeys(): ReadonlySet<RecordKey> {
        const keys = new Set<RecordKey>();
        for (const tx of this.pending) for (const op of tx.ops) keys.add(recordKey(op.model, op.id));
        return keys;
    }

    isPending(model: ModelName, id: string): boolean {
        return this.pendingKeys.has(recordKey(model, id));
    }

    pendingTransactions(): readonly PendingTransaction[] {
        return this.pending;
    }

    hasPending(txId: string): boolean {
        return this.pending.some((tx) => tx.id === txId);
    }

    confirmed(key: RecordKey): ModelRecord | undefined {
        return this.confirmedState.get(key);
    }

    /** Replaces the confirmed state wholesale (bootstrap or restore) and replays pending transactions on top. */
    reset(snapshot: BootstrapPayload, pending: readonly PendingTransaction[] = this.pending): void {
        this.confirmedState.clear();
        for (const record of snapshot.records) this.confirmedState.set(recordKey(record.model, record.data.id), record);
        this.lastSyncId = snapshot.lastSyncId;
        this.pending.replace([...pending].sort((a, b) => a.seq - b.seq));
        this.acked.clear();

        const keys = new Set<RecordKey>(this.confirmedState.keys());
        for (const tx of this.pending) for (const op of tx.ops) keys.add(recordKey(op.model, op.id));
        this.pool.retain((model, id) => keys.has(recordKey(model, id)));
        this.recompute(keys);
    }

    addLocal(tx: PendingTransaction): void {
        this.pending.push(tx);
        this.recompute(new Set(tx.ops.map((op) => recordKey(op.model, op.id))));
    }

    /** Applies server actions in sync id order. Actions at or below `lastSyncId` were already applied and are skipped. */
    applyActions(actions: readonly SyncAction[]): ConfirmedDelta {
        const touched = new Set<RecordKey>();
        const confirmed = new Set<string>();
        const pendingIds = new Set(this.pending.map((tx) => tx.id));

        for (const syncAction of actions) {
            if (syncAction.syncId <= this.lastSyncId) continue;
            const key = recordKey(syncAction.model, syncAction.modelId);
            const next = applyAction(this.confirmedState.get(key), syncAction);
            if (next) this.confirmedState.set(key, next);
            else this.confirmedState.delete(key);
            touched.add(key);
            this.lastSyncId = syncAction.syncId;
            if (syncAction.txId && pendingIds.has(syncAction.txId)) confirmed.add(syncAction.txId);
        }
        for (const [txId, syncId] of this.acked) if (syncId <= this.lastSyncId) confirmed.add(txId);

        this.recompute(new Set([...touched, ...this.removePending(confirmed)]));

        const upserts: ModelRecord[] = [];
        const deletes: RecordKey[] = [];
        for (const key of touched) {
            const record = this.confirmedState.get(key);
            if (record) upserts.push(record);
            else deletes.push(key);
        }
        return { lastSyncId: this.lastSyncId, upserts, deletes, confirmed: [...confirmed] };
    }

    /**
     * The server committed `txId` as `syncId`. If we have already applied that sync id the
     * transaction is part of the confirmed state and can go; otherwise wait for its actions.
     * Returns whether the transaction was removed.
     */
    acknowledge(txId: string, syncId: number): boolean {
        if (!this.hasPending(txId)) return false;
        if (syncId > this.lastSyncId) {
            this.acked.set(txId, syncId);
            return false;
        }
        this.recompute(this.removePending(new Set([txId])));
        return true;
    }

    /** The server refused `txId`: drop it, and with it its optimistic effects. */
    reject(txId: string): PendingTransaction | undefined {
        const tx = this.pending.find((t) => t.id === txId);
        if (!tx) return undefined;
        this.recompute(this.removePending(new Set([txId])));
        return tx;
    }

    /** Drops transactions from the pending layer and returns the records they touched. */
    private removePending(txIds: ReadonlySet<string>): Set<RecordKey> {
        const affected = new Set<RecordKey>();
        if (txIds.size === 0) return affected;
        for (const tx of this.pending) {
            if (txIds.has(tx.id)) for (const op of tx.ops) affected.add(recordKey(op.model, op.id));
        }
        this.pending.replace(this.pending.filter((tx) => !txIds.has(tx.id)));
        for (const id of txIds) this.acked.delete(id);
        return affected;
    }

    /** Rebuilds the pool entry of each key from confirmed state plus pending transactions. */
    private recompute(keys: ReadonlySet<RecordKey>): void {
        if (keys.size === 0) return;
        const opsByKey = new Map<RecordKey, { tx: PendingTransaction; index: number }[]>();
        for (const tx of this.pending) {
            tx.ops.forEach((op, index) => {
                const key = recordKey(op.model, op.id);
                if (!keys.has(key)) return;
                const list = opsByKey.get(key);
                if (list) list.push({ tx, index });
                else opsByKey.set(key, [{ tx, index }]);
            });
        }
        runInAction(() => {
            for (const key of keys) {
                let record = this.confirmedState.get(key);
                for (const { tx, index } of opsByKey.get(key) ?? []) {
                    const op = tx.ops[index];
                    if (op) record = applyOperation(record, op, tx.createdAt);
                }
                const { model, id } = parseRecordKey(key);
                this.pool.reconcile(model, id, record);
            }
        });
    }
}
