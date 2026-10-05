import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { archiveIssue, createIssue, deleteIssue, updateIssue } from "../../src/client/issueActions";
import { ISSUE_STATUSES } from "../../src/shared/domain";
import type { Issue } from "../../src/client/models/models";
import type { SyncClient } from "../../src/client/SyncClient";
import type { SyncServer } from "../../src/server/app";
import { readLogBounds } from "../../src/server/sync/syncLog";
import type { TestClient } from "../helpers/clients";
import { caughtUpTo, fetchBootstrap, serverIssues, startClient, visibleIssues } from "../helpers/clients";
import { createWorkspace, testPool } from "../helpers/db";
import { startTestServer } from "../helpers/server";

const db = testPool();
let serverA: SyncServer;
let serverB: SyncServer;
let workspaceId: string;
let teamId: string;
const running: SyncClient[] = [];

beforeAll(async () => {
    [serverA, serverB] = await Promise.all([startTestServer(), startTestServer()]);
});

afterAll(async () => {
    await Promise.all([serverA.close(), serverB.close()]);
    await db.end();
});

beforeEach(async () => {
    ({ workspaceId, teamId } = await createWorkspace(db, 6));
});

afterEach(async () => {
    await Promise.all(running.splice(0).map((c) => c.stop()));
});

async function connect(server: SyncServer, storage?: TestClient["storage"]): Promise<TestClient> {
    const tc = await startClient(server, workspaceId, storage);
    running.push(tc.client);
    return tc;
}

