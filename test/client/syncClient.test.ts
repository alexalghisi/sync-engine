import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateIssue } from "../../src/client/issueActions";
import { MemoryStorage } from "../../src/client/storage/MemoryStorage";
import { SyncClient } from "../../src/client/SyncClient";
import type { SyncClientOptions } from "../../src/client/SyncClient";
import type { IssueRecord } from "../../src/shared/domain";
import type { BootstrapPayload } from "../../src/shared/protocol";
import { FakeTransport, issueRecord, issueUpdate, snapshot, WORKSPACE_ID } from "../helpers/fakes";

let storage: MemoryStorage;
let transport: FakeTransport;
let base: IssueRecord;
let bootstrap: ReturnType<typeof vi.fn<() => Promise<BootstrapPayload>>>;

function makeClient(options: Partial<SyncClientOptions> = {}): SyncClient {
    return new SyncClient({
        workspaceId: WORKSPACE_ID,
        clientId: "test",
        storage,
        transport,
        bootstrap,
        reconnectDelayMs: () => 0,
        onError: () => undefined,
        ...options,
    });
}

function issueOf(client: SyncClient) {
    const issue = client.store.pool.get("Issue", base.id);
    if (!issue) throw new Error("issue missing from pool");
    return issue;
}

beforeEach(() => {
    storage = new MemoryStorage();
    transport = new FakeTransport();
    base = issueRecord({ title: "Original" });
    bootstrap = vi.fn(async () => snapshot(10, [base]));
});

describe("SyncClient startup", () => {
    it("bootstraps an empty store, persists it, and resumes from storage next time", async () => {
        const first = makeClient();
        await first.start();
        await first.stop();
        expect(transport.hellos()[0]).toMatchObject({ lastSyncId: 10 });

        const second = makeClient();
        await second.start();

        expect(bootstrap).toHaveBeenCalledTimes(1);
        expect(issueOf(second).title).toBe("Original");
        expect(transport.hellos()[1]).toMatchObject({ lastSyncId: 10, workspaceId: WORKSPACE_ID });
    });

    it("reports offline, connecting, syncing and online", async () => {
        const client = makeClient({ autoConnect: false });
        await client.start();
        expect(client.status).toBe("offline");

        client.goOnline();
        expect(client.status).toBe("syncing");
        transport.receive({ type: "ready", lastSyncId: 10 });
        expect(client.status).toBe("online");

        updateIssue(client, issueOf(client), { title: "Pending" });
        expect(client.status).toBe("syncing");
    });
});

