import { z } from "zod";

export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** 0 = no priority, then urgent (1) down to low (4), the same scale Linear uses. */
export const ISSUE_PRIORITIES = [0, 1, 2, 3, 4] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const TITLE_MAX_LENGTH = 512;
export const DESCRIPTION_MAX_LENGTH = 20_000;

export interface TeamRecord {
    id: string;
    key: string;
    name: string;
}

export interface UserRecord {
    id: string;
    name: string;
}

export interface IssueRecord {
    id: string;
    teamId: string;
    title: string;
    description: string;
    status: IssueStatus;
    priority: IssuePriority;
    assigneeId: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
}

export interface ModelRecords {
    Team: TeamRecord;
    User: UserRecord;
    Issue: IssueRecord;
}

export type ModelName = keyof ModelRecords;
export const MODEL_NAMES = ["Team", "User", "Issue"] as const satisfies readonly ModelName[];

export type ModelRecord = { [M in ModelName]: { model: M; data: ModelRecords[M] } }[ModelName];

const uuid = z.uuid();

/** The fields a client may write. Everything else (timestamps, ownership) is decided by the server. */
export const issueChangesSchema = z
    .object({
        title: z.string().trim().min(1).max(TITLE_MAX_LENGTH),
        description: z.string().max(DESCRIPTION_MAX_LENGTH),
        status: z.enum(ISSUE_STATUSES),
        priority: z.literal(ISSUE_PRIORITIES),
        assigneeId: uuid.nullable(),
        sortOrder: z.number().finite(),
    })
    .strict();

export const issueUpdateSchema = issueChangesSchema.partial().refine((c) => Object.keys(c).length > 0, {
    message: "an update must change at least one field",
});

export const issueCreateSchema = issueChangesSchema.partial({ description: true, assigneeId: true, status: true, priority: true }).extend({
    teamId: uuid,
});

export type IssueChanges = z.infer<typeof issueUpdateSchema>;
export type IssueCreateInput = z.infer<typeof issueCreateSchema>;
export type IssueWritableField = keyof z.infer<typeof issueChangesSchema>;
