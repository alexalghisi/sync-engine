import type { BootstrapPayload } from "../../shared/protocol";
import type { ConfirmedDelta } from "../store/SyncStore";
import type { PendingTransaction } from "../store/records";

export interface StoredState {
    snapshot: BootstrapPayload | null;
    transactions: PendingTransaction[];
}

/**
 * Durable client state: the confirmed records with their sync id, and the queue of
 * transactions the server has not confirmed. Implementations must apply each call
 * atomically; the client issues calls one at a time, in order.
 */
export interface SyncStorage {
    load(): Promise<StoredState>;
    replaceSnapshot(snapshot: BootstrapPayload): Promise<void>;
    /** Applies confirmed changes, advances the sync id and drops the transactions they confirm, all together. */
    commitDelta(delta: ConfirmedDelta): Promise<void>;
    putTransaction(tx: PendingTransaction): Promise<void>;
    deleteTransaction(txId: string): Promise<void>;
    close?(): void;
}
