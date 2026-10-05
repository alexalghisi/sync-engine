import type { ClientMessage, ServerMessage } from "../../shared/protocol";

export interface TransportHandlers {
    onOpen(): void;
    onMessage(message: ServerMessage): void;
    /** Called once per connection, whether it failed, dropped or was closed on purpose. */
    onClose(): void;
}

/** One connection at a time to the sync endpoint. Reconnection policy lives in the client, not here. */
export interface Transport {
    connect(handlers: TransportHandlers): void;
    send(message: ClientMessage): void;
    disconnect(): void;
}
