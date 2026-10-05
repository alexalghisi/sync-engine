import { observer } from "mobx-react-lite";
import type { KeyboardEvent } from "react";
import type { SyncStore } from "../../client/store/SyncStore";
import type { IssueListModel } from "../IssueListModel";
import { VirtualList } from "../ui/VirtualList";
import { IssueRow } from "./IssueRow";

export const ROW_HEIGHT = 36;

interface IssueListProps {
    list: IssueListModel;
    store: SyncStore;
    selectedId: string | null;
    onSelect: (id: string) => void;
}

export const IssueList = observer(function IssueList({ list, store, selectedId, onSelect }: IssueListProps) {
    const issues = list.issues;
    const activeIndex = list.indexOf(selectedId);

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = issues[Math.min(issues.length - 1, Math.max(0, activeIndex + step))];
        if (next) onSelect(next.id);
    }

    return (
        <VirtualList
            items={issues}
            rowHeight={ROW_HEIGHT}
            getKey={(issue) => issue.id}
            activeIndex={activeIndex}
            ariaLabel="Issues"
            onKeyDown={onKeyDown}
            renderRow={(issue) => <IssueRow issue={issue} selected={issue.id === selectedId} store={store} onSelect={onSelect} />}
        />
    );
});
