import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function percentile(values: readonly number[], p: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round((sorted[index] ?? Number.NaN) * 10) / 10;
}

const RESULTS = fileURLToPath(new URL("./results.json", import.meta.url));

/** Merges one benchmark's results into bench/results.json, which the README numbers come from. */
export async function writeResults(name: string, results: unknown): Promise<void> {
    let all: Record<string, unknown> = {};
    try {
        all = JSON.parse(await readFile(RESULTS, "utf8")) as Record<string, unknown>;
    } catch {
        // first run
    }
    all[name] = { ...(results as Record<string, unknown>), measuredAt: new Date().toISOString().slice(0, 10) };
    await writeFile(RESULTS, JSON.stringify(all, null, 2) + "\n");
}
