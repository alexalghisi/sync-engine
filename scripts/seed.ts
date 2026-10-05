import { parseArgs } from "node:util";
import { DEMO_TEAM_ID, DEMO_WORKSPACE_ID } from "../src/shared/demo";
import { loadConfig } from "../src/server/config";
import { migrate } from "../src/server/db/migrate";
import { createPool, ensureDatabase } from "../src/server/db/pool";
import { seedWorkspace } from "../src/server/db/seed";

const { values } = parseArgs({ options: { issues: { type: "string", default: "10000" } } });
const issues = Number(values.issues);

const { databaseUrl } = loadConfig();
await ensureDatabase(databaseUrl);
const db = createPool(databaseUrl, 1);
await migrate(db);
await seedWorkspace(db, { workspaceId: DEMO_WORKSPACE_ID, teamId: DEMO_TEAM_ID, issues });
console.log(`seeded workspace ${DEMO_WORKSPACE_ID} with ${issues} issues`);
await db.end();
