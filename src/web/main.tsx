import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IndexedDbStorage } from "../client/storage/IndexedDbStorage";
import { MemoryStorage } from "../client/storage/MemoryStorage";
import type { SyncStorage } from "../client/storage/SyncStorage";
import { SyncClient } from "../client/SyncClient";
import { WebSocketTransport } from "../client/transport/WebSocketTransport";
import { DEMO_WORKSPACE_ID } from "../shared/demo";
import type { BootstrapPayload } from "../shared/protocol";
import { App } from "./App";
import "./styles.css";

const workspaceId = import.meta.env.VITE_WORKSPACE_ID ?? DEMO_WORKSPACE_ID;

/**
 * Each tab is its own client with its own local database, so two tabs behave like two
 * people. The id lives in sessionStorage: a reload keeps the tab's offline queue.
 */
function tabClientId(): string {
    const key = "sync-engine:client-id";
    try {
        const existing = sessionStorage.getItem(key);
        if (existing) return existing;
        const id = crypto.randomUUID();
        sessionStorage.setItem(key, id);
        return id;
    } catch {
        return crypto.randomUUID();
    }
}

async function openStorage(clientId: string): Promise<SyncStorage> {
    try {
        return await IndexedDbStorage.open(`sync-engine:${workspaceId}:${clientId}`);
    } catch {
        return new MemoryStorage();
    }
}

async function fetchBootstrap(): Promise<BootstrapPayload> {
    const res = await fetch(`/bootstrap?workspaceId=${workspaceId}`);
    if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
    return (await res.json()) as BootstrapPayload;
}

async function startClient(): Promise<SyncClient> {
    const clientId = tabClientId();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const client = new SyncClient({
        workspaceId,
        clientId,
        storage: await openStorage(clientId),
        transport: new WebSocketTransport(`${protocol}://${location.host}/sync`),
        bootstrap: fetchBootstrap,
    });
    await client.start();
    return client;
}

const root = createRoot(document.getElementById("root") as HTMLElement);
startClient().then(
    (client) =>
        root.render(
            <StrictMode>
                <App client={client} />
            </StrictMode>,
        ),
    (error: unknown) =>
        root.render(
            <div className="startup-error">
                <h1>Could not load the workspace</h1>
                <p>{error instanceof Error ? error.message : String(error)}</p>
                <p>Is the sync server running? Start everything with npm run dev.</p>
            </div>,
        ),
);
