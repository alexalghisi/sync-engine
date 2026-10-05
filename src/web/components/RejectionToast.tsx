import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import type { SyncClient } from "../../client/SyncClient";

const VISIBLE_MS = 5_000;

export const RejectionToast = observer(function RejectionToast({ client }: { client: SyncClient }) {
    const rejection = client.lastRejection;
    const [dismissed, setDismissed] = useState<typeof rejection>(null);

    useEffect(() => {
        if (!rejection) return;
        const timer = setTimeout(() => setDismissed(rejection), VISIBLE_MS);
        return () => clearTimeout(timer);
    }, [rejection]);

    if (!rejection || rejection === dismissed) return null;
    return (
        <div className="toast" role="alert">
            A change was rejected by the server and has been undone: {rejection.message}
        </div>
    );
});
