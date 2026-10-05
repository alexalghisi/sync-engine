import type { SyncServer } from "../../src/server/app";
import { startServer } from "../../src/server/app";
import type { Logger } from "../../src/server/sync/syncHub";
import type { ClientMessage, ServerMessage } from "../../src/shared/protocol";
import { TEST_DATABASE_URL } from "./db";

export const quietLogger: Logger = { error: () => undefined };

export function startTestServer(maxCatchUpActions = 10_000): Promise<SyncServer> {
    return startServer({ databaseUrl: TEST_DATABASE_URL, port: 0, maxCatchUpActions }, quietLogger);
}

/** A bare protocol client: raw messages in, typed waits out. */
export class ProtocolSocket {
    readonly received: ServerMessage[] = [];
    private waiters: (() => void)[] = [];

    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            this.received.push(JSON.parse(String(event.data)) as ServerMessage);
            for (const wake of this.waiters.splice(0)) wake();
        });
    }

    static async open(port: number): Promise<ProtocolSocket> {
        const socket = new WebSocket(`ws://localhost:${port}/sync`);
        await new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", reject, { once: true });
        });
        return new ProtocolSocket(socket);
    }

    send(message: ClientMessage | Record<string, unknown>): void {
        this.socket.send(JSON.stringify(message));
    }

    /** Resolves with the first not-yet-consumed message matching `predicate`. */
    async next<T extends ServerMessage["type"]>(
        type: T,
        predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
        timeoutMs = 5_000,
    ): Promise<Extract<ServerMessage, { type: T }>> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const index = this.received.findIndex((m) => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>));
            if (index >= 0) return this.received.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error(`timed out waiting for ${type}; received ${JSON.stringify(this.received)}`);
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, remaining);
                this.waiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
    }

    close(): void {
        this.socket.close();
    }
}
