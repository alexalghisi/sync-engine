import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SyncServer } from "../../src/server/app";
import { compactLog, readLogBounds } from "../../src/server/sync/syncLog";
import type { BootstrapPayload, SyncAction } from "../../src/shared/protocol";
import { createWorkspace, issueIds, testPool } from "../helpers/db";
import { ProtocolSocket, startTestServer } from "../helpers/server";
import { tx, update } from "../helpers/transactions";

const db = testPool();
let a: SyncServer;
let b: SyncServer;
const sockets: ProtocolSocket[] = [];

beforeAll(async () => {
    // Two servers sharing one database, standing in for two processes behind a load balancer.
    [a, b] = await Promise.all([startTestServer(), startTestServer()]);
});

afterAll(async () => {
    for (const s of sockets) s.close();
    await Promise.all([a.close(), b.close()]);
    await db.end();
});

let workspaceId: string;
let issueId: string;
let lastSyncId: number;

beforeEach(async () => {
    ({ workspaceId } = await createWorkspace(db, 2));
    issueId = (await issueIds(db, workspaceId))[0] ?? "";
    lastSyncId = (await readLogBounds(db, workspaceId)).current;
});

async function connect(server: SyncServer, from = lastSyncId): Promise<ProtocolSocket> {
    const socket = await ProtocolSocket.open(server.port);
    sockets.push(socket);
    socket.send({ type: "hello", workspaceId, clientId: randomUUID(), lastSyncId: from });
    return socket;
}

async function graphql(server: SyncServer, query: string, variables: Record<string, unknown> = {}): Promise<{ data?: Record<string, unknown>; errors?: { message: string; extensions?: { code?: string } }[] }> {
    const res = await fetch(`http://localhost:${server.port}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-id": workspaceId },
        body: JSON.stringify({ query, variables }),
    });
    return (await res.json()) as Awaited<ReturnType<typeof graphql>>;
}

function titles(actions: SyncAction[]): unknown[] {
    return actions.map((x) => ("title" in x.data ? x.data.title : undefined));
}

describe("sync server", () => {
    it("serves a bootstrap that a socket can resume from", async () => {
        const res = await fetch(`http://localhost:${a.port}/bootstrap?workspaceId=${workspaceId}`);
        const payload = (await res.json()) as BootstrapPayload;
        expect(payload.lastSyncId).toBe(lastSyncId);
        expect(payload.records).toHaveLength(1 + 2 + 2);

        const socket = await connect(a, payload.lastSyncId);
        expect(await socket.next("ready")).toEqual({ type: "ready", lastSyncId });
        expect(socket.received).toEqual([]);
    });

    it("rejects bootstrap requests for unknown or malformed workspaces", async () => {
        expect((await fetch(`http://localhost:${a.port}/bootstrap?workspaceId=${randomUUID()}`)).status).toBe(404);
        expect((await fetch(`http://localhost:${a.port}/bootstrap?workspaceId=nope`)).status).toBe(400);
    });

    it("replays missed actions on hello, then streams live ones", async () => {
        await a.mutations.apply(workspaceId, tx(update(issueId, { title: "missed 1" })));
        await a.mutations.apply(workspaceId, tx(update(issueId, { title: "missed 2" })));

        const socket = await connect(a);
        expect(titles((await socket.next("deltas")).actions)).toEqual(["missed 1", "missed 2"]);
        await socket.next("ready");

        await a.mutations.apply(workspaceId, tx(update(issueId, { title: "live" })));
        expect(titles((await socket.next("deltas")).actions)).toEqual(["live"]);
    });

    it("acks pushed transactions and echoes them to every client, across server processes", async () => {
        const writer = await connect(a);
        const reader = await connect(b);
        await Promise.all([writer.next("ready"), reader.next("ready")]);

        const t = tx(update(issueId, { status: "in_progress" }));
        writer.send({ type: "push", transactions: [t] });

        const ack = await writer.next("ack");
        const [own, other] = await Promise.all([writer.next("deltas"), reader.next("deltas")]);
        expect(ack).toMatchObject({ txId: t.id });
        expect(own.actions).toEqual(other.actions);
        expect(other.actions[0]).toMatchObject({ syncId: ack.syncId, txId: t.id, data: { status: "in_progress" } });
    });

    it("rejects invalid and failing transactions individually, keeping the rest", async () => {
        const socket = await connect(a);
        await socket.next("ready");
        const good = tx(update(issueId, { title: "kept" }));
        const missing = tx(update(randomUUID(), { title: "x" }));
        const invalidId = randomUUID();

        socket.send({ type: "push", transactions: [{ id: invalidId, ops: [{ kind: "update", model: "Issue", id: issueId, changes: { priority: 9 } }] }, missing, good] });

        expect(await socket.next("reject", (m) => m.txId === invalidId)).toMatchObject({ code: "invalid" });
        expect(await socket.next("reject", (m) => m.txId === missing.id)).toMatchObject({ code: "not_found" });
        expect(await socket.next("ack", (m) => m.txId === good.id)).toBeTruthy();
    });

    it("refuses pushes before hello and malformed frames", async () => {
        const socket = await ProtocolSocket.open(a.port);
        sockets.push(socket);
        socket.send({ type: "push", transactions: [tx(update(issueId, { title: "x" }))] });
        expect(await socket.next("error")).toMatchObject({ message: "send hello first" });
        socket.send({ type: "nonsense" });
        expect(await socket.next("error")).toMatchObject({ message: "malformed message" });
    });

    it("tells a client behind the compaction point to bootstrap", async () => {
        const first = await a.mutations.apply(workspaceId, tx(update(issueId, { title: "one" })));
        await compactLog(db, workspaceId, first.ok ? first.syncId : 0);

        const socket = await connect(a);
        expect(await socket.next("bootstrap_required")).toEqual({ type: "bootstrap_required" });
    });

    it("routes GraphQL mutations through the same log", async () => {
        const socket = await connect(b);
        await socket.next("ready");

        const result = await graphql(a, `mutation($id: ID!) { issueUpdate(id: $id, input: { title: "via graphql", priority: 2 }) { lastSyncId issue { title priority } } }`, { id: issueId });
        const delta = await socket.next("deltas");

        expect(result.data?.issueUpdate).toEqual({ lastSyncId: delta.actions[0]?.syncId, issue: { title: "via graphql", priority: 2 } });
        expect(delta.actions[0]?.txId).toEqual(expect.any(String));
    });

    it("maps service rejections to GraphQL error codes", async () => {
        const invalid = await graphql(a, `mutation($id: ID!) { issueUpdate(id: $id, input: { priority: 7 }) { lastSyncId } }`, { id: issueId });
        const missing = await graphql(a, `mutation($id: ID!) { issueArchive(id: $id) { lastSyncId } }`, { id: randomUUID() });
        expect(invalid.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
        expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    });

    it("creates and queries issues over GraphQL", async () => {
        const teamId = (await db.query<{ id: string }>("select id from teams where workspace_id = $1", [workspaceId])).rows[0]?.id;
        const created = await graphql(a, `mutation($teamId: ID!) { issueCreate(input: { teamId: $teamId, title: "From GraphQL", sortOrder: -1 }) { issue { id status } } }`, { teamId });
        const list = await graphql(a, `{ issues { title } lastSyncId }`);

        expect(created.data?.issueCreate).toMatchObject({ issue: { status: "backlog" } });
        expect(list.data?.issues).toContainEqual({ title: "From GraphQL" });
        expect(list.data?.lastSyncId).toBeGreaterThan(lastSyncId);
    });
});
