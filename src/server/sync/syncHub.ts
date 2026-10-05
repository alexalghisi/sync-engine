import type pg from "pg";
import type { SyncAction } from "../../shared/protocol";
import type { Db } from "../db/pool";
import { createClient } from "../db/pool";
import type { SyncNotification } from "./syncLog";
import { readActionRange, SYNC_CHANNEL } from "./syncLog";

export interface SyncSubscriber {
    deliver(actions: SyncAction[]): void;
    /** Notifications may have been lost; catch up from the log instead of trusting the stream. */
    resync(): void;
}

export interface Logger {
    error(message: string, error?: unknown): void;
}

const RECONNECT_DELAY_MS = 1_000;

/**
 * Fans committed sync actions out to the sessions of this process. Each server process
 * LISTENs on the same channel, so a write handled by any process reaches clients
 * connected to all of them. The NOTIFY only carries a sync id range; actions are read
 * back from the log, which keeps payloads small and the log the single source of truth.
 */
export class SyncHub {
    private listener: pg.Client | null = null;
    private readonly subscribers = new Map<string, Set<SyncSubscriber>>();
    // Ranges are fetched one at a time so deliveries keep commit order.
    private fetches: Promise<void> = Promise.resolve();
    private stopped = false;

    constructor(
        private readonly db: Db,
        private readonly connectionString: string,
        private readonly logger: Logger = console,
    ) {}

    async start(): Promise<void> {
        await this.listen();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        const listener = this.listener;
        this.listener = null;
        await listener?.end();
        await this.fetches;
    }

    subscribe(workspaceId: string, subscriber: SyncSubscriber): () => void {
        let set = this.subscribers.get(workspaceId);
        if (!set) this.subscribers.set(workspaceId, (set = new Set()));
        set.add(subscriber);
        return () => {
            set.delete(subscriber);
            if (set.size === 0) this.subscribers.delete(workspaceId);
        };
    }

    private async listen(): Promise<void> {
        const client = createClient(this.connectionString);
        client.on("notification", (message) => this.onNotification(message.payload));
        client.on("error", (error) => this.onListenerLost(client, error));
        client.on("end", () => this.onListenerLost(client));
        await client.connect();
        await client.query(`listen ${SYNC_CHANNEL}`);
        this.listener = client;
    }

    private onNotification(payload: string | undefined): void {
        if (!payload) return;
        const { workspaceId, from, to } = JSON.parse(payload) as SyncNotification;
        if (!this.subscribers.has(workspaceId)) return;

        this.fetches = this.fetches
            .then(async () => {
                const actions = await readActionRange(this.db, workspaceId, from, to);
                for (const subscriber of this.subscribers.get(workspaceId) ?? []) subscriber.deliver(actions);
            })
            .catch((error: unknown) => {
                this.logger.error(`failed to fan out sync actions ${from}..${to}`, error);
                for (const subscriber of this.subscribers.get(workspaceId) ?? []) subscriber.resync();
            });
    }

    private onListenerLost(client: pg.Client, error?: unknown): void {
        if (this.stopped || this.listener !== client) return;
        this.listener = null;
        if (error) this.logger.error("sync listener connection lost", error);
        client.end().catch(() => undefined);
        setTimeout(() => void this.reconnect(), RECONNECT_DELAY_MS);
    }

    private async reconnect(): Promise<void> {
        if (this.stopped) return;
        try {
            await this.listen();
        } catch (error) {
            this.logger.error("sync listener reconnect failed", error);
            setTimeout(() => void this.reconnect(), RECONNECT_DELAY_MS);
            return;
        }
        // Anything committed while we were not listening was never delivered.
        for (const set of this.subscribers.values()) for (const subscriber of set) subscriber.resync();
    }
}
