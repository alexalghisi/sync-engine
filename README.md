# sync-engine

A small issue tracker built to show how a local-first sync engine works. Every client holds the whole workspace in memory, edits apply instantly, and the server's job is to put all changes into one order and tell everyone about them. The hard parts are the edges: a client that was offline for an hour, two tabs editing the same field, a write the server refuses, a websocket that drops between commit and ack, two server processes that each only see half the clients. This repository is about getting those right, with tests that run against a real Postgres.

![Two tabs on the same issue: live updates, one tab goes offline and queues edits, both converge when it reconnects](docs/preview.gif)

The issue tracker itself is deliberately small: workspaces, one team, users, and issues with a title, description, status, priority, assignee and sort order.

## How it works

**One write path, one log.** Every change goes through `MutationService.apply` (`src/server/sync/mutationService.ts`), whether it arrives as a GraphQL mutation or as a batch of client transactions over the websocket. In a single database transaction it takes a per-workspace advisory lock, applies the operations, appends one row per operation to `sync_actions` (a `bigserial` sync id, model, id, action and the changed fields), records the client transaction id, and issues a `NOTIFY`. Either all of that commits or none of it does. Tests check this by failing the third operation of a transaction and asserting that the first two left no trace in the issues table or the log.

**Why the lock.** A `bigserial` hands out ids when rows are inserted, not when they commit. Without coordination, transaction 12 can commit before transaction 11; a client that sees 12 and stores "last sync id 12" will never ask for 11 again. Holding a workspace lock from before the insert until commit makes commit order equal sync id order inside a workspace. That one property is what makes everything else simple: deltas are "everything after my id", and a bootstrap read from one repeatable-read snapshot contains exactly the actions up to its `lastSyncId` (`src/server/sync/bootstrap.ts`). The cost is that writes within one workspace are serialised, which is measured below. Different workspaces don't contend.

**Fan-out across processes.** The `NOTIFY` payload only carries the workspace and the sync id range a transaction appended. Each server process `LISTEN`s, reads that range back from the log and hands it to its connected sessions (`src/server/sync/syncHub.ts`). Postgres delivers notifications only after commit and in commit order, so two processes behind a load balancer stay correct without talking to each other. The integration tests run two server instances against one database and put the two clients on different ones. If the listener connection drops, every session catches up from the log when it comes back, since notifications sent in the meantime are lost.

**Joining the stream without gaps or repeats.** A session (`src/server/sync/syncSession.ts`) subscribes to the hub before it runs the catch-up query. Live actions that arrive while the query runs are held back, then everything is sent through one filter on the session's cursor. An action committed before the query is in the query result; one committed after is in the held buffer; one that is in both is sent once. Large catch-ups are split into frames of about 1,000 actions, never in the middle of a transaction, because a client confirms its own transaction when its actions arrive and they must arrive together.

**Catch-up or start over.** On connect the client sends its `lastSyncId`. The server replies with the missing actions, or with `bootstrap_required` when the client is behind the compaction watermark, more than `MAX_CATCH_UP_ACTIONS` behind, or claims an id the server has never issued (its data came from another database). `compactLog` deletes old actions and moves the watermark; the seed script uses the same mechanism so tabs holding old demo data reset themselves.

**Two layers on the client.** `SyncStore` (`src/client/store/SyncStore.ts`) keeps the confirmed state, exactly what the server has said up to `lastSyncId`, and a list of pending local transactions. The MobX object pool that the UI reads is always confirmed state with the pending transactions replayed on top, in order. That one rule covers the cases that usually need special code:

- An optimistic write is a new pending transaction, applied immediately.
- A rejection drops that transaction and replays the rest, so a later edit to a different field survives the rollback.
- A client's own write coming back from the server (matched by transaction id) moves from the pending layer into the confirmed layer in the same step. It is never applied twice, and a newer local edit to the same field doesn't flicker back to the older value while the echo passes through.
- An ack can arrive before or after the deltas it refers to. If it comes first, the transaction stays pending until the client has applied that sync id.

The pool is an identity map (`src/client/models/ObjectPool.ts`). When a record changes, the new fields are assigned into the existing `Issue` instance, so observers re-render only for the fields that changed, and a created issue keeps its object when the server confirms it.

**Offline and restarts.** Transactions are persisted as they are made, with a sequence number, through a small storage interface (`src/client/storage/`): IndexedDB in the browser, in memory in tests. Applying a delta writes the changed records, the new `lastSyncId` and the removal of the transactions it confirmed in one IndexedDB transaction, so a crash can't leave the queue and the snapshot disagreeing. After a reconnect the client applies the catch-up first, then sends the queue in order. A transaction that was committed but whose ack was lost is sent again; the server recognises its id in `applied_transactions` and answers with the original sync id instead of applying it twice. Reloading a tab restores the snapshot and the queue from IndexedDB and resumes from the stored sync id, without a bootstrap.

**Conflicts.** The policy is field-level last writer wins, in server order:

- An update carries only the fields the user changed (`src/client/issueActions.ts` drops unchanged ones). Two people changing different fields of the same issue both keep their change.
- For the same field, the write the server commits last wins. For an offline client that is usually its own write, because it reaches the server after reconnecting. The integration and end-to-end tests assert exactly this.
- Until a local write is confirmed, it stays on top of remote changes on that client, so a user's own edit never jumps back while it is in flight.
- Deletes win. Editing an issue someone else deleted is rejected with `not_found`, the edit is rolled back, and the UI says so.
- Title and description are plain fields: concurrent edits to them resolve as a whole, not by merging text.
- The server sets `updatedAt` and `archivedAt`. Clients predict them optimistically and take the server's values when they arrive.

