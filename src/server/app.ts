import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createYoga } from "graphql-yoga";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { ServerConfig } from "./config";
import type { Db } from "./db/pool";
import { createPool } from "./db/pool";
import type { GraphQLContext } from "./graphql/schema";
import { createGraphQLSchema } from "./graphql/schema";
import { handleBootstrap, sendJson } from "./http/bootstrapHandler";
import { MutationService } from "./sync/mutationService";
import type { Logger } from "./sync/syncHub";
import { SyncHub } from "./sync/syncHub";
import { SyncSession } from "./sync/syncSession";

export interface SyncServer {
    readonly port: number;
    readonly db: Db;
    readonly mutations: MutationService;
    close(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;

export async function startServer(config: ServerConfig, logger: Logger = console): Promise<SyncServer> {
    const db = createPool(config.databaseUrl);
    const mutations = new MutationService(db);
    const hub = new SyncHub(db, config.databaseUrl, logger);
    await hub.start();

    const yoga = createYoga<object, GraphQLContext>({
        schema: createGraphQLSchema(db, mutations),
        graphqlEndpoint: "/graphql",
        context: ({ request }) => ({ workspaceId: request.headers.get("x-workspace-id") }),
        logging: false,
    });

    const http = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/graphql") return void yoga(req, res);
        if (url.pathname === "/bootstrap" && req.method === "GET") {
            return void handleBootstrap(db, url, req, res).catch((error: unknown) => {
                logger.error("bootstrap failed", error);
                sendJson(res, 500, { error: "internal error" });
            });
        }
        if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
        sendJson(res, 404, { error: "not found" });
    });

    const wss = new WebSocketServer({ server: http, path: "/sync", maxPayload: 4 * 1024 * 1024 });
    wss.on("error", (error) => logger.error("websocket server error", error));
    const alive = new WeakSet<WebSocket>();
    wss.on("connection", (socket) => {
        alive.add(socket);
        socket.on("pong", () => alive.add(socket));
        const session = new SyncSession(
            { db, hub, mutations, maxCatchUpActions: config.maxCatchUpActions, logger },
            {
                send: (message) => {
                    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
                },
                close: () => socket.close(1011, "internal error"),
            },
        );
        socket.on("message", (data) => session.receive(data.toString()));
        socket.on("close", () => session.close());
    });

    // Half-open TCP connections never fire "close"; ping them and drop the ones that stay silent.
    const heartbeat = setInterval(() => {
        for (const socket of wss.clients) {
            if (!alive.has(socket)) {
                socket.terminate();
                continue;
            }
            alive.delete(socket);
            socket.ping();
        }
    }, HEARTBEAT_MS);

    await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(config.port, () => {
            http.off("error", reject);
            resolve();
        });
    });
    const { port } = http.address() as AddressInfo;

    return {
        port,
        db,
        mutations,
        async close() {
            clearInterval(heartbeat);
            for (const socket of wss.clients) socket.terminate();
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await new Promise<void>((resolve) => http.close(() => resolve()));
            await hub.stop();
            await db.end();
        },
    };
}
