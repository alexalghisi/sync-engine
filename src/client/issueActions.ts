import type { IssueChanges, IssueCreateInput } from "../shared/domain";
import type { Issue } from "./models/models";
import type { SyncClient } from "./SyncClient";

export function createIssue(client: SyncClient, input: IssueCreateInput): Issue | undefined {
    const id = crypto.randomUUID();
    client.mutate([{ kind: "create", model: "Issue", id, data: input }]);
    return client.store.pool.get("Issue", id);
}

/** Sends only the fields that differ from what the client currently shows, so unrelated fields never overwrite concurrent edits. */
export function updateIssue(client: SyncClient, issue: Issue, changes: IssueChanges): void {
    const changed = Object.fromEntries(Object.entries(changes).filter(([field, value]) => issue[field as keyof IssueChanges] !== value));
    if (Object.keys(changed).length === 0) return;
    client.mutate([{ kind: "update", model: "Issue", id: issue.id, changes: changed }]);
}

export function archiveIssue(client: SyncClient, issue: Issue): void {
    client.mutate([{ kind: "archive", model: "Issue", id: issue.id }]);
}

export function deleteIssue(client: SyncClient, issue: Issue): void {
    client.mutate([{ kind: "delete", model: "Issue", id: issue.id }]);
}
