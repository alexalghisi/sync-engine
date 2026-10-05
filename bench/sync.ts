/**
 * Measures the sync path end to end against a real Postgres: bootstrap, catch-up after
 * an offline period, fan-out latency between two server processes, and write throughput.
 *
 *   npm run bench
 */
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { reaction } from "mobx";
import { updateIssue } from "../src/client/issueActions";
import { MemoryStorage } from "../src/client/storage/MemoryStorage";
import { SyncClient } from "../src/client/SyncClient";
import { WebSocketTransport } from "../src/client/transport/WebSocketTransport";
import type { SyncServer } from "../src/server/app";
import { startServer } from "../src/server/app";
import { migrate } from "../src/server/db/migrate";
import { createPool, ensureDatabase } from "../src/server/db/pool";
import { seedWorkspace } from "../src/server/db/seed";
import type { BootstrapPayload, Transaction } from "../src/shared/protocol";
import { percentile, writeResults } from "./stats";

const DATABASE_URL = process.env.BENCH_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/syncengine_test";
const ISSUES = 10_000;

await ensureDatabase(DATABASE_URL);
const db = createPool(DATABASE_URL, 20);
await migrate(db);

const config = { databaseUrl: DATABASE_URL, port: 0, maxCatchUpActions: 50_000 };
const quiet = { error: (message: string, error?: unknown) => console.error(message, error) };
const [serverA, serverB] = await Promise.all([startServer(config, quiet), startServer(config, quiet)]);
const { workspaceId } = await seedWorkspace(db, { workspaceId: randomUUID(), teamId: randomUUID(), issues: ISSUES });
const issueIds = (await db.query<{ id: string }>("select id from issues where workspace_id = $1 order by sort_order", [workspaceId])).rows.map((r) => r.id);

async function fetchBootstrap(server: SyncServer): Promise<BootstrapPayload> {
    const res = await fetch(`http://localhost:${server.port}/bootstrap?workspaceId=${workspaceId}`);
    return (await res.json()) as BootstrapPayload;
}

async function startClient(server: SyncServer, storage = new MemoryStorage()): Promise<SyncClient> {
    const client = new SyncClient({
        workspaceId,
        clientId: randomUUID(),
        storage,
        transport: new WebSocketTransport(`ws://localhost:${server.port}/sync`),
        bootstrap: () => fetchBootstrap(server),
        reconnectDelayMs: () => 10,
    });
    await client.start();
    await client.settled(60_000);
    return client;
}

function issueAt(i: number): string {
    return issueIds[i % issueIds.length] ?? "";
}

function updateTx(i: number): Transaction {
    return { id: randomUUID(), ops: [{ kind: "update", model: "Issue", id: issueAt(i), changes: { title: `bench ${i}` } }] };
}

/** Writes `count` one-operation transactions with `concurrency` writers; returns transactions per second. */
async function writeMany(count: number, concurrency: number): Promise<number> {
    let next = 0;
    const started = performance.now();
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (next < count) {
                const result = await serverA.mutations.apply(workspaceId, updateTx(next++));
                if (!result.ok) throw new Error(result.message);
            }
        }),
    );
    return count / ((performance.now() - started) / 1000);
}

const results: Record<string, unknown> = { machine: `${cpus()[0]?.model ?? "unknown"} x${cpus().length}`, issues: ISSUES };

// Bootstrap: the HTTP round trip (query, serialise, transfer, parse), then hydrating the pool.
{
    const fetches: number[] = [];
    const hydrations: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const res = await fetch(`http://localhost:${serverA.port}/bootstrap?workspaceId=${workspaceId}`);
        const text = await res.text();
        const payload = JSON.parse(text) as BootstrapPayload;
        const fetched = performance.now();
        bytes = text.length;
        const client = new SyncClient({
            workspaceId,
            clientId: "bench",
            storage: new MemoryStorage(),
            transport: new WebSocketTransport("ws://unused"),
            bootstrap: async () => payload,
            autoConnect: false,
        });
        await client.start();
        fetches.push(fetched - started);
        hydrations.push(performance.now() - fetched);
    }
    results.bootstrap = { fetchMedianMs: percentile(fetches, 50), hydrateMedianMs: percentile(hydrations, 50), payloadKb: Math.round(bytes / 1024) };
}

// Write throughput through the mutation service (one workspace, so writes serialise on its lock).
results.writes = {
    sequentialTxPerSec: Math.round(await writeMany(1_000, 1)),
    concurrent16TxPerSec: Math.round(await writeMany(2_000, 16)),
};

// Fan-out: a client on server A edits, a client on server B observes the change.
{
    const writer = await startClient(serverA);
    const reader = await startClient(serverB);
    const latencies: number[] = [];
    for (let i = 0; i < 200; i++) {
        const id = issueAt(i);
        const issue = writer.store.pool.get("Issue", id);
        if (!issue) throw new Error("missing issue");
        const title = `fan-out ${i}`;
        const seen = new Promise<void>((resolve) => {
            const dispose = reaction(
                () => reader.store.pool.get("Issue", id)?.title,
                (value) => {
                    if (value === title) {
                        dispose();
                        resolve();
                    }
                },
            );
        });
        const started = performance.now();
        updateIssue(writer, issue, { title });
        await seen;
        latencies.push(performance.now() - started);
    }
    results.fanOut = { samples: latencies.length, p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95), p99Ms: percentile(latencies, 99) };
    await Promise.all([writer.stop(), reader.stop()]);
}

// Catch-up: a client goes offline, N actions happen, it reconnects. Median of three runs.
{
    const catchUp: Record<string, unknown>[] = [];
    for (const missed of [100, 1_000, 10_000]) {
        const runs: number[] = [];
        for (let run = 0; run < 3; run++) {
            const client = await startClient(serverB);
            client.goOffline();
            await writeMany(missed, 8);
            const { rows } = await db.query<{ max: number }>("select max(sync_id)::int8 as max from sync_actions where workspace_id = $1", [workspaceId]);
            const target = rows[0]?.max ?? 0;

            const started = performance.now();
            client.goOnline();
            await new Promise<void>((resolve) => {
                const dispose = reaction(
                    () => client.store.lastSyncId >= target,
                    (done) => {
                        if (done) {
                            dispose();
                            resolve();
                        }
                    },
                );
            });
            runs.push(performance.now() - started);
            await client.stop();
        }
        const ms = percentile(runs, 50);
        catchUp.push({ missedActions: missed, medianMs: ms, actionsPerSec: Math.round(missed / (ms / 1000)) });
    }
    results.catchUp = catchUp;
}

await Promise.all([serverA.close(), serverB.close()]);
await db.query("delete from workspaces where id = $1", [workspaceId]);
await db.end();

console.log(JSON.stringify(results, null, 2));
await writeResults("sync", results);
