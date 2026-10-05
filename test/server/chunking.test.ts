import { describe, expect, it } from "vitest";
import { chunkByTransaction } from "../../src/server/sync/syncSession";
import type { SyncAction } from "../../src/shared/protocol";

function action(syncId: number, txId: string | null): SyncAction {
    return { syncId, model: "Issue", modelId: "i", action: "update", data: {}, txId };
}

describe("chunkByTransaction", () => {
    it("splits at the requested size", () => {
        const actions = [1, 2, 3, 4, 5].map((n) => action(n, `t${n}`));
        expect(chunkByTransaction(actions, 2).map((c) => c.map((a) => a.syncId))).toEqual([[1, 2], [3, 4], [5]]);
    });

    it("keeps the actions of one transaction in the same frame", () => {
        const actions = [action(1, "a"), action(2, "b"), action(3, "b"), action(4, "b"), action(5, "c")];
        expect(chunkByTransaction(actions, 2).map((c) => c.map((a) => a.syncId))).toEqual([[1, 2, 3, 4], [5]]);
    });

    it("does not glue together unrelated actions without a transaction id", () => {
        const actions = [action(1, null), action(2, null), action(3, null)];
        expect(chunkByTransaction(actions, 2)).toHaveLength(2);
    });

    it("returns nothing for nothing", () => {
        expect(chunkByTransaction([], 10)).toEqual([]);
    });
});
