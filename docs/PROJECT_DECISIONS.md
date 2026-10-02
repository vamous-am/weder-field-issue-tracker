# Field Issue Tracker: Decisions and Architecture

Repo: `weder-field-issue-tracker` (public GitHub)
Exercise: WEDER Strategies / Resonance AI4D Lab take-home
Author: Amanuel Musa

Status of this file: final submission revision. It merges the pre-build design
document with the implementation specifics locked in during the build, and a log
of everything that changed from the original plan.

---

## 2. Ambiguities in the brief and how each was resolved

| # | Ambiguity | Decision | Reasoning |
|---|---|---|---|
| 1 | Mobile app or website? | Responsive, mobile-first **website**, used by both roles | "Frontend application" is form-factor neutral. Field workers can use a phone browser. A native app adds emulator and store overhead for zero rubric benefit. |
| 2 | Responsive web app, full PWA, or something between? | **Not a full PWA.** A minimal, cache-only module service worker caches the static app-shell assets so the app boots with no network, once it has loaded successfully at least once. No manifest, no install prompt, no Background Sync | The brief (and the clarification received — see §11) says the worker workflow must stay usable after a refresh or reopen, with no network, once the app has been opened successfully before. A first-ever cold load with nothing cached is not required. Without a cached shell, an offline refresh fails before any data can load, so IndexedDB alone does not satisfy that requirement. An earlier draft chose no service worker and reworded the QA step to match. That was reversed because it changed the test instead of the behavior. |
| 3 | How is sync triggered? | Explicit: browser `online` event, app open, manual "Sync now" button, retry timer with backoff. No Background Sync | Background Sync is Chromium-only (absent on iOS Safari) and hands timing to the browser, which conflicts with the requirement to show visible pending/synced/failed state. |
| 4 | What does "date/time reported" mean? | Two fields: `reported_at` (when the worker observed the issue, user-entered) and `created_at` (when the record was made on the device). Server adds `received_at` | Field workers log retroactively, and device clocks can be wrong, so keeping both device and server time is safer. |
| 5 | Where does Draft live? | **Local only.** The server never stores or accepts `draft` | Draft means "never touched the server". The server rejects any payload with `status: draft` — and, more broadly, any client-sent status other than `submitted` (see §6.1). |
| 6 | Can a Rejected report return to Draft? | **No.** `rejected → submitted` only | Rejected reports already exist server-side. Resetting to Draft creates a logical paradox (synced and local-only at once) and erases the rejection from history. |
| 7 | Who performs status changes after submission? | The **coordinator** owns assign, start, resolve, reject and reopen. The field worker only creates, submits, and edits and resubmits Rejected reports | The worker may be offline in the field. Centralised workflow avoids write races. |
| 8 | Can resolved issues be reopened? | Yes, `resolved → in_progress`, coordinator only, **reason required** | Already triaged once, so no reason to re-queue from the start. The reason lives only in the history event, not in `resolution_notes` — see §5.2. |
| 9 | Editing after submission | Locked for the field worker, except on a Rejected report: edit locally, then resubmit through one atomic `resubmit` operation (see §5 and §6). Coordinator changes go through status actions | Removes the window where worker and coordinator can write the same record. |
| 10 | Duplicate detection | Duplicate **submission** is handled hard (idempotency key). Duplicate **issue** detection is out of scope | Submission duplicates corrupt data. Geospatial proximity on SQLite is more work than it looks and is a product judgment. |
| 11 | Validation: when is it enforced? | Draft autosave is not validated. Full validation runs on every transition **into** `submitted`, for both `draft → submitted` and `rejected → submitted` | Validation is tied to the target state, not the path. Otherwise an edited Rejected report could bypass it. |
| 12 | Data safety before sync | Draft fields autosave to IndexedDB as the user types. No `beforeunload` warning needed | Nothing is left unsaved between keystrokes. |
| 13 | Are coordinator actions available offline? | **Online-only.** The server is authoritative for status. **Confirmed by clarification** — see §11 | Offline coordinator edits would reintroduce the conflicts that the ownership model removes. |
| 14 | Can workers see other workers' reports? | **No.** A worker sees only their own (identified by simulated user ID). The coordinator sees all. **Confirmed by clarification** — see §11 | Keeps the role model simple, and makes "pull my reports" well-defined. |
| 15 | Time limit | The brief states no hour budget. See the README for time spent. | Do not put an unverified number in the submission. |
| 16 | How does a worker learn a report was Rejected? | A **pull sync** direction alongside the push outbox (§6) | Without it the worker's device never sees coordinator actions, and the reject-and-resubmit workflow is unreachable. |
| 17 | How is a simulated user identified? | Client sends `X-Simulated-Role` and `X-Simulated-User` headers, set from a UI toggle. The server enforces them on every request and does not trust the UI | A role alone cannot identify whose reports to return or who may resubmit. Headers are trivially spoofable, which is acceptable because authentication is explicitly out of scope. |
| 18 | Replay of the same `id` with different content | **Not verified** for a same-reporter replay. The server trusts the client-supplied ID and does not compare the replayed payload against the stored record. For a replay from a different reporter, the server refuses with 409 | The designed flow never produces a mismatched same-reporter replay. Cross-reporter replay is refused outright, since serving someone else's stored report back to a different caller would be a data leak. |

