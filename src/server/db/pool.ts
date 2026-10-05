import pg from "pg";

const INT8_OID = 20;

/**
 * bigserial sync ids arrive as strings by default. They are compared and sent to clients
 * as numbers, which is exact up to 2^53; refuse to go past that rather than lose precision.
 */
function parseInt8(value: string): number {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
    return n;
}

const types = {
    getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === INT8_OID ? parseInt8 : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Either the pool or a client checked out for a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
    return new pg.Pool({ connectionString, max, types });
}

export function createClient(connectionString: string): pg.Client {
    return new pg.Client({ connectionString, types });
}

/** Creates the database named in `connectionString` if it does not exist yet. */
export async function ensureDatabase(connectionString: string): Promise<void> {
    const url = new URL(connectionString);
    const name = decodeURIComponent(url.pathname.slice(1));
    url.pathname = "/postgres";
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    try {
        const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
        if (rowCount === 0) await admin.query(`create database ${pg.escapeIdentifier(name)}`);
    } finally {
        await admin.end();
    }
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
    } catch (error) {
        await client.query("rollback");
        throw error;
    } finally {
        client.release();
    }
}
