import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.SYNC_SERVER_URL ?? "http://localhost:4000";

const proxy = {
    "/graphql": api,
    "/bootstrap": api,
    "/sync": { target: api.replace(/^http/, "ws"), ws: true },
};

export default defineConfig({
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
});
