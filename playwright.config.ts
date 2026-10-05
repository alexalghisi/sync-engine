import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_SERVER_PORT, E2E_WEB_PORT } from "./e2e/fixtures";

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
    testDir: "e2e",
    globalSetup: "./e2e/globalSetup.ts",
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    use: {
        baseURL: `http://localhost:${E2E_WEB_PORT}`,
        trace: "retain-on-failure",
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
    },
    webServer: [
        {
            command: "tsx src/server/main.ts",
            url: `http://localhost:${E2E_SERVER_PORT}/health`,
            env: { PORT: String(E2E_SERVER_PORT), DATABASE_URL: E2E_DATABASE_URL },
            reuseExistingServer: false,
        },
        {
            command: `vite build && vite preview --port ${E2E_WEB_PORT} --strictPort`,
            url: `http://localhost:${E2E_WEB_PORT}`,
            env: { SYNC_SERVER_URL: `http://localhost:${E2E_SERVER_PORT}` },
            // The preview proxy logs every websocket the tests tear down; that is noise here.
            stderr: "ignore",
            reuseExistingServer: false,
        },
    ],
});
