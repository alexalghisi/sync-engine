import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import type { ModelRecord } from "../../shared/domain";
import type { BootstrapPayload } from "../../shared/protocol";
import type { ConfirmedDelta } from "../store/SyncStore";
import type { PendingTransaction } from "../store/records";
import { recordKey } from "../store/records";
import type { StoredState, SyncStorage } from "./SyncStorage";

interface SyncDb extends DBSchema {
    records: { key: string; value: ModelRecord };
    transactions: { key: string; value: PendingTransaction; indexes: { seq: number } };
    meta: { key: "lastSyncId"; value: number };
}

const VERSION = 1;

/** IndexedDB-backed storage. Every method is one IndexedDB transaction, so a crash never leaves half a delta behind. */
export class IndexedDbStorage implements SyncStorage {
    private constructor(private readonly db: IDBPDatabase<SyncDb>) {}

    static async open(name: string): Promise<IndexedDbStorage> {
        const db = await openDB<SyncDb>(name, VERSION, {
            upgrade(database) {
                database.createObjectStore("records");
                database.createObjectStore("transactions", { keyPath: "id" }).createIndex("seq", "seq");
                database.createObjectStore("meta");
            },
        });
        return new IndexedDbStorage(db);
    }

    async load(): Promise<StoredState> {
        const tx = this.db.transaction(["records", "transactions", "meta"], "readonly");
        const [lastSyncId, records, transactions] = await Promise.all([
            tx.objectStore("meta").get("lastSyncId"),
            tx.objectStore("records").getAll(),
            tx.objectStore("transactions").index("seq").getAll(),
        ]);
        await tx.done;
        return { snapshot: lastSyncId === undefined ? null : { lastSyncId, records }, transactions };
    }

    async replaceSnapshot(snapshot: BootstrapPayload): Promise<void> {
        const tx = this.db.transaction(["records", "meta"], "readwrite");
        const records = tx.objectStore("records");
        void records.clear();
        for (const record of snapshot.records) void records.put(record, recordKey(record.model, record.data.id));
        void tx.objectStore("meta").put(snapshot.lastSyncId, "lastSyncId");
        await tx.done;
    }

    async commitDelta(delta: ConfirmedDelta): Promise<void> {
        const tx = this.db.transaction(["records", "transactions", "meta"], "readwrite");
        const records = tx.objectStore("records");
        for (const record of delta.upserts) void records.put(record, recordKey(record.model, record.data.id));
        for (const key of delta.deletes) void records.delete(key);
        const transactions = tx.objectStore("transactions");
        for (const id of delta.confirmed) void transactions.delete(id);
        void tx.objectStore("meta").put(delta.lastSyncId, "lastSyncId");
        await tx.done;
    }

    async putTransaction(transaction: PendingTransaction): Promise<void> {
        await this.db.put("transactions", transaction);
    }

    async deleteTransaction(txId: string): Promise<void> {
        await this.db.delete("transactions", txId);
    }

    close(): void {
        this.db.close();
    }
}
