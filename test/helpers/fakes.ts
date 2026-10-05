import type { Transport, TransportHandlers } from "../../src/client/transport/Transport";
import type { IssueRecord, ModelRecord } from "../../src/shared/domain";
import type { BootstrapPayload, ClientMessage, ServerMessage, SyncAction, Transaction } from "../../src/shared/protocol";

export const TEAM_ID = "0b6f7a52-8d0e-4c1b-a3f4-5e9d2c7b8a10";
export const WORKSPACE_ID = "6f1c2c1e-3a51-4b8e-9d7a-0c2f6b9e1a01";

let counter = 0;

export function issueRecord(overrides: Partial<IssueRecord> = {}): IssueRecord {
    counter++;
    return {
        id: crypto.randomUUID(),
        teamId: TEAM_ID,
        title: `Issue ${counter}`,
        description: "",
        status: "todo",
        priority: 0,
        assigneeId: null,
        sortOrder: counter,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        ...overrides,
    };
}

export function snapshot(lastSyncId: number, issues: IssueRecord[]): BootstrapPayload {
    const records: ModelRecord[] = [{ model: "Team", data: { id: TEAM_ID, key: "ENG", name: "Engineering" } }, ...issues.map((data): ModelRecord => ({ model: "Issue", data }))];
    return { lastSyncId, records };
}

export function issueUpdate(syncId: number, id: string, data: Partial<IssueRecord>, txId: string | null = null): SyncAction {
    return { syncId, model: "Issue", modelId: id, action: "update", data, txId };
}

/** A transport the test drives by hand: it records what the client sends and injects what the server says. */
export class FakeTransport implements Transport {
    readonly sent: ClientMessage[] = [];
    connects = 0;
    private handlers: TransportHandlers | null = null;

    get connected(): boolean {
        return this.handlers !== null;
    }

    connect(handlers: TransportHandlers): void {
        this.connects++;
        this.handlers = handlers;
        handlers.onOpen();
    }

    send(message: ClientMessage): void {
        if (this.handlers) this.sent.push(message);
    }

    disconnect(): void {
        const handlers = this.handlers;
        this.handlers = null;
        handlers?.onClose();
    }

    receive(message: ServerMessage): void {
        this.handlers?.onMessage(message);
    }

    /** Transactions pushed so far, in the order they were sent. */
    pushed(): Transaction[] {
        return this.sent.flatMap((m) => (m.type === "push" ? m.transactions : []));
    }

    hellos(): Extract<ClientMessage, { type: "hello" }>[] {
        return this.sent.filter((m): m is Extract<ClientMessage, { type: "hello" }> => m.type === "hello");
    }
}
