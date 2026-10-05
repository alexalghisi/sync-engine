import { autorun } from "mobx";
import { beforeEach, describe, expect, it } from "vitest";
import type { Issue } from "../../src/client/models/models";
import type { PendingTransaction } from "../../src/client/store/records";
import { recordKey } from "../../src/client/store/records";
import { SyncStore } from "../../src/client/store/SyncStore";
import type { IssueChanges, IssueRecord } from "../../src/shared/domain";
import { issueRecord, issueUpdate, snapshot, TEAM_ID } from "../helpers/fakes";

let store: SyncStore;
let base: IssueRecord;
let seq = 0;

function local(changes: IssueChanges, id = base.id): PendingTransaction {
    const tx: PendingTransaction = {
        id: crypto.randomUUID(),
        seq: ++seq,
        createdAt: "2026-02-01T00:00:00.000Z",
        ops: [{ kind: "update", model: "Issue", id, changes }],
    };
    store.addLocal(tx);
    return tx;
}

function issue(id = base.id): Issue | undefined {
    return store.pool.get("Issue", id);
}

beforeEach(() => {
    store = new SyncStore();
    base = issueRecord({ title: "Original", status: "todo", priority: 0 });
    store.reset(snapshot(10, [base]));
});

describe("optimistic apply", () => {
    it("shows a local change immediately without touching the confirmed state", () => {
        local({ title: "Edited" });

        expect(issue()?.title).toBe("Edited");
        expect(store.confirmed(recordKey("Issue", base.id))?.data).toMatchObject({ title: "Original" });
        expect(store.pendingCount).toBe(1);
    });

    it("creates issues optimistically with server defaults", () => {
        const id = crypto.randomUUID();
        store.addLocal({ id: crypto.randomUUID(), seq: ++seq, createdAt: "2026-02-01T00:00:00.000Z", ops: [{ kind: "create", model: "Issue", id, data: { teamId: TEAM_ID, title: "New", sortOrder: -1 } }] });

        expect(issue(id)).toMatchObject({ title: "New", status: "backlog", priority: 0, assigneeId: null, archivedAt: null });
        expect(issue(id)?.team?.key).toBe("ENG");
    });

    it("re-renders observers only for the fields that changed", () => {
        const other = issueRecord();
        store.reset(snapshot(10, [base, other]));
        const seen: string[] = [];
        const dispose = autorun(() => seen.push(issue()?.title ?? "gone"));

        local({ priority: 2 });
        local({ title: "Other" }, other.id);
        local({ title: "Mine" });
        dispose();

        expect(seen).toEqual(["Original", "Mine"]);
    });
});

describe("rollback", () => {
    it("drops a rejected transaction and replays the ones after it", () => {
        const first = local({ title: "Rejected title", status: "done" });
        local({ priority: 3 });

        store.reject(first.id);

        expect(issue()).toMatchObject({ title: "Original", status: "todo", priority: 3 });
        expect(store.pendingCount).toBe(1);
    });

    it("removes an optimistically created issue when its creation is rejected", () => {
        const id = crypto.randomUUID();
        const tx: PendingTransaction = { id: crypto.randomUUID(), seq: ++seq, createdAt: "2026-02-01T00:00:00.000Z", ops: [{ kind: "create", model: "Issue", id, data: { teamId: TEAM_ID, title: "Doomed", sortOrder: 0 } }] };
        store.addLocal(tx);
        expect(issue(id)).toBeDefined();

        store.reject(tx.id);
        expect(issue(id)).toBeUndefined();
    });

    it("ignores rejections for transactions it does not have", () => {
        expect(store.reject(crypto.randomUUID())).toBeUndefined();
    });
});

