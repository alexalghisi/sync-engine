/**
 * Records the README preview: two real browser tabs against a running server, one going
 * offline, both editing the same issue, then converging. Writes PNG frames and a manifest
 * that scripts/make-gif.py turns into docs/preview.gif.
 *
 *   npm run db:seed && npm run dev      (in another terminal)
 *   PREVIEW_URL=http://localhost:5173 tsx scripts/capture-preview.ts <out-dir>
 *   python3 scripts/make-gif.py <out-dir> docs/preview.gif
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";

const BASE_URL = process.env.PREVIEW_URL ?? "http://localhost:5173";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const OUT = process.argv[2] ?? "preview-frames";
const VIEWPORT = { width: 760, height: 520 };

interface Frame {
    a: string;
    b: string;
    caption: string;
    durationMs: number;
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROMIUM });
const open = async (): Promise<Page> => {
    const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })).newPage();
    await page.goto(BASE_URL);
    await page.waitForSelector('[data-status="online"]');
    return page;
};
const a = await open();
const b = await open();

const frames: Frame[] = [];
async function frame(caption: string, durationMs = 700): Promise<void> {
    const n = String(frames.length).padStart(3, "0");
    const [fa, fb] = [join(OUT, `${n}-a.png`), join(OUT, `${n}-b.png`)];
    await Promise.all([a.screenshot({ path: fa }), b.screenshot({ path: fb })]);
    frames.push({ a: fa, b: fb, caption, durationMs });
}

const title = (p: Page) => p.getByLabel("Title");
const select = (p: Page, label: string) => p.locator(".field", { hasText: label }).locator("select");
const settle = () => new Promise((r) => setTimeout(r, 250));

async function typeTitle(p: Page, text: string, caption: string): Promise<void> {
    await title(p).click();
    await title(p).press("ControlOrMeta+a");
    await title(p).press("Backspace");
    for (let i = 0; i < text.length; i += 4) {
        await title(p).pressSequentially(text.slice(i, i + 4));
        await frame(caption, 120);
    }
    await title(p).press("Enter");
    await settle();
}

let caption = "Two tabs, two independent clients, 10,000 issues";
await frame(caption, 1600);

for (let i = 0; i < 6; i++) {
    const { row, mounted } = await a.evaluate((top) => {
        const viewport = document.querySelector(".virtual-viewport");
        if (viewport) viewport.scrollTop = top;
        return { row: Math.floor((viewport?.scrollTop ?? 0) / 36), mounted: document.querySelectorAll(".issue-row").length };
    }, (i + 1) * 60_000);
    await settle();
    await frame(`Virtualized list: row ${row.toLocaleString("en-US")} of 10,000, ${mounted} rows in the DOM`, 450);
}
await a.evaluate(() => document.querySelector(".virtual-viewport")?.scrollTo({ top: 0 }));
await a.locator(".issue-row").first().click();
await b.locator(".issue-row").first().click();
await settle();
caption = "Both tabs open the same issue";
await frame(caption, 1400);

caption = "Tab A changes status and priority: tab B updates within milliseconds";
await select(a, "Status").selectOption("in_progress");
await settle();
await frame(caption, 1300);
await select(a, "Priority").selectOption("2");
await settle();
await frame(caption, 1300);

caption = "Tab B goes offline";
await b.getByRole("button", { name: "Go offline" }).click();
await settle();
await frame(caption, 1400);

caption = "Offline edits apply instantly and are queued";
await typeTitle(b, "Replay queued transactions after reconnect", caption);
await frame(caption, 900);
await select(b, "Assignee").selectOption({ label: "Ioana Rus" });
await settle();
await frame("Offline edits apply instantly and are queued: 2 pending", 1800);

caption = "Meanwhile tab A edits the same issue";
await typeTitle(a, "Edited online in tab A", caption);
await select(a, "Status").selectOption("done");
await settle();
await frame(caption, 1800);

caption = "Tab B reconnects: catch-up, then its queue replays";
await b.getByRole("button", { name: "Go online" }).click();
await b.waitForSelector('[data-status="online"]');
await settle();
await frame(caption, 1200);
await frame("Converged: field-level last writer wins in server order", 3200);

await writeFile(join(OUT, "manifest.json"), JSON.stringify(frames, null, 2));
await browser.close();
console.log(`wrote ${frames.length} frames to ${OUT}`);
