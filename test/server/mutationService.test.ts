import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "../../src/server/db/pool";
import { findIssue } from "../../src/server/issues/issueRepository";
import { MutationService } from "../../src/server/sync/mutationService";
import { readActionsAfter, readLogBounds, SYNC_CHANNEL } from "../../src/server/sync/syncLog";
import type { SyncNotification } from "../../src/server/sync/syncLog";
import { createWorkspace, issueIds, TEST_DATABASE_URL, testPool } from "../helpers/db";
import { create, tx, update } from "../helpers/transactions";

const db = testPool();
const service = new MutationService(db);
afterAll(() => db.end());

let workspaceId: string;
let teamId: string;
let userIds: string[];
let issues: string[];
let baseline: number;

beforeEach(async () => {
    ({ workspaceId, teamId, userIds } = await createWorkspace(db));
    issues = await issueIds(db, workspaceId);
    baseline = (await readLogBounds(db, workspaceId)).current;
});

function first<T>(items: readonly T[]): T {
    const item = items[0];
    if (item === undefined) throw new Error("expected at least one item");
    return item;
}

async function logCount(): Promise<number> {
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from sync_actions where workspace_id = $1", [workspaceId]);
    return rows[0]?.n ?? 0;
}

describe("MutationService", () => {
    it("writes the change and its sync action in one transaction", async () => {
        const id = first(issues);
        const t = tx(update(id, { title: "Renamed", priority: 1 }));

        const result = await service.apply(workspaceId, t);

        expect(result.ok).toBe(true);
        const issue = await findIssue(db, workspaceId, id);
        expect(issue).toMatchObject({ title: "Renamed", priority: 1 });

        const actions = await readActionsAfter(db, workspaceId, baseline, 10);
        expect(actions).toHaveLength(1);
        expect(first(actions)).toMatchObject({
            model: "Issue",
            modelId: id,
            action: "update",
            txId: t.id,
            data: { title: "Renamed", priority: 1, updatedAt: issue?.updatedAt },
        });
        expect(result.ok && result.syncId).toBe(first(actions).syncId);
    });

    it("gives the operations of one transaction consecutive, ordered sync ids", async () => {
        const id = randomUUID();
        const result = await service.apply(workspaceId, tx(create(teamId, "New", id), update(id, { status: "todo" })));

        const actions = await readActionsAfter(db, workspaceId, baseline, 10);
        expect(actions.map((a) => a.action)).toEqual(["insert", "update"]);
        expect(actions[1]?.syncId).toBe((actions[0]?.syncId ?? 0) + 1);
        expect(result).toMatchObject({ ok: true, syncId: actions[1]?.syncId });
        expect(first(actions).data).toMatchObject({ id, teamId, title: "New", status: "backlog", archivedAt: null });
    });

    it("rolls back every operation and the log when one operation fails", async () => {
        const [a] = issues;
        const created = randomUUID();
        const result = await service.apply(
            workspaceId,
            tx(update(a ?? "", { title: "Should not stick" }), create(teamId, "Nor this", created), update(randomUUID(), { title: "x" })),
        );

        expect(result).toMatchObject({ ok: false, code: "not_found" });
        expect((await findIssue(db, workspaceId, a ?? ""))?.title).not.toBe("Should not stick");
        expect(await findIssue(db, workspaceId, created)).toBeNull();
        expect(await logCount()).toBe(0);
    });

    it.each([
        ["an unknown issue", () => tx(update(randomUUID(), { title: "x" })), "not_found"],
        ["an unknown team", () => tx(create(randomUUID(), "x")), "not_found"],
        ["an existing id", () => tx(create(teamId, "x", first(issues))), "conflict"],
        ["an assignee from another workspace", () => tx(update(first(issues), { assigneeId: randomUUID() })), "invalid"],
    ])("rejects a transaction that references %s", async (_label, build, code) => {
        expect(await service.apply(workspaceId, build())).toMatchObject({ ok: false, code });
        expect(await logCount()).toBe(0);
    });

    it("cannot touch issues of another workspace", async () => {
        const other = await createWorkspace(db);
        const foreign = first(await issueIds(db, other.workspaceId));
        expect(await service.apply(workspaceId, tx(update(foreign, { title: "hijack" })))).toMatchObject({ ok: false, code: "not_found" });
    });

    it("accepts an assignee from the same workspace", async () => {
        const result = await service.apply(workspaceId, tx(update(first(issues), { assigneeId: first(userIds) })));
        expect(result.ok).toBe(true);
    });

    it("applies a resent transaction only once and returns the original sync id", async () => {
        const t = tx(update(first(issues), { title: "Once" }));
        const original = await service.apply(workspaceId, t);
        const resent = await service.apply(workspaceId, t);

        expect(resent).toEqual({ ok: true, syncId: original.ok ? original.syncId : -1, actions: [], duplicate: true });
        expect(await logCount()).toBe(1);
    });

    it("archives without losing the original archive time, and deletes", async () => {
        const [a, b] = issues;
        await service.apply(workspaceId, tx({ kind: "archive", model: "Issue", id: a ?? "" }));
        const archivedAt = (await findIssue(db, workspaceId, a ?? ""))?.archivedAt;
        await service.apply(workspaceId, tx({ kind: "archive", model: "Issue", id: a ?? "" }));
        await service.apply(workspaceId, tx({ kind: "delete", model: "Issue", id: b ?? "" }));

        expect(archivedAt).not.toBeNull();
        expect((await findIssue(db, workspaceId, a ?? ""))?.archivedAt).toBe(archivedAt);
        expect(await findIssue(db, workspaceId, b ?? "")).toBeNull();
        const actions = await readActionsAfter(db, workspaceId, baseline, 10);
        expect(actions.map((x) => x.action)).toEqual(["archive", "archive", "delete"]);
    });

    it("keeps concurrent edits to different fields of the same issue", async () => {
        const id = first(issues);
        await Promise.all([
            service.apply(workspaceId, tx(update(id, { title: "From A" }))),
            service.apply(workspaceId, tx(update(id, { status: "done" }))),
        ]);
        expect(await findIssue(db, workspaceId, id)).toMatchObject({ title: "From A", status: "done" });
    });

    it("orders concurrent writers so the row always equals the last action in the log", async () => {
        const id = first(issues);
        const writes = Array.from({ length: 40 }, (_, i) => service.apply(workspaceId, tx(update(id, { title: `write ${i}` }))));
        const results = await Promise.all(writes);

        const actions = await readActionsAfter(db, workspaceId, baseline, 100);
        const syncIds = actions.map((a) => a.syncId);
        expect(syncIds).toEqual([...syncIds].sort((x, y) => x - y));
        expect(new Set(results.map((r) => r.ok && r.syncId)).size).toBe(40);

        const winner = actions.at(-1)?.data;
        expect((await findIssue(db, workspaceId, id))?.title).toBe(winner && "title" in winner ? winner.title : undefined);
    });

    it("notifies listeners only after commit, with the appended sync id range", async () => {
        const listener = createClient(TEST_DATABASE_URL);
        await listener.connect();
        const received: SyncNotification[] = [];
        listener.on("notification", (n) => {
            const payload = JSON.parse(n.payload ?? "null") as SyncNotification;
            if (payload.workspaceId === workspaceId) received.push(payload);
        });
        await listener.query(`listen ${SYNC_CHANNEL}`);

        await service.apply(workspaceId, tx(update(randomUUID(), { title: "fails" })));
        const ok = await service.apply(workspaceId, tx(create(teamId, "a"), create(teamId, "b")));
        await new Promise((r) => setTimeout(r, 100));
        await listener.end();

        const syncId = ok.ok ? ok.syncId : -1;
        expect(received).toEqual([{ workspaceId, from: syncId - 1, to: syncId }]);
    });
});
