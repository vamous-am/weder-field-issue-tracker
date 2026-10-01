// The table below IS the workflow: the README table, the UI action gating
// and the server enforcement all derive from it, so they cannot drift apart.

import type { Role, Status } from './types';

/** One legal move out of a status: to which status, performed by which role. */
export interface Transition {
  readonly to: Status;
  readonly role: Role;
}

/**
 * Every legal transition, keyed by the status it moves out of.
 *
 * Deliberate absences (each pinned by a test):
 * - Same-state transitions never appear (§5: "same-state transitions are invalid").
 * - `rejected → draft` is absent by design (§2.6): a rejected report already
 *   exists server-side; resetting to draft would make it synced and
 *   local-only at once and would erase the rejection from history.
 * - `draft → submitted` is field_worker only (§5) — coordinators never submit.
 */
export const TRANSITIONS: Readonly<Record<Status, readonly Transition[]>> = {
  draft: [{ to: 'submitted', role: 'field_worker' }],
  submitted: [
    { to: 'assigned', role: 'coordinator' },
    { to: 'rejected', role: 'coordinator' },
  ],
  assigned: [
    { to: 'in_progress', role: 'coordinator' },
    { to: 'rejected', role: 'coordinator' },
  ],
  in_progress: [
    { to: 'resolved', role: 'coordinator' },
    { to: 'rejected', role: 'coordinator' },
  ],
  resolved: [{ to: 'in_progress', role: 'coordinator' }],
  rejected: [{ to: 'submitted', role: 'field_worker' }],
};

// Flat lookup set derived from the table: `from|to|role` keys.
const FLAT: ReadonlySet<string> = new Set(
  Object.entries(TRANSITIONS).flatMap(([from, moves]) =>
    moves.map((m) => `${from}|${m.to}|${m.role}`),
  ),
);

/**
 * Whether `role` may move a report from status `current` to status `next`.
 * A lookup into TRANSITIONS, so unknown statuses/roles (and non-strings)
 * are simply not in the set: false, never a crash.
 *
 * Internal, type-safe check (Status, Status, Role). Callers with static
 * types use this: tests, UI gating, and the TRANSITIONS table itself.
 */
export function isValidTransition(
  current: Status,
  next: Status,
  role: Role,
): boolean {
  return FLAT.has(`${current}|${next}|${role}`);
}

/**
 * Boundary check for the API surface: HTTP body values arrive as `unknown`,
 * so operational values must be structurally validated before the table lookup.
 * Returns false (never throws) for anything that is not a string triple,
 * mirroring the server's reject-on-unknown behavior.
 */
export function isValidTransitionRequest(
  current: unknown,
  next: unknown,
  role: unknown,
): boolean {
  if (typeof current !== 'string' || typeof next !== 'string' || typeof role !== 'string') {
    return false;
  }
  return isValidTransition(current as Status, next as Status, role as Role);
}

/**
 * Statuses `from` may legally move to when acted on by `role`, in table order.
 * The UI uses this to hide or disable action buttons (§5).
 */
export function allowedTransitions(from: Status, role: Role): readonly Status[] {
  return TRANSITIONS[from].filter((t) => t.role === role).map((t) => t.to);
}