---

## 3. Technology stack and rationale

| Layer | Choice | Why | Rejected alternatives |
|---|---|---|---|
| Language | **TypeScript** everywhere | Typed enums (`Status`, `Role`) and a typed transition table catch casing and shape drift at compile time | Plain JavaScript |
| Frontend | React + Vite | Core stack, fast setup, defensible line by line | Next.js (SSR irrelevant), React Native/Expo (scope creep) |
| Local storage | Dexie.js over IndexedDB | Structured data, transactions, survives refresh and reopen | localStorage (size limits, no transactions) |
| Offline app shell | Minimal hand-written, cache-only **module** service worker | Boots the app offline. Module type chosen so the routing logic can be unit-tested directly by importing it | Full PWA with manifest and Background Sync (scope), no service worker (fails offline refresh) |
| Backend | Node + Express | Known stack, minimal ceremony | Fastify and Prisma (setup overhead for no rubric gain) |
| Server DB | **`node:sqlite`** (Node's built-in `DatabaseSync`) | Persistent, zero external setup, synchronous API, supports transactions, needs **no native compilation** — see §14.1 | `better-sqlite3` (native build failed — see §14.1), Postgres (reviewer setup burden) |
| Tests | Vitest across all three packages, Supertest for API | Same toolchain as Vite, fast, one runner | Jest (extra config) |
| Package manager | **npm** | Nothing extra for a reviewer to install | pnpm, yarn |
| Node version | **Node 24**, pinned in `.nvmrc` and `engines` | Node 20 reached end of life. Node 22 is maintenance only. | Node 20 (dead), Node 22 (maintenance — also rejected mid-build as a workaround; see §14.1) |
| Server runtime | **`tsx`** with `noEmit: true`. No compiled `dist/` for the server | Less ceremony than a build step. Avoids a `rootDir` conflict when `shared/` sits outside `server/`'s directory tree | A compiled `dist/server.js` |
| Shared code | One `shared/` folder consumed through **TypeScript path aliases** (`@shared/*`) | Less ceremony than npm workspaces for a solo build | npm workspaces, relative `../../shared` imports (fragile) |
| Dev networking | Vite dev proxy to the Express port | Avoids CORS middleware | CORS middleware only |

Repo layout:

```
weder-field-issue-tracker/
  shared/   statuses, TRANSITIONS table, isValidTransition, validateReport, event validation
  server/   Express API, SQLite schema (node:sqlite), seed script, API tests
  web/      React app, Dexie schema, sync engine, service worker, tests
  docs/     this file
  .env.example  .nvmrc  README.md
```

### API surface

| Method and path | Role | Purpose |
|---|---|---|
| `POST /api/reports` | field_worker | Create (first submit). Idempotent on `id`. Accepts `events[]`. Returns `{ report, events }` |
| `GET /api/reports?reporter=me` | field_worker | Pull the caller's own reports with version, status, assigned_to, resolution_notes |
| `GET /api/reports` | coordinator | All reports (online only) |
| `GET /api/reports/:id` | both, scoped to own for worker | One report with history. Non-owner or unknown → 404 |
| `POST /api/reports/:id/resubmit` | field_worker | Atomic content edit plus `rejected → submitted`. Non-owner or unknown → 404; wrong status → 409 |
| `PATCH /api/reports/:id/status` | coordinator | Status transition with `expectedVersion`. Notes where required |

Identity: `X-Simulated-Role` and `X-Simulated-User` on every request. Missing or unrecognised → 400. Wrong role → 403.

---

## 4. Domain model

Convention: **status values are lowercase snake_case everywhere**: `draft`, `submitted`, `assigned`, `in_progress`, `resolved`, `rejected`.

### Report

| Field | Type | Notes |
|---|---|---|
| `id` | UUID v4 | Client-generated. Doubles as the idempotency key |
| `reporter_id` | string | Simulated worker identity |
| `category` | enum | water_point, equipment, service_interruption, safety, maintenance |
| `description` | text | Required at submit |
| `location` | string and/or lat/lng | At least one required (product assumption). Table-level `CHECK ((lat IS NULL) = (lng IS NULL))` |
| `priority` | enum | low, medium, high, critical |
| `status` | enum | Server `CHECK` excludes `draft` |
| `reported_at` | ISO 8601 UTC | Observation time, user input |
| `created_at` | ISO 8601 UTC | Device time when record was made |
| `received_at` | ISO 8601 UTC | Server only, set on first receipt |
| `updated_at` | ISO 8601 UTC | Last modification |
| `version` | integer | Server-incremented concurrency guard |
| `assigned_to` | string, nullable | Set to caller identity on assignment; cleared on any transition into `rejected` |
| `resolution_notes` | text, nullable | Required on reject and resolve. Not used for reopen reason — see §5.2 |
| `sync_state` | pending / syncing / synced / failed | **Client only** |
| `last_error`, `attempts`, `content_dirty` | client only | Failure reasons, backoff count, and unsent local edits flag |

### ReportHistory

`id` (UUID, idempotent on replay), `report_id`, `action` (`created`, `edited`, `synced`, `sync_failed`, `status_changed`), `old_value`, `new_value`, `actor_role`, `actor_id`, `timestamp`, plus client-only `uploaded` flag. Append-only.

### Decisions on history

- **Single JSON-diff row per edit.** `old_value` and `new_value` hold JSON of only the changed fields.
- **History exists locally before sync.** Dexie has its own `reportHistory` table.
- **Merge by event UUID, not by deleting local history.** Server events are authoritative. Client-originated events that the server never saw stay local with `uploaded = false` and ride along with the next successful operation. Deleting local history after first sync would silently lose failure events.
- **Client-uploadable actions:** `created`, `edited`, `synced`, `sync_failed`. `status_changed` is server-only; uploading one is refused with 422.

---

## 5. Status workflow

The transition table is the single source of truth. It lives in `shared/transitions.ts` and is consumed by the server, tests and UI — the README table and code behaviour are structurally the same thing.

| From | To | Actor | Notes |
|---|---|---|---|
| draft | submitted | field_worker | `validateReport()` passes |
| submitted | assigned | coordinator | sets `assigned_to = caller` |
| submitted | rejected | coordinator | requires `resolution_notes`; clears `assigned_to` |
| assigned | in_progress | coordinator | |
| assigned | rejected | coordinator | requires `resolution_notes`; clears `assigned_to` |
| in_progress | resolved | coordinator | requires `resolution_notes` |
| in_progress | rejected | coordinator | requires `resolution_notes`; clears `assigned_to` |
| resolved | in_progress | coordinator | requires a reopen reason (event only — see §5.2) |
| rejected | submitted | field_worker | via `resubmit`; `validateReport()` passes on the merged result |

Same-state transitions are always invalid. `rejected → draft` is absent by design, pinned by a regression test. `assigned → submitted` is absent — unassignment is not a supported coordinator action.

### 5.1 Identity enforcement on status actions

`requireIdentity` and `requireRole` middleware. Missing or unrecognised headers → 400. Wrong role → 403.

### 5.2 Reopen reason

A `resolved → in_progress` reason is stored **only** in the `status_changed` history event as `new_value.reason`. It does **not** overwrite `reports.resolution_notes` — the stored resolution notes survive a later reopen.

The request body uses `resolution_notes` as the input field name for every transition needing free text, including reopen, for one consistent shape.

Example event:
```json
{
  "action": "status_changed",
  "old_value": "{\"status\":\"resolved\"}",
  "new_value": "{\"status\":\"in_progress\",\"reason\":\"The pump is leaking again.\"}"
}
```

### 5.3 Optimistic concurrency (CAS)

```sql
UPDATE reports
SET status = ?, assigned_to = ?, resolution_notes = ?,
    updated_at = ?, version = version + 1
WHERE id = ? AND version = ?;
```

If affected-row count is zero → 409. Client must re-fetch before retrying.

### 5.4 Assignment

`assigned_to = req.identity.userId`. Any `assigned_to` in the request body is ignored.

### 5.5 Rejection clears assignment

Any transition into `rejected` clears `assigned_to`.

### 5.6 Required notes matrix

| Transition | Input field | Stored in report column | Stored in event |
|---|---|---|---|
| Any → rejected | `resolution_notes` | `resolution_notes` | `new_value.reason` |
| in_progress → resolved | `resolution_notes` | `resolution_notes` | `new_value.reason` |
| resolved → in_progress | `resolution_notes` | *(unchanged)* | `new_value.reason` |

This rule is enforced server-side and duplicated in the web coordinator view. A cross-check test (`web/src/sw/notes.test.ts`) asserts both agree. Moving the rule into `shared/` is documented as future work.

### 5.7 Resubmission field whitelist

Only these fields may be merged during `POST /resubmit`:

```
category, description, location, lat, lng, priority, reported_at
```

All other fields are silently ignored (mass-assignment guard). A successful resubmission always sets `status = submitted`, clears `assigned_to`, clears `resolution_notes`, increments `version` once.

### 5.8 Event ordering in resubmission

For a resubmit that changes content, in one transaction with one shared timestamp:
1. `edited` — diff of changed content fields
2. `status_changed` — `rejected → submitted`

If no accepted field changes, `edited` is omitted.

### 5.9 Non-owner / unknown report response

`GET /:id` and `POST /:id/resubmit` both return 404 for a non-owner and for an unknown ID. Existence-and-ownership is checked before status, so a non-owner cannot infer a rejected report's existence by comparing error codes.

### Status-code scheme

| Code | Use |
|---|---|
| 400 | Malformed JSON, missing top-level fields, missing/invalid identity headers |
| 403 | Well-formed identity attempting an action its role does not permit |
| 404 | Unknown report, or a report the caller (field worker) does not own |
| 409 | No such transition, wrong status for resubmit, stale `expectedVersion`, or replayed ID owned by a different reporter |
| 422 | Bad category, empty description, missing notes, unsupported status on create, or client attempting to upload a `status_changed` event |
| 201 / 200 | First create / idempotent replay by the same reporter |

---

## 6. Offline persistence and synchronization design

### Push flow

1. Worker creates a report — saved to Dexie immediately as `draft`, autosaved.
2. On submit: `validateReport()`, local status → `submitted`, `sync_state = pending`, one `create` op appended to the outbox, one `created` event stored locally.
3. For a Rejected report: worker edits locally (`content_dirty`), then resubmits → one `resubmit` op queued.
4. Sync engine processes the outbox on `online` event, app open, "Sync now", and backoff retry timer. Single-flight: a call during a pass schedules exactly one more pass afterward.
5. Operations run **sequentially** across all reports — see §14.3.
6. `expectedVersion` is filled in at send time from the latest known server version.
7. Requests carry the report's own `reporter_id`, never the currently active identity toggle.

### Pull flow

Same triggers as push, run after push drains, scoped to the active worker identity.

- Fetch `GET /api/reports?reporter=me`. The list carries no history events; `GET /:id` is fetched only when the version differs locally, or when no local events are held.
- Merge per report into Dexie:
  - **Has pending or syncing outbox op:** skip entirely. Check runs *inside* the same write transaction as the merge.
  - **Has failed outbox op, or `content_dirty`:** take server `status`, `version`, `assigned_to`, notes; keep local content fields.
  - **Otherwise:** server wins on the whole record.
  - **Server-only report:** insert as `synced`.
  - **Local draft:** untouched.
  - `reporter_id` is checked against the active worker as defense in depth.
- History merges by event UUID. Do not synthesize local `status_changed` events on pull.

### Idempotency

- Same reporter, same `id` → 200 with the existing record. Both 201 and 200 return `{ report, events }` so the client marks exactly the server-echoed event IDs as uploaded.
- Different reporter, same `id` → 409, nothing leaked.
- History events inserted with `ON CONFLICT(id) DO NOTHING` — not `INSERT OR IGNORE` (see §14.4).

### Failure handling

| Situation | Behaviour |
|---|---|
| Network error, timeout (10 s), 5xx, 429 | Stay `pending`, exponential backoff (base 2 s, cap 60 s, ±20% jitter) |
| 400 / 422 | Mark `failed`, keep all data, show server message, log `sync_failed` |
| 409 (create) | Terminal: mark `failed` |
| 409 (resubmit) | Pull that report. If server status ≠ `rejected` → clear op, mark `synced`. If still `rejected` → mark `failed (conflict)`, keep edits, surface new notes. No silent retry. |
| 403 / 404 | Mark `failed`, preserve data |
| App closed mid-sync | On startup reset `syncing` → `pending`. Idempotent create makes retry safe. |
| Terminal failure | Outbox op is **deleted**. "Retry" re-inserts a fresh op — see §14.5. |

### Service worker (app shell)

- **Module** service worker (`type: 'module'`), so routing logic is unit-testable directly.
- Precaches built static assets under a hash-named cache generated by a post-build script. Serves navigations from cached `index.html`. Removes old caches on activate.
- Never intercepts `/api/*` (checked before navigate-mode check). Registered only in the production build.
- Needs HTTPS or `localhost`. First visit needs network.
- Express's SPA fallback excludes `/api` and bare `/api` so unknown API routes still return JSON errors.

### Conflicts: designed away, then backstopped

- **Design:** worker edits only while `draft` or `rejected`; coordinator changes status only after submission. Overlapping writes are structurally prevented.
- **Backstop:** `version` CAS. A stale `expectedVersion` → 409.
- **Residual:** double-tap resubmit. First op applies; second gets 409 (wrong status or stale version). UI disables the control while a resubmit op exists.

---

## 9. Manual QA checklist

Run against the real server (`npm run build && npm start`). Results recorded in README, not here.

---

## 11. Clarifications received

One request sent. Response confirmed three assumptions already made in §2:

1. Offline shell requires one prior successful visit; first-ever cold load not required.
2. Workers see only their own reports; coordinator sees all server-side submitted reports.
3. Coordinators may operate online only; offline coordinator actions are not required.

---

## 12. Known limitations

- Spoofable identity headers; no authentication.
- Coordinator actions online-only.
- First visit needs network. Service worker needs HTTPS or `localhost`. Module worker needs a current browser.
- Not installable. No manifest, no Background Sync.
- Pull polls all of the worker's own reports; no "changed since" endpoint.
- Server trusts the client-supplied `id` on same-reporter replay; no payload-hash verification.
- Cross-reporter 409 reveals that an ID exists (content is hidden).
- Sequential sync; backoff state is in memory (reload retries immediately).
- `node:sqlite` is flagged experimental by Node.
- No attachments or maps.
- The `created` event from the initial POST has a null `actor_id` — see §14.6.

---

## 13. AI and tool disclosure: summary

Full detail is in the README. Summary for the design record:

| Item | Summary |
|---|---|
| Tools used | Claude (Anthropic) as design reviewer and mentor; a second AI assistant for initial scaffold and milestone plans; Kiro (AI IDE agent) that implemented a large share of the code under direction |
| Used for | Design challenge, this document, sync engine, pull merge, resubmit flow, coordinator view, service worker, most tests |
| Written by the author | `shared/types.ts`, `shared/transitions.ts`, `shared/validation.ts`; architecture and sync decisions in this document |
| Changed or reversed | Edit-after-submit scope, no-service-worker reversed to module SW, history merge changed to UUID-based, resubmit changed to one atomic call, `better-sqlite3` → `node:sqlite`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, non-owner 403 → 404 |
| Rejected | Background Sync, Rejected-to-Draft, batch sync, last-write-wins, npm workspaces, Node 20, Node-22 downgrade, union types instead of `as const` arrays, silent retry on resubmit conflict |

---

## 14. Deviations discovered during the build

### 14.1 `better-sqlite3` → `node:sqlite`

Failed to install on Node 24.14.0 (win32/x64): no prebuilt binary, compiling from source required a C++ toolchain. Downgrading to Node 22 was rejected (contradicts the Node 24 decision). Fix: `node:sqlite`, which needs no native compilation. Tradeoff: Node prints an `ExperimentalWarning` on every start.

### 14.2 Non-owner access: 404, not 403

Changed so a non-owner cannot distinguish "not yours" from "doesn't exist". Existence-and-ownership checked before status in the resubmit endpoint to prevent cross-reporter status inference.

### 14.3 Sequential, not parallel, sync

The original plan allowed different reports to sync in parallel. Shipped engine processes all operations sequentially. Deliberate simplification at the given scale.

### 14.4 `ON CONFLICT(id) DO NOTHING`, not `INSERT OR IGNORE`

`INSERT OR IGNORE` silently skips a row on *any* constraint violation — including `CHECK` and `NOT NULL` failures. `ON CONFLICT(id) DO NOTHING` only skips true duplicate IDs; every other violation still throws and the surrounding transaction rolls back.

### 14.5 Terminal sync failures delete the outbox operation

Earlier plan: keep failed ops queued until user retries. Shipped: delete the op on terminal failure; `retry()` re-inserts a fresh one. This works because the op carries no payload (body is rebuilt from the stored report at send time). It is also necessary for resubmit: a failed resubmit must clear its op so the report becomes resubmittable again.

### 14.6 `actor_id` null on the initial `created` event

The `POST /api/reports` handler's server-generated `created` event uses a 7-column INSERT that omits `actor_id`. The column is therefore NULL for this event in the history timeline. The `status_changed` and `edited` events written by the status-PATCH and resubmit endpoints correctly set `actor_id` from the request identity. This is a known cosmetic gap, not fixed before submission.

### 14.7 Pull merge: failed-operation reports treated like dirty content

Original merge rules named only `content_dirty` as a reason to keep local content while taking server status. A report with a failed resubmit op holds unsent local edits by the same logic and needs identical treatment. Added during M7a.

### 14.8 Module service worker, chosen for testability

A module service worker (`type: 'module'`) was chosen specifically so its request-routing logic could be imported and unit-tested directly as a plain function.

### 14.9 Rejected AI suggestions, for the record

- An AI assistant stated `node:sqlite` was "stable" on Node 24; the module's own `ExperimentalWarning` contradicts this.
- An early suggestion to model `Status` and `Role` as TypeScript union types was rejected in favour of `as const` arrays — union types are erased at runtime and the 72-case exhaustive transition test needs a runtime-iterable list.
