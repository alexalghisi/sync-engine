import type { RejectionCode } from "../shared/protocol";

/** A mutation the server refuses. It rolls back the whole transaction and is reported to the client, never thrown past the service. */
export class MutationError extends Error {
    constructor(
        readonly code: RejectionCode,
        message: string,
    ) {
        super(message);
        this.name = "MutationError";
    }
}

const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_CHECK_VIOLATION = "23514";

/** Constraint violations are the database telling us the input was bad, not that the server failed. */
export function toMutationError(error: unknown): MutationError | null {
    if (error instanceof MutationError) return error;
    if (typeof error !== "object" || error === null || !("code" in error)) return null;
    switch (error.code) {
        case PG_UNIQUE_VIOLATION:
            return new MutationError("conflict", "a record with this id already exists");
        case PG_FOREIGN_KEY_VIOLATION:
            return new MutationError("invalid", "a referenced record does not exist");
        case PG_CHECK_VIOLATION:
            return new MutationError("invalid", "a field value is out of range");
        default:
            return null;
    }
}