function issues(client: SyncClient): Issue[] {
    return [...client.store.pool.all("Issue").values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

function at(list: Issue[], index: number): Issue {
    const issue = list[index];
    if (!issue) throw new Error(`no issue at ${index}`);
    return issue;
}

/** Waits until every client has applied everything the server has, then returns the server's state. */
async function converge(...clients: SyncClient[]) {
    // First let every client get its own writes accepted, then read the server's position.
    await Promise.all(clients.map((c) => c.settled()));
    const { current } = await readLogBounds(db, workspaceId);
    await Promise.all(clients.map((c) => caughtUpTo(c, current)));
    return serverIssues(await fetchBootstrap(serverA, workspaceId));
}

describe("two clients on two server processes", () => {
    it("see each other's edits live", async () => {
        const { client: one } = await connect(serverA);
        const { client: two } = await connect(serverB);

        updateIssue(one, at(issues(one), 0), { title: "Live from one" });
        const expected = await converge(one, two);

        expect(at(issues(two), 0).title).toBe("Live from one");
        expect(visibleIssues(two)).toEqual(expected);
    });

    it("converge after one goes offline and both edit, including conflicts and a rejection", async () => {
        const { client: online } = await connect(serverA);
        const { client: offline, rejections } = await connect(serverB);
        const [i0, i1, i2, i3] = [0, 1, 2, 3].map((n) => at(issues(offline), n).id);

        offline.goOffline();
        const local = (id: string | undefined) => {
            const issue = offline.store.pool.get("Issue", id ?? "");
            if (!issue) throw new Error("missing issue");
            return issue;
        };
        updateIssue(offline, local(i0), { title: "Offline title" });
        // Pick values that differ from the seed, since an update that changes nothing is never sent.
        const priority = local(i1).priority === 1 ? 2 : 1;
        const status = local(i1).status === "in_progress" ? "done" : "in_progress";
        updateIssue(offline, local(i1), { priority });
        archiveIssue(offline, local(i2));
        updateIssue(offline, local(i3), { status: local(i3).status === "todo" ? "backlog" : "todo" });
        const created = createIssue(offline, { teamId, title: "Created offline", sortOrder: -1 });
        expect(offline.status).toBe("offline");
        expect(offline.store.pendingCount).toBe(5);

        const remote = (id: string | undefined) => {
            const issue = online.store.pool.get("Issue", id ?? "");
            if (!issue) throw new Error("missing issue");
            return issue;
        };
        updateIssue(online, remote(i0), { title: "Online title" });
        updateIssue(online, remote(i1), { status });
        deleteIssue(online, remote(i3));
        await online.settled();

        offline.goOnline();
        const expected = await converge(online, offline);

        expect(visibleIssues(online)).toEqual(expected);
        expect(visibleIssues(offline)).toEqual(expected);

        const byId = new Map(expected.map((i) => [i.id, i]));
        // Same field: the offline write reached the server last, so it wins.
        expect(byId.get(i0 ?? "")?.title).toBe("Offline title");
        // Different fields of the same issue: both survive.
        expect(byId.get(i1 ?? "")).toMatchObject({ priority, status });
        expect(byId.get(i2 ?? "")?.archivedAt).not.toBeNull();
        expect(byId.has(i3 ?? "")).toBe(false);
        expect(byId.get(created?.id ?? "")?.title).toBe("Created offline");
        // Editing an issue someone else deleted is refused and rolled back.
        expect(rejections.map((r) => r.code)).toEqual(["not_found"]);
    });

    it("converge when the offline client restarts before reconnecting", async () => {
        const { client: online } = await connect(serverA);
        const { client: first, storage } = await connect(serverB);
        const target = at(issues(first), 0).id;

        first.goOffline();
        const issue = first.store.pool.get("Issue", target);
        if (!issue) throw new Error("missing issue");
        updateIssue(first, issue, { title: "Survived a restart", priority: 3 });
        await first.stop();
        running.splice(running.indexOf(first), 1);

        const other = online.store.pool.get("Issue", target);
        if (!other) throw new Error("missing issue");
        updateIssue(online, other, { status: "canceled" });
        await online.settled();

        const { client: second } = await connect(serverB, storage);
        const expected = await converge(online, second);

        expect(visibleIssues(second)).toEqual(expected);
        expect(visibleIssues(online)).toEqual(expected);
        expect(expected.find((i) => i.id === target)).toMatchObject({ title: "Survived a restart", priority: 3, status: "canceled" });
    });

    it("catch up on hundreds of missed actions in order", async () => {
        const { client: writer } = await connect(serverA);
        const { client: reader } = await connect(serverB);
        reader.goOffline();

        const list = issues(writer);
        for (let i = 0; i < 300; i++) updateIssue(writer, at(list, i % list.length), { title: `rev ${i}` });
        await writer.settled();

        reader.goOnline();
        const expected = await converge(writer, reader);
        expect(visibleIssues(reader)).toEqual(expected);
        expect(expected.map((i) => i.title)).toContain("rev 299");
    });

    it("converge after a randomised mix of edits, deletes and connectivity changes", async () => {
        const clients = [(await connect(serverA)).client, (await connect(serverB)).client, (await connect(serverA)).client];
        let state = 42;
        const random = (n: number): number => {
            // Deterministic LCG so a failure can be replayed.
            state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
            return state % n;
        };

        for (let step = 0; step < 300; step++) {
            const client = clients[random(clients.length)];
            if (!client) continue;
            const list = issues(client);
            const target = list.length ? at(list, random(list.length)) : undefined;
            const roll = random(100);
            if (roll < 8) {
                if (client.isOnlineWanted) client.goOffline();
                else client.goOnline();
            } else if (roll < 14 || !target) {
                createIssue(client, { teamId, title: `created ${step}`, sortOrder: step });
            } else if (roll < 17) {
                deleteIssue(client, target);
            } else if (roll < 20) {
                archiveIssue(client, target);
            } else if (roll < 60) {
                updateIssue(client, target, { title: `step ${step}` });
            } else {
                const status = ISSUE_STATUSES[random(ISSUE_STATUSES.length)] ?? "todo";
                updateIssue(client, target, { status, priority: random(5) as 0 | 1 | 2 | 3 | 4 });
            }
            if (step % 25 === 0) await new Promise((r) => setTimeout(r, 5));
        }

        for (const client of clients) client.goOnline();
        const expected = await converge(...clients);
        for (const client of clients) expect(visibleIssues(client)).toEqual(expected);
    });
});
