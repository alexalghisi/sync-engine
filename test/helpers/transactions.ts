import { randomUUID } from "node:crypto";
import type { IssueChanges } from "../../src/shared/domain";
import type { Operation, Transaction } from "../../src/shared/protocol";

export function tx(...ops: Operation[]): Transaction {
    return { id: randomUUID(), ops };
}

export function update(id: string, changes: IssueChanges): Operation {
    return { kind: "update", model: "Issue", id, changes };
}

export function create(teamId: string, title: string, id: string = randomUUID()): Operation {
    return { kind: "create", model: "Issue", id, data: { teamId, title, sortOrder: 0 } };
}
