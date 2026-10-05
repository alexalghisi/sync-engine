import { action, computed, makeObservable, observable, observableRef, runInAction, when } from "mobx";
import type { Operation, RejectionCode, ServerMessage, SyncAction, Transaction } from "../shared/protocol";
import { MAX_TRANSACTIONS_PER_PUSH, transactionSchema } from "../shared/protocol";
import type { BootstrapPayload } from "../shared/protocol";
import { SerialQueue } from "./SerialQueue";
import type { SyncStorage } from "./storage/SyncStorage";
import type { PendingTransaction } from "./store/records";
import { SyncStore } from "./store/SyncStore";
import type { Transport } from "./transport/Transport";

export type ConnectionState = "offline" | "connecting" | "catching_up" | "live";
export type SyncStatus = "offline" | "connecting" | "syncing" | "online";

export interface Rejection {
    tx: PendingTransaction;
    code: RejectionCode;
    message: string;
}

export interface SyncClientOptions {
    workspaceId: string;
    clientId: string;
    storage: SyncStorage;
    transport: Transport;
    bootstrap: () => Promise<BootstrapPayload>;
    autoConnect?: boolean;
    reconnectDelayMs?: (attempt: number) => number;
    onRejection?: (rejection: Rejection) => void;
    onError?: (error: unknown) => void;
    now?: () => Date;
}

const defaultReconnectDelay = (attempt: number): number => Math.min(30_000, 250 * 2 ** attempt) * (0.75 + Math.random() * 0.5);

/**
 * Owns the connection lifecycle around a SyncStore: restore from storage (or bootstrap),
 * say hello with the last sync id, apply the catch-up, then send queued transactions and
 * keep streaming. Every change to the store is mirrored to storage in the same order.
 */
export class SyncClient {
    readonly store = new SyncStore();
    connection: ConnectionState = "offline";
    lastRejection: Rejection | null = null;

    private wantOnline = false;
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private seq = 0;
    private readonly inFlight = new Set<string>();
    private readonly persistence: SerialQueue;
    private readonly options: Required<Pick<SyncClientOptions, "reconnectDelayMs" | "onError" | "now">> & SyncClientOptions;

    constructor(options: SyncClientOptions) {
        this.options = { reconnectDelayMs: defaultReconnectDelay, onError: (e) => console.error(e), now: () => new Date(), ...options };
        this.persistence = new SerialQueue(this.options.onError);
        makeObservable<SyncClient, "handleMessage" | "handleClose" | "wantOnline">(this, {
            connection: observable,
            wantOnline: observable,
            isOnlineWanted: computed,
            goOnline: action,
            goOffline: action,
            lastRejection: observableRef,
            status: computed,
            mutate: action,
            handleMessage: action,
            handleClose: action,
        });
    }

    get status(): SyncStatus {
        switch (this.connection) {
            case "offline":
                return "offline";
            case "connecting":
                return "connecting";
            case "catching_up":
                return "syncing";
            case "live":
                return this.store.pendingCount > 0 ? "syncing" : "online";
        }
    }

    get isOnlineWanted(): boolean {
        return this.wantOnline;
    }

    async start(): Promise<void> {
        const stored = await this.options.storage.load();
        this.seq = stored.transactions.reduce((max, tx) => Math.max(max, tx.seq), 0);
        if (stored.snapshot) {
            this.store.reset(stored.snapshot, stored.transactions);
        } else {
            const payload = await this.options.bootstrap();
            this.store.reset(payload, stored.transactions);
            await this.persist(() => this.options.storage.replaceSnapshot(payload));
        }
        if (this.options.autoConnect ?? true) this.goOnline();
    }

    /** Applies `ops` optimistically and queues them as one transaction. Throws if they are invalid. */
    mutate(ops: Operation[]): PendingTransaction {
        const parsed: Transaction = transactionSchema.parse({ id: crypto.randomUUID(), ops });
        const tx: PendingTransaction = { ...parsed, seq: ++this.seq, createdAt: this.options.now().toISOString() };
        this.store.addLocal(tx);
        void this.persist(() => this.options.storage.putTransaction(tx));
        if (this.connection === "live") this.send([tx]);
        return tx;
    }

