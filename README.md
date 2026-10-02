# Offline Field Issue Tracker

Take-home exercise for WEDER Strategies / Resonance AI4D Lab.
Author: Amanuel Musa

## Problem

Field workers in low-connectivity areas need to log issues (a broken water point, failed equipment, an interrupted service) and trust that nothing is lost. Coordinators triage those reports. The system has to:

- let a field worker create and save a report with no connection, and keep it after a refresh or reopen
- sync it later without creating duplicates or silently losing data, and show pending / synced / failed state
- move reports through a defined status workflow with a history of what happened
- let a coordinator see all submitted reports and act on them

Roles are simulated (no authentication), as the brief allows.

## What is built, and what is not

Built:

- Responsive web app (React + Vite) with local persistence in IndexedDB (Dexie), draft autosave, a durable outbox and visible sync state
- Idempotent push sync with retry and backoff, startup recovery, and a manual "Sync now"
- Pull sync, so a coordinator's decision reaches the worker's device, and an edit-and-resubmit flow for rejected reports
- Express + SQLite API with a status workflow, optimistic concurrency (`version`) and append-only history
- Coordinator view (online only) with a history timeline and status actions
- A hand-written service worker so the app shell boots offline after one successful visit
- Automated tests in `shared`, `server` and `web`, and a seed script

Not built (see Known limitations): authentication, photos or maps, offline coordinator actions, geospatial duplicate detection, installable PWA / Background Sync.

## Quick start

Requires Node 24 (`.nvmrc`).

```
git clone https://github.com/vamous-am/weder-field-issue-tracker.git
cd weder-field-issue-tracker
npm install
npm install --prefix shared
npm install --prefix server
npm install --prefix web
npm run seed --prefix server   # optional demo data
npm run dev                    # API on :3000, web on :5173
```

For the offline test, use the production-style build, because the service worker is registered only in the production build:

```
npm run build
npm start   # serves API and built app on http://localhost:3000
```

Use the header toggle to switch the simulated identity: `worker-1`, `worker-2`, `coordinator-1`.

`PORT` and `DB_PATH` can be set through the environment (see `.env.example`). Node does not load `.env` by itself, so `.env.example` only documents the variables.

## Running tests

```
npm test --prefix shared
npm test --prefix server
npm test --prefix web
npm test   # runs all three
```

Results at submission: **shared 142 passing, server 104 passing, web 137 passing**.

What is tested, in priority order (the transition table and the sync paths carry the most risk):

1. Status transitions: an exhaustive table-driven test over all 6 × 6 × 2 combinations, a pinned copy of the documented moves, and a regression test that `rejected → draft` is not allowed
2. Content validation, applied on every transition into `submitted`
3. API: idempotent create (201 then 200), cross-reporter replay (409), refusals (draft, illegal transition, wrong role, stale version), atomic resubmit, history events
4. Sync engine (push): offline create becomes synced, network failure stays pending, 4xx becomes failed without data loss, `syncing` resets on startup, single-flight, wire identity, a simulated lost response followed by a replay
5. Pull merge: server changes propagate, pending operations are never overwritten, local edits survive on failed or dirty reports, no duplicate events
6. Resubmit flow: version read at send time, the three outcomes of a 409, duplicate resubmit blocked
7. Service worker request routing (API never intercepted, navigations fall back to the shell)
8. Notes-required rule cross-check: a table-driven test over all coordinator transitions pins the web rule in sync with the server rule

`syncEngine.test.ts` covers push in isolation through a `noPull` test seam. `pullSync.test.ts` covers the pull direction; the combined pass is exercised indirectly through `syncOnce` in the pull tests.

## Architecture

```
shared/   status list, TRANSITIONS table, isValidTransition, validateReport, event validation
server/   Express API, SQLite schema (node:sqlite), seed script, API tests
web/      React app, Dexie schema, sync engine, service worker, tests
docs/     design decisions
```

- **One source of truth for rules.** The workflow is a data table (`TRANSITIONS`) in `shared/`. The server enforcement, the UI action buttons and the tests all read it, so they cannot drift apart. Enum lists (`STATUSES`, `CATEGORIES`, ...) are `as const` arrays from which both the types and the SQL `CHECK` constraints are derived.
- **Identity.** The client sends `X-Simulated-Role` and `X-Simulated-User`; the server enforces them on every request. These headers are spoofable, which is acceptable because authentication is out of scope.
- **Error shape.** Every error is `{ "error": { "code", "message", "details?" } }`, including malformed JSON, unknown routes and unexpected failures.
- **Status codes.** 400 malformed request or missing/invalid identity headers; 403 role not allowed; 404 unknown report, or a report the caller does not own; 409 no such transition, wrong status, stale `version`, or a replayed ID owned by another reporter; 422 invalid content; 201 first create; 200 idempotent replay.
- **Database.** SQLite through Node's built-in `node:sqlite`, with `CHECK` constraints for enums, coordinates and the "lat and lng come together" rule. `status` cannot be `draft` on the server.

