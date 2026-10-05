export const E2E_WORKSPACE_ID = "3d0f8a5e-7c2b-4e19-8f6a-2b9c4d1e7a55";
export const E2E_TEAM_ID = "9a7c1e3b-5d2f-4a8e-b6c4-1f3e5d7a9b20";
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://synckit:synckit@localhost:5432/syncengine_test";
export const E2E_SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 4101);
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4191);
