import type { ModelRecord } from "../../shared/domain";
import type { BootstrapPayload } from "../../shared/protocol";
import type { ConfirmedDelta } from "../store/SyncStore";
import type { PendingTransaction, RecordKey } from "../store/records";
import { recordKey } from "../store/records";
import type { StoredState, SyncStorage } from "./SyncStorage";

/**
 * In-memory storage for tests and for environments without IndexedDB. Values are cloned
 * on the way in and out, like a real store would, so callers cannot alias its contents.
 */
export class MemoryStorage implements SyncStorage {
    private lastSyncId: number | null = null;
    private readonly records = new Map<RecordKey, ModelRecord>();
    private readonly transactions = new Map<string, PendingTransaction>();

    async load(): Promise<StoredState> {
        const snapshot = this.lastSyncId === null ? null : { lastSyncId: this.lastSyncId, records: structuredClone([...this.records.values()]) };
        const transactions = structuredClone([...this.transactions.values()]).sort((a, b) => a.seq - b.seq);
        return { snapshot, transactions };
    }

    async replaceSnapshot(snapshot: BootstrapPayload): Promise<void> {
        this.records.clear();
        for (const record of structuredClone(snapshot.records)) this.records.set(recordKey(record.model, record.data.id), record);
        this.lastSyncId = snapshot.lastSyncId;
    }

    async commitDelta(delta: ConfirmedDelta): Promise<void> {
        for (const record of structuredClone(delta.upserts)) this.records.set(recordKey(record.model, record.data.id), record);
        for (const key of delta.deletes) this.records.delete(key);
        for (const id of delta.confirmed) this.transactions.delete(id);
        this.lastSyncId = delta.lastSyncId;
    }

    async putTransaction(tx: PendingTransaction): Promise<void> {
        this.transactions.set(tx.id, structuredClone(tx));
    }

    async deleteTransaction(txId: string): Promise<void> {
        this.transactions.delete(txId);
    }
}
