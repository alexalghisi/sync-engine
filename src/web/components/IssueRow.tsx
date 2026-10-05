import { observer } from "mobx-react-lite";
import type { Issue } from "../../client/models/models";
import type { SyncStore } from "../../client/store/SyncStore";
import { Avatar, PriorityIcon, StatusIcon } from "./icons";

interface IssueRowProps {
    issue: Issue;
    selected: boolean;
    store: SyncStore;
    onSelect: (id: string) => void;
}

export const IssueRow = observer(function IssueRow({ issue, selected, store, onSelect }: IssueRowProps) {
    return (
        <div
            className={`issue-row${selected ? " selected" : ""}`}
            role="option"
            aria-selected={selected}
            data-issue-id={issue.id}
            onMouseDown={() => onSelect(issue.id)}
        >
            <PriorityIcon priority={issue.priority} />
            <StatusIcon status={issue.status} />
            <span className="issue-title">{issue.title}</span>
            {store.isPending("Issue", issue.id) && <span className="unsynced-dot" title="Not yet confirmed by the server" />}
            <Avatar name={issue.assignee?.name} />
        </div>
    );
});