## Status workflow

| From | To | Who | Extra rule |
|---|---|---|---|
| draft | submitted | field worker | content validation passes |
| submitted | assigned, rejected | coordinator | reject requires notes |
| assigned | in_progress, rejected | coordinator | reject requires notes |
| in_progress | resolved, rejected | coordinator | resolve and reject require notes |
| resolved | in_progress | coordinator | reopen requires a reason |
| rejected | submitted | field worker | through `resubmit`; content is validated again |

- Draft exists only on the device. The server never stores or accepts it.
- `rejected → draft` is deliberately absent: a rejected report already exists on the server, so resetting it would be both synced and local-only, and would erase the rejection from history.
- Invalid transitions are hidden or disabled in the UI, and the server refuses them anyway, leaving state unchanged.

## Offline sync strategy

**Local first.** A report is saved to IndexedDB as the user types (debounced autosave). Submitting runs validation, marks the report `pending`, and appends a `create` operation to a durable outbox in one transaction. Local data is never deleted before the server confirms.

**Push.** The sync engine processes the outbox on app start, the browser `online` event, "Sync now", and a retry timer. It is single-flight: a call during a pass schedules one more pass afterwards. Requests carry the report's own `reporter_id`, not the currently selected identity.

| Situation | Behaviour |
|---|---|
| Network error, timeout (10 s), 5xx, 429 | stay `pending`, increment attempts, retry with exponential backoff and jitter (capped at 60 s) |
| 400, 403, 404, 409, 422 | mark `failed`, keep all data, show the server message, record one `sync_failed` history event; "Retry" re-queues |
| App closed or crashed mid-sync | on start, every `syncing` report is reset to `pending`; the idempotent create makes the retry safe |

**Idempotency.** The client generates the report UUID, and it is the server primary key. Replaying the same `id` from the same reporter returns the stored record with 200 (first create returns 201); both count as success. A replay from a different reporter returns 409 and reveals nothing from the stored record. The response carries `{ report, events }`, and the client marks as uploaded only the event IDs the server echoes.

**History.** Events exist locally before sync. They merge by event UUID: server events are authoritative; client-only events (such as a later `sync_failed`) stay local until they ride along with the next successful operation. Clients may upload `created`, `edited`, `synced` and `sync_failed`; `status_changed` is written only by the server. Event inserts use `ON CONFLICT(id) DO NOTHING` rather than `INSERT OR IGNORE`, because `OR IGNORE` would also silently swallow `CHECK` and `NOT NULL` violations.

**Pull.** After a push pass, the client fetches the worker's own reports and merges per report: a report with a pending or syncing operation is skipped; a report with a failed operation or unsent local edits takes the server's status, version, assignee and notes but keeps local content; a local draft is never touched; otherwise the server wins. The pending-operation check runs inside the same transaction as the write, so a submit cannot slip in between check and write.

**Resubmit.** A rejected report can be edited and resubmitted as one atomic operation (`POST /api/reports/:id/resubmit`). The expected version is read at send time. On a 409 the client pulls that report: if the server no longer shows `rejected`, the change already applied and the operation is cleared; if it is still `rejected`, the report is marked failed (conflict), local edits are kept and the new notes are shown. There is no silent retry, because the worker has not seen the new rejection reason.

**Offline app shell.** After one successful visit, the app boots with no network. A hand-written module service worker precaches the built assets (the list is generated by a post-build script, and the cache is named by a content hash), serves navigations from the cached `index.html`, deletes old caches on activate, and never intercepts `/api`. It is registered only in the production build. To test it, run `npm run build && npm start`, load the app once, stop the server, and refresh.

### How conflicts would be handled if coordinator actions could be offline

This is not built (the clarification confirmed coordinators may be online only), but the design extends naturally. The server already owns status and keeps an integer `version`; a stale `expectedVersion` returns 409, so an offline coordinator action could be queued in the same outbox and sent with the version it was based on. On a 409 the client would pull the current record and either reconcile (the server already reflects the intent) or surface the conflict to the coordinator with both versions side by side, never overwrite. Today most conflicts are designed away by field ownership: the worker edits only while the report is a local draft or `rejected`, and the coordinator changes status only after submission, so the two roles do not write the same record in overlapping windows. That removes most conflicts, but not every one, which is why the `version` backstop exists.

