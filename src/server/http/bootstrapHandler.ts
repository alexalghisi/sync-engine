import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Db } from "../db/pool";
import { loadBootstrap } from "../sync/bootstrap";

const workspaceParam = z.uuid();

export async function handleBootstrap(db: Db, url: URL, _req: IncomingMessage, res: ServerResponse): Promise<void> {
    const workspaceId = workspaceParam.safeParse(url.searchParams.get("workspaceId"));
    if (!workspaceId.success) return sendJson(res, 400, { error: "workspaceId must be a uuid" });
    const payload = await loadBootstrap(db, workspaceId.data);
    if (!payload) return sendJson(res, 404, { error: "unknown workspace" });
    sendJson(res, 200, payload);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(json);
}
