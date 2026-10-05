/**
 * Loads the production build in headless Chromium against a real server with 10,000
 * issues and measures load time, DOM size and scroll frame times.
 *
 *   npm run bench:web      (CHROMIUM_PATH overrides the browser binary)
 */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { build, preview } from "vite";
import { startServer } from "../src/server/app";
import { migrate } from "../src/server/db/migrate";
import { createPool, ensureDatabase } from "../src/server/db/pool";
import { seedWorkspace } from "../src/server/db/seed";
import { percentile, writeResults } from "./stats";

const DATABASE_URL = process.env.BENCH_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/syncengine_test";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const ISSUES = 10_000;

await ensureDatabase(DATABASE_URL);
const db = createPool(DATABASE_URL, 4);
await migrate(db);
const { workspaceId } = await seedWorkspace(db, { workspaceId: randomUUID(), teamId: randomUUID(), issues: ISSUES });
const server = await startServer({ databaseUrl: DATABASE_URL, port: 0, maxCatchUpActions: 50_000 });

process.env.SYNC_SERVER_URL = `http://localhost:${server.port}`;
await build({ logLevel: "warn" });
const web = await preview({ preview: { port: 4190, strictPort: false }, logLevel: "warn" });
const baseUrl = web.resolvedUrls?.local[0] ?? "http://localhost:4190/";

const browser = await chromium.launch({ executablePath: CHROMIUM });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
    // Records when the first issue row is painted, measured from navigation start.
    const observer = new MutationObserver(() => {
        if (document.querySelector(".issue-row")) {
            observer.disconnect();
            requestAnimationFrame(() => ((window as unknown as { firstRowAt: number }).firstRowAt = performance.now()));
        }
    });
    observer.observe(document, { childList: true, subtree: true });
});
const page = await context.newPage();

async function firstRowAt(p: Page): Promise<number> {
    await p.waitForFunction(() => typeof (window as unknown as { firstRowAt?: number }).firstRowAt === "number", undefined, { timeout: 60_000 });
    return Math.round(await p.evaluate(() => (window as unknown as { firstRowAt: number }).firstRowAt));
}

async function domStats(p: Page): Promise<{ rows: number; nodes: number }> {
    return p.evaluate(() => ({ rows: document.querySelectorAll(".issue-row").length, nodes: document.querySelectorAll("*").length }));
}

async function scrollTo(p: Page, fraction: number): Promise<void> {
    await p.evaluate((f) => {
        const viewport = document.querySelector(".virtual-viewport") as HTMLElement;
        viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * f;
    }, fraction);
    await p.waitForTimeout(100);
}

const url = `${baseUrl}?workspace=${workspaceId}`;
await page.goto(url);
const coldLoadMs = await firstRowAt(page);
// Let the snapshot reach IndexedDB, then reload: the second load starts from local data.
await page.waitForFunction(() => document.querySelector("[data-status]")?.getAttribute("data-status") === "online");
await page.waitForTimeout(3_000);
await page.reload();
const warmLoadMs = await firstRowAt(page);

const dom: Record<string, { rows: number; nodes: number }> = {};
for (const [name, fraction] of [["top", 0], ["middle", 0.5], ["bottom", 1]] as const) {
    await scrollTo(page, fraction);
    dom[name] = await domStats(page);
}
await scrollTo(page, 0);

// Scroll 900px per frame for 200 frames and record the time between frames. Passed as a
// string because tsx would wrap the inner function in a helper the page doesn't have.
const SCROLL_PROBE = `new Promise((resolve) => {
    const viewport = document.querySelector(".virtual-viewport");
    const deltas = [];
    let last = performance.now();
    let count = 0;
    const step = (now) => {
        deltas.push(now - last);
        last = now;
        viewport.scrollTop += 900;
        if (++count < 200) requestAnimationFrame(step);
        else resolve(deltas.slice(1));
    };
    requestAnimationFrame(step);
})`;
const frames = await page.evaluate<number[]>(SCROLL_PROBE);

const results = {
    issues: ISSUES,
    viewport: "1440x900",
    coldLoadMs,
    warmLoadMs,
    dom,
    scroll: { frames: frames.length, p50Ms: percentile(frames, 50), p95Ms: percentile(frames, 95), maxMs: percentile(frames, 100) },
};
console.log(JSON.stringify(results, null, 2));
await writeResults("web", results);

await context.close();
await browser.close();
await new Promise<void>((resolve) => web.httpServer.close(() => resolve()));
await server.close();
await db.query("delete from workspaces where id = $1", [workspaceId]);
await db.end();