## Assumptions and clarifications

Clarifications received from the organisers (first clarification round):

1. **Offline shell:** after the app has been opened successfully once, the worker workflow must stay usable with no backend or network (reopen or refresh, create, save locally, sync later). A first-ever cold load with nothing cached is not required.
2. **Visibility:** a worker needs to see only the reports they created (pending and synced). A coordinator sees all server-side submitted reports.
3. **Coordinator offline:** coordinators may operate online only. Offline creation, local persistence, retry and sync are required for the worker workflow only.

My assumptions:

- Responsive web app, not a native app or full PWA (no manifest, no install prompt, no Background Sync, which is also absent on iOS Safari)
- `reported_at` (when the worker observed the issue, entered by the user) and `created_at` (device time) are both stored; the server adds `received_at`. Both must be in canonical ISO format. Device-clock skew is recorded, not corrected.
- At least one of location text or coordinates is required to submit. The brief does not state this.
- Duplicate submission is handled strictly (idempotency key). Duplicate issue detection is out of scope.
- A rejected report returns to the worker as an editable report that is resubmitted; resolved reports can be reopened by the coordinator (`resolved → in_progress`) with a reason.
- The server sets `status = submitted` on create and rejects any other client-sent status.
- Assigning a report sets `assigned_to` to the coordinator who performed it.
- The reopen reason is recorded in the history event, not in `resolution_notes`.
- A 409 for a replayed ID owned by another reporter reveals that the ID exists (it hides the stored content). With random v4 UUIDs this is impractical to exploit, and it is accepted.

## Decisions that changed during the build

