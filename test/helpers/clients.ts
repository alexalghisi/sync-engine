import { when } from "mobx";
import { MemoryStorage } from "../../src/client/storage/MemoryStorage";
import { SyncClient } from "../../src/client/SyncClient";
import type { Rejection } from "../../src/client/SyncClient";
import { WebSocketTransport } from "../../src/client/transport/WebSocketTransport";
import type { SyncServer } from "../../src/server/app";
import type { IssueRecord } from "../../src/shared/domain";
import type { BootstrapPayload } from "../../src/shared/protocol";

export interface TestClient {
    client: SyncClient;
    storage: MemoryStorage;
    rejections: Rejection[];
}

export async function fetchBootstrap(server: SyncServer, workspaceId: string): Promise<BootstrapPayload> {
    const res = await fetch(`http://localhost:${server.port}/bootstrap?workspaceId=${workspaceId}`);
    if (!res.ok) throw new Error(`bootstrap failed with ${res.status}`);
    return (await res.json()) as BootstrapPayload;
}

/** A real client: real WebSocket, real server, in-memory storage that outlives the client if passed back in. */
export async function startClient(server: SyncServer, workspaceId: string, storage = new MemoryStorage()): Promise<TestClient> {
    const rejections: Rejection[] = [];
    const client = new SyncClient({
        workspaceId,
        clientId: crypto.randomUUID(),
        storage,
        transport: new WebSocketTransport(`ws://localhost:${server.port}/sync`),
        bootstrap: () => fetchBootstrap(server, workspaceId),
        reconnectDelayMs: () => 20,
        onRejection: (r) => rejections.push(r),
    });
    await client.start();
    await client.settled();
    return { client, storage, rejections };
}

export function caughtUpTo(client: SyncClient, syncId: number, timeout = 10_000): Promise<void> {
    return when(() => client.store.lastSyncId >= syncId && client.store.pendingCount === 0, { timeout });
}

/** The issues a client currently shows, as plain records sorted by id. */
export function visibleIssues(client: SyncClient): IssueRecord[] {
    return [...client.store.pool.all("Issue").values()]
        .map(({ id, teamId, title, description, status, priority, assigneeId, sortOrder, createdAt, updatedAt, archivedAt }) => ({
            id,
            teamId,
            title,
            description,
            status,
            priority,
            assigneeId,
            sortOrder,
            createdAt,
            updatedAt,
            archivedAt,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

export function serverIssues(payload: BootstrapPayload): IssueRecord[] {
    return payload.records
        .flatMap((r) => (r.model === "Issue" ? [r.data] : []))
        .sort((a, b) => a.id.localeCompare(b.id));
}
