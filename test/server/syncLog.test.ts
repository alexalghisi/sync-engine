import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadBootstrap } from "../../src/server/sync/bootstrap";
import { MutationService } from "../../src/server/sync/mutationService";
import { compactLog, planCatchUp, readLogBounds } from "../../src/server/sync/syncLog";
import type { IssueRecord } from "../../src/shared/domain";
import { createWorkspace, issueIds, testPool } from "../helpers/db";
import { tx, update } from "../helpers/transactions";

const db = testPool();
const service = new MutationService(db);
afterAll(() => db.end());

let workspaceId: string;
let issueId: string;

beforeEach(async () => {
    ({ workspaceId } = await createWorkspace(db, 2));
    issueId = (await issueIds(db, workspaceId))[0] ?? "";
});

async function write(title: string): Promise<number> {
    const result = await service.apply(workspaceId, tx(update(issueId, { title })));
    if (!result.ok) throw new Error(result.message);
    return result.syncId;
}

describe("bootstrap", () => {
    it("returns the full state and the sync id it reflects", async () => {
        const syncId = await write("Bootstrapped");
        const payload = await loadBootstrap(db, workspaceId);

        expect(payload?.lastSyncId).toBe(syncId);
        expect(payload?.records.filter((r) => r.model === "Issue")).toHaveLength(2);
        expect(payload?.records.filter((r) => r.model === "Team")).toHaveLength(1);
        const issue = payload?.records.find((r) => r.model === "Issue" && r.data.id === issueId)?.data as IssueRecord | undefined;
        expect(issue?.title).toBe("Bootstrapped");
    });

    it("returns null for an unknown workspace", async () => {
        expect(await loadBootstrap(db, crypto.randomUUID())).toBeNull();
    });
});

describe("planCatchUp", () => {
    it("returns exactly the actions after the client's sync id, in order", async () => {
        const { current } = await readLogBounds(db, workspaceId);
        const first = await write("one");
        await write("two");
        const third = await write("three");

        const fromStart = await planCatchUp(db, workspaceId, current, 100);
        expect(fromStart.kind === "deltas" && fromStart.actions.map((a) => a.data)).toMatchObject([
            { title: "one" },
            { title: "two" },
            { title: "three" },
        ]);

        const fromFirst = await planCatchUp(db, workspaceId, first, 100);
        expect(fromFirst.kind === "deltas" && fromFirst.actions.length).toBe(2);

        expect(await planCatchUp(db, workspaceId, third, 100)).toEqual({ kind: "deltas", actions: [] });
    });

    it("asks the client to bootstrap when it is too far behind", async () => {
        const { current } = await readLogBounds(db, workspaceId);
        for (let i = 0; i < 4; i++) await write(`w${i}`);
        expect(await planCatchUp(db, workspaceId, current, 3)).toEqual({ kind: "bootstrap_required" });
        expect((await planCatchUp(db, workspaceId, current, 4)).kind).toBe("deltas");
    });

    it("asks the client to bootstrap when the log it needs was compacted", async () => {
        const { current } = await readLogBounds(db, workspaceId);
        const first = await write("one");
        const second = await write("two");
        await write("three");

        expect(await compactLog(db, workspaceId, second)).toBe(2);

        expect(await planCatchUp(db, workspaceId, current, 100)).toEqual({ kind: "bootstrap_required" });
        expect(await planCatchUp(db, workspaceId, first, 100)).toEqual({ kind: "bootstrap_required" });
        const fromSecond = await planCatchUp(db, workspaceId, second, 100);
        expect(fromSecond.kind === "deltas" && fromSecond.actions.map((a) => a.data)).toMatchObject([{ title: "three" }]);
    });

    it("asks the client to bootstrap when its sync id is ahead of the server", async () => {
        const { current } = await readLogBounds(db, workspaceId);
        expect(await planCatchUp(db, workspaceId, current + 1_000, 100)).toEqual({ kind: "bootstrap_required" });
    });

    it("bootstraps a compacted workspace at a sync id clients can resume from", async () => {
        const second = (await write("one"), await write("two"));
        await compactLog(db, workspaceId, second);
        const payload = await loadBootstrap(db, workspaceId);
        expect(payload?.lastSyncId).toBe(second);
        expect(await planCatchUp(db, workspaceId, payload?.lastSyncId ?? -1, 100)).toEqual({ kind: "deltas", actions: [] });
    });
});
