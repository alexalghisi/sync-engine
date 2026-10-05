import type { IssuePriority, IssueStatus } from "../../shared/domain";

export const STATUS_LABELS: Record<IssueStatus, string> = {
    backlog: "Backlog",
    todo: "Todo",
    in_progress: "In Progress",
    done: "Done",
    canceled: "Canceled",
};

export const PRIORITY_LABELS: Record<IssuePriority, string> = {
    0: "No priority",
    1: "Urgent",
    2: "High",
    3: "Medium",
    4: "Low",
};

export function StatusIcon({ status }: { status: IssueStatus }) {
    const common = { width: 14, height: 14, viewBox: "0 0 14 14", className: `status-icon status-${status}`, "aria-label": STATUS_LABELS[status], role: "img" };
    switch (status) {
        case "backlog":
            return (
                <svg {...common}>
                    <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
                </svg>
            );
        case "todo":
            return (
                <svg {...common}>
                    <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
            );
        case "in_progress":
            return (
                <svg {...common}>
                    <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" />
                </svg>
            );
        case "done":
            return (
                <svg {...common}>
                    <circle cx="7" cy="7" r="6.25" fill="currentColor" />
                    <path d="M4.4 7.2 6.2 9 9.7 5.3" fill="none" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            );
        case "canceled":
            return (
                <svg {...common}>
                    <circle cx="7" cy="7" r="6.25" fill="currentColor" />
                    <path d="M5 5l4 4M9 5l-4 4" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            );
    }
}

export function PriorityIcon({ priority }: { priority: IssuePriority }) {
    const label = PRIORITY_LABELS[priority];
    if (priority === 0) {
        return (
            <svg width="14" height="14" viewBox="0 0 14 14" className="priority-icon" role="img" aria-label={label}>
                {[2, 6, 10].map((x) => (
                    <rect key={x} x={x - 1} y="6.25" width="2.5" height="1.5" rx="0.5" fill="currentColor" opacity="0.6" />
                ))}
            </svg>
        );
    }
    if (priority === 1) {
        return (
            <svg width="14" height="14" viewBox="0 0 14 14" className="priority-icon priority-urgent" role="img" aria-label={label}>
                <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
                <path d="M7 3.8v4" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="7" cy="10.2" r="0.95" fill="var(--bg)" />
            </svg>
        );
    }
    const filled = 5 - priority; // high = 3 bars, medium = 2, low = 1
    return (
        <svg width="14" height="14" viewBox="0 0 14 14" className="priority-icon" role="img" aria-label={label}>
            {[0, 1, 2].map((bar) => (
                <rect key={bar} x={1.5 + bar * 4} y={9 - bar * 3.5} width="3" height={3.5 + bar * 3.5} rx="0.75" fill="currentColor" opacity={bar < filled ? 1 : 0.3} />
            ))}
        </svg>
    );
}

export function Avatar({ name }: { name: string | undefined }) {
    if (!name) return <span className="avatar avatar-empty" aria-label="Unassigned" />;
    const initials = name
        .split(/\s+/)
        .map((part) => part[0] ?? "")
        .join("")
        .slice(0, 2);
    let hue = 0;
    for (const char of name) hue = (hue * 31 + char.charCodeAt(0)) % 360;
    return (
        <span className="avatar" style={{ background: `hsl(${hue} 45% 42%)` }} title={name}>
            {initials}
        </span>
    );
}