describe("offline queue", () => {
    it("persists transactions made offline and replays them in order after a restart", async () => {
        const offline = makeClient({ autoConnect: false });
        await offline.start();
        updateIssue(offline, issueOf(offline), { title: "one" });
        updateIssue(offline, issueOf(offline), { priority: 2 });
        updateIssue(offline, issueOf(offline), { title: "three" });
        await offline.stop();
        const queued = (await storage.load()).transactions;
        expect(queued.map((tx) => tx.seq)).toEqual([1, 2, 3]);
        expect(transport.sent).toEqual([]);

        const restarted = makeClient();
        await restarted.start();
        expect(issueOf(restarted)).toMatchObject({ title: "three", priority: 2 });
        expect(transport.pushed()).toEqual([]);

        transport.receive({ type: "ready", lastSyncId: 10 });
        expect(transport.pushed().map((tx) => tx.id)).toEqual(queued.map((tx) => tx.id));

        // Later local transactions get sequence numbers after the restored ones.
        updateIssue(restarted, issueOf(restarted), { title: "four" });
        expect(restarted.store.pendingTransactions().map((tx) => tx.seq)).toEqual([1, 2, 3, 4]);
    });

    it("applies the catch-up before sending queued transactions", async () => {
        const client = makeClient({ autoConnect: false });
        await client.start();
        updateIssue(client, issueOf(client), { title: "Mine" });

        client.goOnline();
        transport.receive({ type: "deltas", actions: [issueUpdate(11, base.id, { title: "Theirs", status: "done" })] });
        expect(transport.pushed()).toEqual([]);
        transport.receive({ type: "ready", lastSyncId: 11 });

        expect(transport.pushed()).toHaveLength(1);
        expect(issueOf(client)).toMatchObject({ title: "Mine", status: "done" });
    });

    it("resends unconfirmed transactions after a dropped connection, exactly once per connection", async () => {
        const client = makeClient();
        await client.start();
        transport.receive({ type: "ready", lastSyncId: 10 });
        updateIssue(client, issueOf(client), { title: "In flight" });
        expect(transport.pushed()).toHaveLength(1);

        transport.disconnect();
        await vi.waitFor(() => expect(transport.connects).toBe(2));
        transport.receive({ type: "ready", lastSyncId: 10 });
        transport.receive({ type: "ready", lastSyncId: 10 });

        const [first, second] = transport.pushed();
        expect(transport.pushed()).toHaveLength(2);
        expect(second?.id).toBe(first?.id);
    });

    it("drops a transaction from storage together with the delta that confirms it", async () => {
        const client = makeClient();
        await client.start();
        transport.receive({ type: "ready", lastSyncId: 10 });
        updateIssue(client, issueOf(client), { title: "Confirmed" });
        const [tx] = transport.pushed();

        transport.receive({ type: "ack", txId: tx?.id ?? "", syncId: 11 });
        expect(client.store.pendingCount).toBe(1);
        transport.receive({ type: "deltas", actions: [issueUpdate(11, base.id, { title: "Confirmed" }, tx?.id)] });
        await client.flushed();

        const stored = await storage.load();
        expect(stored.transactions).toEqual([]);
        expect(stored.snapshot?.lastSyncId).toBe(11);
        expect(stored.snapshot?.records.find((r) => r.data.id === base.id)?.data).toMatchObject({ title: "Confirmed" });
        expect(client.status).toBe("online");
    });
});

describe("server responses", () => {
    it("rolls back and forgets a rejected transaction", async () => {
        const onRejection = vi.fn();
        const client = makeClient({ onRejection });
        await client.start();
        transport.receive({ type: "ready", lastSyncId: 10 });
        updateIssue(client, issueOf(client), { title: "Nope" });
        const [tx] = transport.pushed();

        transport.receive({ type: "reject", txId: tx?.id ?? "", code: "not_found", message: "unknown issue" });
        await client.flushed();

        expect(issueOf(client).title).toBe("Original");
        expect(onRejection).toHaveBeenCalledWith(expect.objectContaining({ code: "not_found" }));
        expect(client.lastRejection?.tx.id).toBe(tx?.id);
        expect((await storage.load()).transactions).toEqual([]);
    });

    it("re-bootstraps when told to, keeping local transactions", async () => {
        const client = makeClient();
        await client.start();
        updateIssue(client, issueOf(client), { priority: 4 });
        bootstrap.mockResolvedValueOnce(snapshot(500, [{ ...base, title: "Compacted" }]));

        transport.receive({ type: "bootstrap_required" });
        await vi.waitFor(() => expect(transport.hellos()).toHaveLength(2));

        expect(transport.hellos()[1]).toMatchObject({ lastSyncId: 500 });
        expect(issueOf(client)).toMatchObject({ title: "Compacted", priority: 4 });
        await client.flushed();
        expect((await storage.load()).snapshot?.lastSyncId).toBe(500);
    });

    it("refuses invalid mutations before they reach the queue", async () => {
        const client = makeClient();
        await client.start();
        expect(() => updateIssue(client, issueOf(client), { title: "   " })).toThrow();
        expect(client.store.pendingCount).toBe(0);
    });

    it("sends nothing for an update that changes nothing", async () => {
        const client = makeClient();
        await client.start();
        updateIssue(client, issueOf(client), { title: "Original" });
        expect(client.store.pendingCount).toBe(0);
    });
});
