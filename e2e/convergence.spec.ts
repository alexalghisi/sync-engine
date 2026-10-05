import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { E2E_WORKSPACE_ID } from "./fixtures";

/** A separate browser context is a separate tab-client with its own IndexedDB, like a second person. */
async function openTab(browser: Browser, row: number): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`/?workspace=${E2E_WORKSPACE_ID}`);
    await expect(page.getByRole("status")).toHaveAttribute("data-status", "online");
    await page.locator(".issue-row").nth(row).click();
    return page;
}

async function setTitle(page: Page, title: string): Promise<void> {
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Title").press("Enter");
}

const status = (page: Page) => page.getByRole("status");
const detailSelect = (page: Page, label: string) => page.locator(".field", { hasText: label }).locator("select");

test("edits in one tab show up in the other", async ({ browser }) => {
    const [a, b] = [await openTab(browser, 0), await openTab(browser, 0)];

    await detailSelect(a, "Status").selectOption("canceled");
    await setTitle(a, "Renamed in tab A");

    await expect(b.getByLabel("Title")).toHaveValue("Renamed in tab A");
    await expect(detailSelect(b, "Status")).toHaveValue("canceled");
    await expect(b.locator(".issue-row").first()).toContainText("Renamed in tab A");
});

test("an offline tab queues edits and converges when it reconnects", async ({ browser }) => {
    const [a, b] = [await openTab(browser, 1), await openTab(browser, 1)];

    await b.getByRole("button", { name: "Go offline" }).click();
    await expect(status(b)).toHaveAttribute("data-status", "offline");
    await setTitle(b, "Written offline");
    await detailSelect(b, "Assignee").selectOption({ index: 2 });
    await expect(status(b)).toContainText("2 pending");

    await setTitle(a, "Written online");
    await detailSelect(a, "Status").selectOption("done");
    await expect(b.getByLabel("Title")).toHaveValue("Written offline");

    await b.getByRole("button", { name: "Go online" }).click();
    await expect(status(b)).toHaveAttribute("data-status", "online");

    for (const page of [a, b]) {
        await expect(page.getByLabel("Title")).toHaveValue("Written offline");
        await expect(detailSelect(page, "Status")).toHaveValue("done");
    }
    await expect(detailSelect(a, "Assignee")).toHaveValue(await detailSelect(b, "Assignee").inputValue());
});

test("queued edits survive a reload and are sent afterwards", async ({ browser }) => {
    const [a, b] = [await openTab(browser, 2), await openTab(browser, 2)];

    await b.getByRole("button", { name: "Go offline" }).click();
    await setTitle(b, "Survives a reload");
    await expect(status(b)).toContainText("1 pending");
    // Give the transaction a moment to reach IndexedDB before the page goes away.
    await b.waitForTimeout(200);
    await b.reload();

    await expect(status(b)).toHaveAttribute("data-status", "online");
    await expect(a.getByLabel("Title")).toHaveValue("Survives a reload");
});
