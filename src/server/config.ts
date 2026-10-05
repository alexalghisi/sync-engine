export interface ServerConfig {
    databaseUrl: string;
    port: number;
    /** A client further behind than this many actions re-bootstraps instead of replaying the log. */
    maxCatchUpActions: number;
}

export const DEFAULT_DATABASE_URL = "postgres://synckit:synckit@localhost:5432/syncengine_dev";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    return {
        databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
        port: Number(env.PORT ?? 4000),
        maxCatchUpActions: Number(env.MAX_CATCH_UP_ACTIONS ?? 50_000),
    };
}
