import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { Transport, TransportHandlers } from "./Transport";

/** Works with the WebSocket global of browsers and Node 22. */
export class WebSocketTransport implements Transport {
    private socket: WebSocket | null = null;
    private handlers: TransportHandlers | null = null;

    constructor(private readonly url: string) {}

    connect(handlers: TransportHandlers): void {
        this.disconnect();
        const socket = new WebSocket(this.url);
        this.socket = socket;
        this.handlers = handlers;
        socket.addEventListener("open", () => {
            if (this.socket === socket) handlers.onOpen();
        });
        socket.addEventListener("message", (event) => {
            if (this.socket === socket) handlers.onMessage(JSON.parse(String(event.data)) as ServerMessage);
        });
        socket.addEventListener("close", () => {
            if (this.socket === socket) this.closed();
        });
    }

    send(message: ClientMessage): void {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    }

    disconnect(): void {
        const socket = this.socket;
        if (!socket) return;
        this.closed();
        socket.close();
    }

    private closed(): void {
        const handlers = this.handlers;
        this.socket = null;
        this.handlers = null;
        handlers?.onClose();
    }
}
