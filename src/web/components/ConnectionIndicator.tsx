import { observer } from "mobx-react-lite";
import type { SyncClient, SyncStatus } from "../../client/SyncClient";

const LABELS: Record<SyncStatus, string> = {
    offline: "Offline",
    connecting: "Connecting",
    syncing: "Syncing",
    online: "Online",
};

export const ConnectionIndicator = observer(function ConnectionIndicator({ client }: { client: SyncClient }) {
    const { status } = client;
    const pending = client.store.pendingCount;
    return (
        <div className="connection">
            <span className={`connection-status status-${status}`} role="status" aria-live="polite" data-status={status}>
                <span className="connection-dot" />
                {LABELS[status]}
                {pending > 0 && <span className="pending-count" data-pending={pending}>{pending} pending</span>}
            </span>
            <button type="button" className="ghost" onClick={() => (client.isOnlineWanted ? client.goOffline() : client.goOnline())}>
                {client.isOnlineWanted ? "Go offline" : "Go online"}
            </button>
        </div>
    );
});
