import { randomUUID } from "node:crypto";
import { createGraphQLError, createSchema } from "graphql-yoga";
import { z } from "zod";
import type { IssueRecord } from "../../shared/domain";
import { transactionSchema } from "../../shared/protocol";
import type { Db } from "../db/pool";
import { findIssue, listIssues } from "../issues/issueRepository";
import type { MutationService } from "../sync/mutationService";
import { readLogBounds } from "../sync/syncLog";

export interface GraphQLContext {
    workspaceId: string | null;
}

const typeDefs = /* GraphQL */ `
    enum IssueStatus {
        backlog
        todo
        in_progress
        done
        canceled
    }

    type Issue {
        id: ID!
        teamId: ID!
        title: String!
        description: String!
        status: IssueStatus!
        "0 = none, 1 = urgent ... 4 = low"
        priority: Int!
        assigneeId: ID
        sortOrder: Float!
        createdAt: String!
        updatedAt: String!
        archivedAt: String
    }

    type IssuePayload {
        "Sync id of the change. A client that has applied this id already sees the result."
        lastSyncId: Float!
        issue: Issue
    }

    type DeletePayload {
        lastSyncId: Float!
    }

    input IssueCreateInput {
        id: ID
        teamId: ID!
        title: String!
        description: String
        status: IssueStatus
        priority: Int
        assigneeId: ID
        sortOrder: Float!
    }

    input IssueUpdateInput {
        title: String
        description: String
        status: IssueStatus
        priority: Int
        assigneeId: ID
        sortOrder: Float
    }

    type Query {
        issues(includeArchived: Boolean = false): [Issue!]!
        issue(id: ID!): Issue
        lastSyncId: Float!
    }

    type Mutation {
        issueCreate(input: IssueCreateInput!): IssuePayload!
        issueUpdate(id: ID!, input: IssueUpdateInput!): IssuePayload!
        issueArchive(id: ID!): IssuePayload!
        issueDelete(id: ID!): DeletePayload!
    }
`;

const idArgs = z.object({ id: z.string() });
const createArgs = z.object({ input: z.object({ id: z.string().optional() }).loose() });
const updateArgs = z.object({ id: z.string(), input: z.record(z.string(), z.unknown()) });
const listArgs = z.object({ includeArchived: z.boolean().nullish() });

function requireWorkspace(ctx: GraphQLContext): string {
    if (!ctx.workspaceId) throw createGraphQLError("missing x-workspace-id header", { extensions: { code: "UNAUTHENTICATED" } });
    return ctx.workspaceId;
}

const ERROR_CODES = { invalid: "BAD_USER_INPUT", not_found: "NOT_FOUND", conflict: "CONFLICT" } as const;

/**
 * GraphQL mutations are one-operation transactions through the same service the sync
 * socket uses; they get a server-generated transaction id and show up in every client's
 * delta stream like any other change.
 */
export function createGraphQLSchema(db: Db, mutations: MutationService) {
    async function mutate(workspaceId: string, op: unknown): Promise<number> {
        const tx = transactionSchema.safeParse({ id: randomUUID(), ops: [op] });
        if (!tx.success) throw createGraphQLError(z.prettifyError(tx.error), { extensions: { code: "BAD_USER_INPUT" } });
        const result = await mutations.apply(workspaceId, tx.data);
        if (!result.ok) throw createGraphQLError(result.message, { extensions: { code: ERROR_CODES[result.code] } });
        return result.syncId;
    }

    async function issuePayload(workspaceId: string, id: string, lastSyncId: number): Promise<{ lastSyncId: number; issue: IssueRecord | null }> {
        return { lastSyncId, issue: await findIssue(db, workspaceId, id) };
    }

    return createSchema<GraphQLContext>({
        typeDefs,
        resolvers: {
            Query: {
                issues: (_: unknown, args: unknown, ctx: GraphQLContext) =>
                    listIssues(db, requireWorkspace(ctx), listArgs.parse(args).includeArchived ?? false),
                issue: (_: unknown, args: unknown, ctx: GraphQLContext) => findIssue(db, requireWorkspace(ctx), idArgs.parse(args).id),
                lastSyncId: async (_: unknown, _args: unknown, ctx: GraphQLContext) => (await readLogBounds(db, requireWorkspace(ctx))).current,
            },
            Mutation: {
                issueCreate: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
                    const workspaceId = requireWorkspace(ctx);
                    const { id = randomUUID(), ...data } = createArgs.parse(args).input;
                    return issuePayload(workspaceId, id, await mutate(workspaceId, { kind: "create", model: "Issue", id, data }));
                },
                issueUpdate: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
                    const workspaceId = requireWorkspace(ctx);
                    const { id, input } = updateArgs.parse(args);
                    return issuePayload(workspaceId, id, await mutate(workspaceId, { kind: "update", model: "Issue", id, changes: input }));
                },
                issueArchive: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
                    const workspaceId = requireWorkspace(ctx);
                    const { id } = idArgs.parse(args);
                    return issuePayload(workspaceId, id, await mutate(workspaceId, { kind: "archive", model: "Issue", id }));
                },
                issueDelete: async (_: unknown, args: unknown, ctx: GraphQLContext) => {
                    const workspaceId = requireWorkspace(ctx);
                    const { id } = idArgs.parse(args);
                    return { lastSyncId: await mutate(workspaceId, { kind: "delete", model: "Issue", id }) };
                },
            },
        },
    });
}
