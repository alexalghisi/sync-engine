import { computed, makeObservable, observable } from "mobx";
import type { IssuePriority, IssueRecord, IssueStatus, ModelName, ModelRecords, TeamRecord, UserRecord } from "../../shared/domain";

/** Read access to other models, so a model can resolve its references. */
export interface ModelLookup {
    get<M extends ModelName>(model: M, id: string): ModelInstances[M] | undefined;
}

export interface ModelInstance<R> {
    readonly id: string;
    assign(record: R): void;
}

export class Team implements ModelInstance<TeamRecord> {
    readonly id: string;
    key: string;
    name: string;

    constructor(record: TeamRecord) {
        this.id = record.id;
        this.key = record.key;
        this.name = record.name;
        makeObservable(this, { key: observable, name: observable });
    }

    assign(record: TeamRecord): void {
        this.key = record.key;
        this.name = record.name;
    }
}

export class User implements ModelInstance<UserRecord> {
    readonly id: string;
    name: string;

    constructor(record: UserRecord) {
        this.id = record.id;
        this.name = record.name;
        makeObservable(this, { name: observable });
    }

    assign(record: UserRecord): void {
        this.name = record.name;
    }
}

export class Issue implements ModelInstance<IssueRecord> {
    readonly id: string;
    teamId!: string;
    title!: string;
    description!: string;
    status!: IssueStatus;
    priority!: IssuePriority;
    assigneeId!: string | null;
    sortOrder!: number;
    createdAt!: string;
    updatedAt!: string;
    archivedAt!: string | null;

    constructor(
        record: IssueRecord,
        private readonly lookup: ModelLookup,
    ) {
        this.id = record.id;
        this.assign(record);
        makeObservable(this, {
            teamId: observable,
            title: observable,
            description: observable,
            status: observable,
            priority: observable,
            assigneeId: observable,
            sortOrder: observable,
            updatedAt: observable,
            archivedAt: observable,
            assignee: computed,
            team: computed,
        });
    }

    get assignee(): User | undefined {
        return this.assigneeId ? this.lookup.get("User", this.assigneeId) : undefined;
    }

    get team(): Team | undefined {
        return this.lookup.get("Team", this.teamId);
    }

    assign(record: IssueRecord): void {
        this.teamId = record.teamId;
        this.title = record.title;
        this.description = record.description;
        this.status = record.status;
        this.priority = record.priority;
        this.assigneeId = record.assigneeId;
        this.sortOrder = record.sortOrder;
        this.createdAt = record.createdAt;
        this.updatedAt = record.updatedAt;
        this.archivedAt = record.archivedAt;
    }
}

export interface ModelInstances {
    Team: Team;
    User: User;
    Issue: Issue;
}

export type ModelFactories = { [M in ModelName]: (record: ModelRecords[M], lookup: ModelLookup) => ModelInstances[M] };

export const modelFactories: ModelFactories = {
    Team: (record) => new Team(record),
    User: (record) => new User(record),
    Issue: (record, lookup) => new Issue(record, lookup),
};