**Ten thousand issues in the browser.** The list is a small fixed-height virtualizer (`src/web/ui/VirtualList.tsx`, with the range maths unit tested in `virtualRange.ts`). The sorted list is a MobX computed (`src/web/IssueListModel.ts`) that only depends on which issues exist, their `sortOrder` and `archivedAt`; editing a title re-renders that row and nothing else. Text fields edit a local draft and commit on blur or Enter, so a remote change never moves text under the cursor and one edit is one transaction rather than one per keystroke.

## Measured

Measured on a shared 2-vCPU VM (Intel Xeon @ 2.10GHz) with Postgres 16 on the same machine, while other workloads were running on it. Treat the numbers as orders of magnitude; write throughput in particular moved by about 2x between runs. They come from `npm run bench` and `npm run bench:web` and are stored in `bench/results.json`.

| What | Result |
| --- | --- |
| Bootstrap, 10,000 issues | 3.6 MB JSON; 99 ms to fetch and parse, 164 ms to build the observable pool (Node) |
| Catch-up after 100 missed actions | 3.6 ms from reconnect to applied |
| Catch-up after 1,000 missed actions | 18 ms |
| Catch-up after 10,000 missed actions | 132 ms, about 75,000 actions/s |
| Edit on one server process to visible on a client of the other | p50 3.0 ms, p95 7.4 ms, p99 10.2 ms (200 edits) |
| Writes in one workspace | 524 transactions/s from one writer, 503/s from 16 concurrent writers |
| Cold load in Chromium, 10,000 issues | first row painted 921 ms after navigation (bootstrap over HTTP) |
| Reload with local data | first row painted 496 ms after navigation (IndexedDB, no bootstrap) |
| DOM size at 1440x900 | 33 rows / 379 nodes at the top, 41 rows / 464 nodes in the middle, 32 rows at the bottom |
| Scrolling 900 px per frame for 200 frames | 16.7 ms p50, 16.7 ms p95, 16.8 ms worst frame |

Catching up is cheaper than bootstrapping: replaying 10,000 actions took about half as long as fetching and hydrating the 10,000-issue workspace, and it only sends what changed. That is why the cut-off for forcing a bootstrap (`MAX_CATCH_UP_ACTIONS`) is generous by default. Scrolling holds the display's 60 Hz frame rate because only a few dozen rows ever exist. Writes are bounded by the workspace lock plus a handful of round trips per transaction and a commit; more concurrent writers in one workspace don't help, by design.

## Tech stack

TypeScript everywhere (strict, `noUncheckedIndexedAccess`, no `any`). Server: Node 22, PostgreSQL 16 through `pg`, GraphQL with graphql-yoga, websockets with `ws`, zod for validating everything that comes off the wire. Client: MobX 7 and `idb`, with no framework dependency; the web app is React 19 and Vite. Tests: Vitest against a real Postgres, Playwright for the browser.

## Running it

Needs Node 22 and a Postgres 16 user that can create databases. The defaults expect `synckit`/`synckit` on `localhost:5432`; set `DATABASE_URL` otherwise.

```bash
npm ci
npm run db:seed              # creates syncengine_dev, migrates, seeds 10,000 issues
npm run dev                  # sync server on :4000, web app on http://localhost:5173
```

Open the app in two windows and edit the same issue in both. **Go offline** in the header closes that tab's connection, so you can queue changes and watch them replay. Each tab is its own client with its own IndexedDB database. `npm run db:seed -- --issues 50000` seeds a different size.

The GraphQL endpoint is at `/graphql` and takes the workspace in an `x-workspace-id` header:

```graphql
mutation {
  issueUpdate(id: "…", input: { status: done }) { lastSyncId issue { title status } }
}
```

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://synckit:synckit@localhost:5432/syncengine_dev` | Server database |
| `PORT` | `4000` | Server port |
| `MAX_CATCH_UP_ACTIONS` | `50000` | Clients further behind re-bootstrap |
| `SYNC_SERVER_URL` | `http://localhost:4000` | Where the Vite dev and preview servers proxy API and websocket traffic |

## Tests

```bash
npm run typecheck
npm run lint
npm test             # 78 unit, server and integration tests; uses syncengine_test (TEST_DATABASE_URL)
npm run e2e          # Playwright: two browser contexts, offline edits, reload with queued edits
```

- `test/client/`: the store (optimistic apply, rollback, echo suppression, acks before deltas, last-writer-wins on top of pending edits), the client (offline queue persistence, replay order after a restart, resend after a dropped connection, re-bootstrap), and both storage implementations against the same suite.
- `test/server/`: the mutation service against real Postgres (atomicity, rejections, idempotent replays, concurrent writers, notify only after commit), catch-up and compaction, and the websocket and GraphQL endpoints with two server processes.
- `test/web/`: the virtualizer's range maths.
- `test/integration/`: real clients over real websockets to two server processes. One goes offline, both edit the same issues, including an edit to an issue the other deletes, and then everything must equal what the server has. A restart while offline, a 300-action catch-up, and a seeded random mix of edits, deletes and connectivity changes across three clients.

If Playwright's own browser isn't installed, set `PLAYWRIGHT_CHROMIUM_PATH` to a local Chromium. The benchmark scripts take `CHROMIUM_PATH`.

## Layout

```
src/shared/     domain model, sync protocol, validation schemas
src/server/     schema and migrations, mutation service, sync log, LISTEN/NOTIFY hub, websocket sessions, GraphQL
src/client/     sync client library: store, object pool, storage adapters, websocket transport
src/web/        React app: virtualized list, detail pane, connection status
test/           Vitest suites (client, server, integration)
e2e/            Playwright tests
bench/          benchmarks behind the numbers above
scripts/        migrate, seed, and the capture used for docs/preview.gif
```

## License

MIT