describe("echo suppression", () => {
    it("moves a confirmed transaction from pending to confirmed without reverting later local edits", () => {
        const first = local({ title: "A" });
        local({ title: "B" });

        const delta = store.applyActions([issueUpdate(11, base.id, { title: "A" }, first.id)]);

        expect(delta.confirmed).toEqual([first.id]);
        expect(issue()?.title).toBe("B");
        expect(store.pendingCount).toBe(1);
        expect(store.confirmed(recordKey("Issue", base.id))?.data).toMatchObject({ title: "A" });
    });

    it("keeps the same model instance when its own creation comes back", () => {
        const id = crypto.randomUUID();
        const tx: PendingTransaction = { id: crypto.randomUUID(), seq: ++seq, createdAt: "2026-02-01T00:00:00.000Z", ops: [{ kind: "create", model: "Issue", id, data: { teamId: TEAM_ID, title: "New", sortOrder: 0 } }] };
        store.addLocal(tx);
        const optimistic = issue(id);

        const record = issueRecord({ id, title: "New", status: "backlog", createdAt: "2026-02-01T00:00:01.000Z" });
        store.applyActions([{ syncId: 11, model: "Issue", modelId: id, action: "insert", data: record, txId: tx.id }]);

        expect(issue(id)).toBe(optimistic);
        expect(issue(id)?.createdAt).toBe(record.createdAt);
        expect(store.pool.all("Issue").size).toBe(2);
        expect(store.pendingCount).toBe(0);
    });

    it("skips actions it has already applied", () => {
        store.applyActions([issueUpdate(11, base.id, { title: "Once" })]);
        local({ title: "Local" });
        const delta = store.applyActions([issueUpdate(11, base.id, { title: "Replayed" }), issueUpdate(9, base.id, { title: "Old" })]);

        expect(delta.upserts).toEqual([]);
        expect(store.confirmed(recordKey("Issue", base.id))?.data).toMatchObject({ title: "Once" });
        expect(issue()?.title).toBe("Local");
    });
});

describe("field-level last writer wins", () => {
    it("keeps a pending local field on top of a concurrent remote change to other fields", () => {
        const mine = local({ title: "Mine" });
        store.applyActions([issueUpdate(11, base.id, { title: "Theirs", status: "done" })]);
        expect(issue()).toMatchObject({ title: "Mine", status: "done" });

        store.applyActions([issueUpdate(12, base.id, { title: "Mine" }, mine.id)]);
        expect(issue()).toMatchObject({ title: "Mine", status: "done" });
    });

    it("lets the server's later write win once the local one is confirmed", () => {
        const mine = local({ title: "Mine" });
        store.applyActions([issueUpdate(11, base.id, { title: "Mine" }, mine.id), issueUpdate(12, base.id, { title: "Theirs" })]);
        expect(issue()?.title).toBe("Theirs");
    });

    it("drops the issue when it is deleted remotely, even with a local edit pending", () => {
        local({ title: "Editing a ghost" });
        store.applyActions([{ syncId: 11, model: "Issue", modelId: base.id, action: "delete", data: {}, txId: null }]);
        expect(issue()).toBeUndefined();
    });
});

describe("acknowledgements", () => {
    it("waits for the deltas when the ack arrives first", () => {
        const tx = local({ title: "Acked" });

        expect(store.acknowledge(tx.id, 11)).toBe(false);
        expect(store.pendingCount).toBe(1);

        const delta = store.applyActions([issueUpdate(11, base.id, { title: "Acked" }, tx.id)]);
        expect(delta.confirmed).toEqual([tx.id]);
        expect(store.pendingCount).toBe(0);
    });

    it("confirms an acked transaction whose actions came in through a bootstrap", () => {
        const tx = local({ title: "Already there" });
        store.reset(snapshot(20, [{ ...base, title: "Already there" }]));

        expect(store.acknowledge(tx.id, 15)).toBe(true);
        expect(store.pendingCount).toBe(0);
        expect(issue()?.title).toBe("Already there");
    });

    it("keeps pending transactions on top of a fresh bootstrap", () => {
        local({ priority: 1 });
        store.reset(snapshot(30, [{ ...base, title: "Renamed elsewhere" }]));
        expect(issue()).toMatchObject({ title: "Renamed elsewhere", priority: 1 });
    });

    it("removes instances that are gone after a bootstrap", () => {
        store.reset(snapshot(30, []));
        expect(issue()).toBeUndefined();
    });
});
