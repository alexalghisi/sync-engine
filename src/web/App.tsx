import { observer } from "mobx-react-lite";
import { useState } from "react";
import { createIssue } from "../client/issueActions";
import type { SyncClient } from "../client/SyncClient";
import { ConnectionIndicator } from "./components/ConnectionIndicator";
import { IssueDetail } from "./components/IssueDetail";
import { IssueList } from "./components/IssueList";
import { RejectionToast } from "./components/RejectionToast";
import { IssueListModel } from "./IssueListModel";

export const App = observer(function App({ client }: { client: SyncClient }) {
    const [list] = useState(() => new IssueListModel(client.store.pool));
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selected = selectedId ? client.store.pool.get("Issue", selectedId) : undefined;
    const team = [...client.store.pool.all("Team").values()][0];

    function newIssue() {
        if (!team) return;
        const issue = createIssue(client, { teamId: team.id, title: "New issue", sortOrder: list.nextTopSortOrder });
        if (issue) setSelectedId(issue.id);
    }

    return (
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true" />
                    <span>{team?.name ?? "Workspace"}</span>
                    <span className="count">{list.issues.length.toLocaleString()} issues</span>
                </div>
                <ConnectionIndicator client={client} />
                <button type="button" className="primary" onClick={newIssue} disabled={!team}>
                    New issue
                </button>
            </header>
            <main className="split">
                <section className="list-pane">
                    <IssueList list={list} store={client.store} selectedId={selectedId} onSelect={setSelectedId} />
                </section>
                <IssueDetail client={client} issue={selected} onClose={() => setSelectedId(null)} />
            </main>
            <RejectionToast client={client} />
        </div>
    );
});
