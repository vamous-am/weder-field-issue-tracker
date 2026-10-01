# Project Decisions

## §1 Identity model

Identity is simulated via two request headers:

- `X-Simulated-Role`: one of `field_worker`, `coordinator`
- `X-Simulated-User`: a non-empty string identifying the caller

Missing or unrecognised headers → 400. Wrong role for an action → 403.

---

## §5 Status transition table

The transition table is the single source of truth for workflow. It lives in
`shared/transitions.ts` and is consumed by the server, tests, and UI alike.

| From        | To          | Actor       | Notes                          |
|-------------|-------------|-------------|--------------------------------|
| draft       | submitted   | field_worker|                                |
| submitted   | assigned    | coordinator | sets `assigned_to = caller`    |
| submitted   | rejected    | coordinator | requires `resolution_notes`    |
| assigned    | in_progress | coordinator |                                |
| assigned    | rejected    | coordinator | requires `resolution_notes`    |
| in_progress | resolved    | coordinator | requires `resolution_notes`    |
| in_progress | rejected    | coordinator | requires `resolution_notes`    |
| resolved    | in_progress | coordinator | requires reopen reason (event only) |
| rejected    | submitted   | field_worker| via `/resubmit` endpoint only  |

Same-state transitions are always invalid. `assigned → submitted` is absent by
design — unassignment is not a supported coordinator action.

---

## §6 Reopen reason

A `resolved → in_progress` reason is transition metadata. It is stored **only**
in the `status_changed` history event as `new_value.reason`. It does **not**
overwrite `reports.resolution_notes`.

The request body uses `resolution_notes` as the input field for compatibility
with the status endpoint shape.

Example event:

```json
{
  "action": "status_changed",
  "old_value": "{\"status\":\"resolved\"}",
  "new_value": "{\"status\":\"in_progress\",\"reason\":\"The pump is leaking again.\"}"
}
```

The stored `reports.resolution_notes` (e.g. `"Pump seal replaced."`) is left
unchanged.

---

## §7 Assignment

A coordinator assigning a submitted report assigns it to the caller's
`X-Simulated-User` identity. The request body does not accept an `assignee`
field; any `assigned_to` in the body is ignored.

Result of `submitted → assigned`:

```
assigned_to = req.identity.userId
```

---

## §8 Rejection clears assignment

Any transition into `rejected` clears `assigned_to`, including:

- `submitted → rejected`
- `assigned → rejected`
- `in_progress → rejected`

A rejected report is no longer actively assigned. Its rejection reason is
preserved in the report's `resolution_notes` field and in the `status_changed`
history event as `new_value.reason`.

---

## §9 Required notes matrix

| Transition              | Input field        | Stored in report column | Stored in event                |
|-------------------------|--------------------|-------------------------|--------------------------------|
| Any → rejected          | `resolution_notes` | `resolution_notes`      | `new_value.reason`             |
| in_progress → resolved  | `resolution_notes` | `resolution_notes`      | `new_value.reason`             |
| resolved → in_progress  | `resolution_notes` | _(unchanged)_           | `new_value.reason`             |

---

## §10 Optimistic concurrency (CAS)

Every write uses a compare-and-swap pattern:

```sql
UPDATE reports
SET status = ?, assigned_to = ?, resolution_notes = ?,
    updated_at = ?, version = version + 1
WHERE id = ? AND version = ?;
```

The client sends the `version` it last observed in `expectedVersion`. If the
affected-row count is zero the client has stale state and must re-fetch the
canonical report before retrying. The server returns 409.

---

## §11 Resubmission field whitelist

Only these fields may be merged during `POST /resubmit`:

```
category, description, location, lat, lng, priority, reported_at
```

All other fields (`status`, `reporter_id`, `id`, `version`, `created_at`,
`received_at`, `updated_at`, `assigned_to`, `resolution_notes`) are silently
ignored. A successful resubmission always:

- Sets `status = submitted`
- Clears `assigned_to`
- Clears `resolution_notes`
- Increments `version` once

---

## §12 Event ordering in resubmission

For a resubmit that changes content:

1. `edited` — diff of accepted content fields
2. `status_changed` — `rejected → submitted`

Both events share one timestamp. If no accepted field changes, the `edited`
event is omitted and only `status_changed` is inserted.

---

## §13 Non-owner / unknown report response

`POST /resubmit` returns the same 404 for a non-owner as for an unknown report,
so the API does not reveal whether another worker's report exists.
