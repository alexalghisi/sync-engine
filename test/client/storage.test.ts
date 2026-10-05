import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbStorage } from "../../src/client/storage/IndexedDbStorage";
import { MemoryStorage } from "../../src/client/storage/MemoryStorage";
import type { SyncStorage } from "../../src/client/storage/SyncStorage";
import type { PendingTransaction } from "../../src/client/store/records";
import { recordKey } from "../../src/client/store/records";
import { issueRecord, snapshot } from "../helpers/fakes";

function pending(seq: number): PendingTransaction {
    return { id: crypto.randomUUID(), seq, createdAt: "2026-01-01T00:00:00.000Z", ops: [{ kind: "archive", model: "Issue", id: crypto.randomUUID() }] };
}

const implementations: [string, () => Promise<SyncStorage>][] = [
    ["MemoryStorage", async () => new MemoryStorage()],
    ["IndexedDbStorage", () => IndexedDbStorage.open(`test-${crypto.randomUUID()}`)],
];

describe.each(implementations)("%s", (_name, open) => {
    it("starts empty", async () => {
        const storage = await open();
        expect(await storage.load()).toEqual({ snapshot: null, transactions: [] });
    });

    it("stores a snapshot and applies deltas on top of it", async () => {
        const storage = await open();
        const [a, b] = [issueRecord(), issueRecord()];
        await storage.replaceSnapshot(snapshot(5, [a, b]));
        const confirmedTx = pending(1);
        const keptTx = pending(2);
        await storage.putTransaction(confirmedTx);
        await storage.putTransaction(keptTx);

        await storage.commitDelta({
            lastSyncId: 9,
            upserts: [{ model: "Issue", data: { ...a, title: "Changed" } }],
            deletes: [recordKey("Issue", b.id)],
            confirmed: [confirmedTx.id],
        });

        const loaded = await storage.load();
        expect(loaded.snapshot?.lastSyncId).toBe(9);
        const issues = loaded.snapshot?.records.filter((r) => r.model === "Issue").map((r) => r.data);
        expect(issues).toEqual([{ ...a, title: "Changed" }]);
        expect(loaded.transactions).toEqual([keptTx]);
    });

    it("returns queued transactions in creation order", async () => {
        const storage = await open();
        const txs = [pending(3), pending(1), pending(2)];
        for (const tx of txs) await storage.putTransaction(tx);
        await storage.deleteTransaction(txs[2]?.id ?? "");

        expect((await storage.load()).transactions.map((tx) => tx.seq)).toEqual([1, 3]);
    });

    it("replaces, not merges, on a new snapshot", async () => {
        const storage = await open();
        await storage.replaceSnapshot(snapshot(5, [issueRecord(), issueRecord()]));
        const only = issueRecord();
        await storage.replaceSnapshot(snapshot(50, [only]));

        const loaded = await storage.load();
        expect(loaded.snapshot?.records.filter((r) => r.model === "Issue")).toEqual([{ model: "Issue", data: only }]);
    });
});