- `better-sqlite3` was replaced by built-in `node:sqlite`: there was no prebuilt binary for Node 24.14 on Windows and compiling needed a C++ toolchain. This also removes a native build step for reviewers. Node still prints an experimental warning for the module.
- The server runs through `tsx` with `noEmit`; there is no compiled `dist/` for the server.
- Non-owners get 404, not 403, when requesting or resubmitting another worker's report.
- A terminal sync failure deletes the outbox operation; "Retry" re-queues it. The operation carries no payload (the body is rebuilt from the stored report at send time), so nothing is lost.
- Sync processes operations sequentially across reports (the original design allowed parallel). This is simpler and enough at this scale.
- Backoff state is in memory. After a reload the start-up pass retries immediately.
- The service worker is a module worker so its routing function can be unit-tested directly.
- A hand-written `runInTransaction` helper wraps `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, because `node:sqlite` has no `.transaction()` method (which `better-sqlite3` provides).
- The `created` event inserted by the initial POST does not always carry `actor_id`; this is a known cosmetic gap in the coordinator's history timeline.
- The notes-required rule (reject, resolve, reopen all need notes) exists in both the server (`reports.ts`) and the web coordinator view (`CoordinatorView.tsx`). A table-driven cross-check test in `web/src/sw/notes.test.ts` pins them in sync.

## Known limitations

- Roles come from spoofable headers; there is no authentication.
- Coordinator actions are online only.
- The very first visit needs a network to populate the service-worker cache, and the service worker needs HTTPS or `localhost` (a phone on a plain-HTTP LAN address gets no offline boot). The module worker needs a current browser (Chrome, Edge, Safari, Firefox).
- Not installable; no manifest or Background Sync.
- `node:sqlite` is still flagged experimental by Node, so its API could change in future Node versions.
- Pull fetches all of the worker's own reports; there is no "changed since" endpoint.
- The server trusts the client-supplied `id` on replay and does not compare the replayed payload with the stored record.
- If an operation never succeeds, its client-only failure events stay on the device.
- Autosave is debounced, so up to roughly 300 ms of typing could be lost if a tab is killed abruptly.
- No photos or maps, and no geospatial duplicate detection.
- The `created` event from the initial POST may have a null `actor_id` in the history timeline.

## QA checklist

Manual checks run against the real server (`npm run build && npm start`).

| # | Check | Result |
|---|---|---|
| 1 | Online submit: badge goes pending to synced, one server row | PASS |
| 2 | Server down: report stays pending, attempts grow; after restart and "Sync now" it syncs once | PASS |
| 3 | Reject as coordinator, then "Sync now" as worker: rejection and reason appear, persist after reload | PASS |
| 4 | Edit and resubmit a rejected report: syncs once, coordinator sees `submitted`, one history timeline, no duplicates | PASS |
| 5 | Clear the description and resubmit: validation error, nothing queued, server unchanged | NOT RUN |
| 6 | Offline resubmit, reload, then sync: exactly one rejected-to-submitted entry | NOT RUN |
| 7 | Coordinator: only legal buttons shown; empty notes blocked; stale version shows a message and refetches | PASS |
| 8 | Identity switch with a pending report: the server row is owned by the original worker | NOT RUN |
| 9 | Corrupted pending report: shows `failed` with the server message and one `sync_failed` event | NOT RUN |
| 10 | Built app: load once, stop the server, refresh, the app boots with saved reports | PASS |
| 11 | Built app, server stopped: create a report, refresh, it persists as pending; restart, sync, one server row | PASS |
| 12 | `/api/health` opened in the address bar returns JSON, not the app | PASS |
| 13 | Coordinator list offline shows a clear "needs connection" state | PASS |
| 14 | A worker cannot see another worker's reports from the server | NOT RUN |

Not verified end to end: a response lost mid-flight. The retry path is covered at each layer (a unit test where a network error is followed by a 200 replay, and a server test that a replay returns 200 with one row), but I did not drop a real response in the browser.

## Time spent

About 10 hours of actual coding and testing, plus additional time in design reviews, documentation, and iterative review of the plans (which I do not count as coding time). I stayed within the six-hour target for the core implementation by cutting scope as needed: no photos, no maps, no offline coordinator actions, no installable PWA. The remaining hours covered the pull sync, resubmit flow, coordinator view, and the service worker that go beyond the minimum brief.

## AI disclosure

I used AI tools throughout, and I want to be specific about what they did and what I did.

**Tools**

- **Claude (Anthropic)** as a design reviewer and mentor: it challenged my decision document across several review rounds, helped me work through ambiguities in the brief, reviewed code, test output and plans I pasted, helped diagnose the Windows native build failure and the tsconfig and Vitest setup problems, and drafted this README's structure and the submission email, which I edited and checked against the code. I asked it to act as a mentor and not to write my core logic.
- **Another AI assistant (GLM 5.1)** produced the first scaffold instructions (package manifests, tsconfig and Vite/Vitest configuration), some error-fix guidance, and some milestone plans.
- **Kiro (an AI IDE agent)** implemented a large part of the code under my direction: the sync engine and its tests, the pull merge and its tests, the resubmit flow, the coordinator view, the service worker, the build script, the static-serving tests, the seed script, and the server routes from milestones 2 to 4.

**What I wrote and decided**

- I wrote `shared/types.ts`, `shared/transitions.ts` and `shared/validation.ts`. AI helped with their two test files.
- I made the architecture, API and sync decisions in `docs/PROJECT_DECISIONS.md` (the document went through several AI review rounds, and I accepted or rejected each point).
- I ran the manual QA above and verified the automated results myself.

**What AI wrote, with my direction and review**

- The initial scaffold and configuration; the `ApiError` class (drafted by AI, then adapted by me)
- The code listed under Kiro, and the two test files for `shared`
- Several step-by-step milestone plans, which I compared across tools and chose between

**Suggestions I rejected or changed**

- A suggestion to downgrade Node to 22 and install global Windows build tools, because it contradicted my documented Node 24 decision. I switched to built-in `node:sqlite` instead.
- A suggestion to define statuses as union types only. I used `as const` arrays so the exhaustive test loop and the types share one list.
- An earlier design that skipped the service worker; I reversed it because an offline refresh would have failed.
- Resetting a rejected report to draft, batch sync, last-write-wins, npm workspaces and a silent version retry on resubmit conflicts were all considered and rejected (reasons in the decisions document).

**AI output that turned out to be wrong, which I caught**

- The AI assistant told me `node:sqlite` was stable on Node 24. My own run printed an experimental warning, so I documented it as experimental.
- A plan used `INSERT OR IGNORE` for events. A later review showed it also swallows constraint violations, so I use `ON CONFLICT(id) DO NOTHING`.
- Some plans asked for `status: draft` to be rejected only; I made the create endpoint accept only `submitted`.

**How I verified**

Automated tests in all three packages, the manual checklist above, and a fresh-clone run (clone, install, test, seed, build, start) before submitting.

## What I would do next

- Compare the replayed payload with the stored record (payload hash) on idempotent replay
- A "changed since" endpoint for pull
- Real authentication
- A browser end-to-end test (Playwright) for the offline golden path, and an HTTPS deployment
- Move the notes-required rule into `shared` so the server and the UI share one definition
- Offline coordinator actions, using the conflict approach described above
