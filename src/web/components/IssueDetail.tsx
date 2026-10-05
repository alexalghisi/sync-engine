import { observer } from "mobx-react-lite";
import { archiveIssue, updateIssue } from "../../client/issueActions";
import type { Issue } from "../../client/models/models";
import type { SyncClient } from "../../client/SyncClient";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../../shared/domain";
import type { IssuePriority, IssueStatus } from "../../shared/domain";
import { EditableText } from "./EditableText";
import { PRIORITY_LABELS, PriorityIcon, STATUS_LABELS, StatusIcon } from "./icons";

interface IssueDetailProps {
    client: SyncClient;
    issue: Issue | undefined;
    onClose: () => void;
}

function relativeTime(iso: string): string {
    const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
}

export const IssueDetail = observer(function IssueDetail({ client, issue, onClose }: IssueDetailProps) {
    if (!issue) {
        return (
            <aside className="detail detail-empty">
                <p>Select an issue to edit it.</p>
                <p className="hint">
                    Open this page in a second window and edit the same issue in both. Use <strong>Go offline</strong> to queue changes and watch them
                    replay.
                </p>
            </aside>
        );
    }

    const users = [...client.store.pool.all("User").values()].sort((a, b) => a.name.localeCompare(b.name));
    const pending = client.store.isPending("Issue", issue.id);

    return (
        <aside className="detail" aria-label="Issue details">
            <div className="detail-meta">
                <span className="team-key">{issue.team?.key ?? "ISSUE"}</span>
                <span className={`sync-state${pending ? " pending" : ""}`}>{pending ? "Waiting for server" : `Saved ${relativeTime(issue.updatedAt)}`}</span>
                <button type="button" className="ghost" onClick={onClose} aria-label="Close details">
                    Close
                </button>
            </div>
            <EditableText
                className="detail-title"
                label="Title"
                multiline
                rows={2}
                submitOnEnter
                value={issue.title}
                onCommit={(title) => updateIssue(client, issue, { title: title.trim() })}
            />
            <div className="detail-fields">
                <label className="field">
                    <span>Status</span>
                    <span className="select-with-icon">
                        <StatusIcon status={issue.status} />
                        <select value={issue.status} onChange={(e) => updateIssue(client, issue, { status: e.target.value as IssueStatus })}>
                            {ISSUE_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                    {STATUS_LABELS[s]}
                                </option>
                            ))}
                        </select>
                    </span>
                </label>
                <label className="field">
                    <span>Priority</span>
                    <span className="select-with-icon">
                        <PriorityIcon priority={issue.priority} />
                        <select value={issue.priority} onChange={(e) => updateIssue(client, issue, { priority: Number(e.target.value) as IssuePriority })}>
                            {ISSUE_PRIORITIES.map((p) => (
                                <option key={p} value={p}>
                                    {PRIORITY_LABELS[p]}
                                </option>
                            ))}
                        </select>
                    </span>
                </label>
                <label className="field">
                    <span>Assignee</span>
                    <select value={issue.assigneeId ?? ""} onChange={(e) => updateIssue(client, issue, { assigneeId: e.target.value || null })}>
                        <option value="">Unassigned</option>
                        {users.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.name}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <EditableText
                className="detail-description"
                label="Description"
                placeholder="Add a description…"
                multiline
                allowEmpty
                value={issue.description}
                onCommit={(description) => updateIssue(client, issue, { description })}
            />
            <div className="detail-actions">
                <button
                    type="button"
                    className="ghost danger"
                    onClick={() => {
                        archiveIssue(client, issue);
                        onClose();
                    }}
                >
                    Archive
                </button>
            </div>
        </aside>
    );
});