    goOnline(): void {
        this.wantOnline = true;
        if (this.connection === "offline" && !this.reconnectTimer) this.connect();
    }

    goOffline(): void {
        this.wantOnline = false;
        this.clearReconnect();
        this.options.transport.disconnect();
    }

    async stop(): Promise<void> {
        this.goOffline();
        await this.persistence.idle();
        this.options.storage.close?.();
    }

    /** Resolves when connected, caught up, with nothing pending and everything persisted. */
    async settled(timeoutMs = 10_000): Promise<void> {
        await when(() => this.connection === "live" && this.store.pendingCount === 0, { timeout: timeoutMs });
        await this.persistence.idle();
    }

    /** Resolves once storage has caught up with every change made so far. */
    flushed(): Promise<void> {
        return this.persistence.idle();
    }

    private connect(): void {
        runInAction(() => (this.connection = "connecting"));
        this.options.transport.connect({
            onOpen: () => this.handleOpen(),
            onMessage: (message) => this.handleMessage(message),
            onClose: () => this.handleClose(),
        });
    }

    private handleOpen(): void {
        runInAction(() => (this.connection = "catching_up"));
        this.hello();
    }

    private hello(): void {
        const { workspaceId, clientId } = this.options;
        this.options.transport.send({ type: "hello", workspaceId, clientId, lastSyncId: this.store.lastSyncId });
    }

    private handleMessage(message: ServerMessage): void {
        switch (message.type) {
            case "deltas":
                this.applyDeltas(message.actions);
                return;
            case "ready":
                this.connection = "live";
                this.attempt = 0;
                this.send(this.store.pendingTransactions().filter((tx) => !this.inFlight.has(tx.id)));
                return;
            case "ack":
                this.inFlight.delete(message.txId);
                if (this.store.acknowledge(message.txId, message.syncId)) {
                    void this.persist(() => this.options.storage.deleteTransaction(message.txId));
                }
                return;
            case "reject": {
                this.inFlight.delete(message.txId);
                const tx = this.store.reject(message.txId);
                if (!tx) return;
                void this.persist(() => this.options.storage.deleteTransaction(tx.id));
                this.lastRejection = { tx, code: message.code, message: message.message };
                this.options.onRejection?.(this.lastRejection);
                return;
            }
            case "bootstrap_required":
                void this.rebootstrap();
                return;
            case "error":
                this.options.onError(new Error(`sync server: ${message.message}`));
                return;
        }
    }

    private applyDeltas(actions: SyncAction[]): void {
        const delta = this.store.applyActions(actions);
        for (const id of delta.confirmed) this.inFlight.delete(id);
        if (delta.upserts.length || delta.deletes.length || delta.confirmed.length) {
            void this.persist(() => this.options.storage.commitDelta(delta));
        }
    }

    private async rebootstrap(): Promise<void> {
        try {
            const payload = await this.options.bootstrap();
            this.store.reset(payload);
            void this.persist(() => this.options.storage.replaceSnapshot(payload));
            this.hello();
        } catch (error) {
            this.options.onError(error);
            this.options.transport.disconnect();
        }
    }

    private handleClose(): void {
        this.connection = "offline";
        this.inFlight.clear();
        if (this.wantOnline) this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        this.clearReconnect();
        const delay = this.options.reconnectDelayMs(this.attempt++);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.wantOnline) this.connect();
        }, delay);
    }

    private clearReconnect(): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private send(transactions: readonly PendingTransaction[]): void {
        for (let i = 0; i < transactions.length; i += MAX_TRANSACTIONS_PER_PUSH) {
            const batch = transactions.slice(i, i + MAX_TRANSACTIONS_PER_PUSH);
            for (const tx of batch) this.inFlight.add(tx.id);
            this.options.transport.send({ type: "push", transactions: batch.map(({ id, ops }) => ({ id, ops })) });
        }
    }

    private persist(task: () => Promise<void>): Promise<void> {
        return this.persistence.push(task);
    }
}
