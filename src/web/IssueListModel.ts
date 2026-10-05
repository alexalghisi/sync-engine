import { computed, makeObservable } from "mobx";
import type { Issue } from "../client/models/models";
import type { ObjectPool } from "../client/models/ObjectPool";

function byOrder(a: Issue, b: Issue): number {
    return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1);
}

/**
 * The list's view of the pool. The sort only depends on membership, sortOrder and
 * archivedAt, so editing a title or status re-renders that one row and nothing else.
 */
export class IssueListModel {
    constructor(private readonly pool: ObjectPool) {
        makeObservable(this, { issues: computed, nextTopSortOrder: computed });
    }

    get issues(): Issue[] {
        const visible: Issue[] = [];
        for (const issue of this.pool.all("Issue").values()) if (issue.archivedAt === null) visible.push(issue);
        return visible.sort(byOrder);
    }

    get nextTopSortOrder(): number {
        return (this.issues[0]?.sortOrder ?? 0) - 1;
    }

    indexOf(id: string | null): number {
        return id ? this.issues.findIndex((issue) => issue.id === id) : -1;
    }
}
