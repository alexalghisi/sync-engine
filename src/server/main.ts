import { startServer } from "./app";
import { loadConfig } from "./config";

const server = await startServer(loadConfig());
console.log(`sync server listening on http://localhost:${server.port}`);

const shutdown = (): void => {
    server.close().then(
        () => process.exit(0),
        () => process.exit(1),
    );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
