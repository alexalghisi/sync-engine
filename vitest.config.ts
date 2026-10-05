import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        globalSetup: ["test/helpers/globalSetup.ts"],
        // Database tests isolate themselves with a workspace per test, but the integration
        // tests open real sockets and LISTEN connections; keep files sequential for stable timing.
        fileParallelism: false,
        testTimeout: 20_000,
    },
});
