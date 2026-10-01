import { CLIENT_UPLOADABLE_ACTIONS } from './types';
import type { HistoryAction } from './types';

const MAX_EVENTS = 50;

/**
 * Shape of a client-supplied history event.
 * The server stamps report_id, actor_role and actor_id at insert time,
 * so the client only needs to supply these four fields.
 */
export interface ClientEvent {
  id: string;
  action: Exclude<HistoryAction, 'status_changed'>;
  /** ISO 8601 — when the event occurred on the device. */
  timestamp: string;
  old_value?: string | null;
  new_value?: string | null;
}

export interface EventValidationError {
  index: number;
  field: string;
  message: string;
}

export type EventsValidationResult =
  | { valid: true; value: ClientEvent[] }
  | { valid: false; errors: EventValidationError[] };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isISOString(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { return new Date(s).toISOString() === s; } catch { return false; }
}

/**
 * Validates an optional client-supplied events array.
 * - If input is undefined/null/absent, returns { valid: true, value: [] }.
 * - Rejects non-arrays, arrays over 50, and any item with a bad id, a
 *   server-only action (status_changed), a bad timestamp, or wrong value types.
 * - Errors are indexed: events[2].id: … so the client can surface them.
 */
export function validateEvents(input: unknown): EventsValidationResult {
  if (input === undefined || input === null) {
    return { valid: true, value: [] };
  }

  if (!Array.isArray(input)) {
    return {
      valid: false,
      errors: [{ index: -1, field: 'events', message: 'events must be an array' }],
    };
  }

  if (input.length > MAX_EVENTS) {
    return {
      valid: false,
      errors: [{
        index: -1,
        field: 'events',
        message: `events must contain at most ${MAX_EVENTS} items`,
      }],
    };
  }

  const errors: EventValidationError[] = [];
  const validated: ClientEvent[] = [];

  for (let i = 0; i < input.length; i++) {
    const item = input[i] as Record<string, unknown>;

    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ index: i, field: 'events', message: 'each event must be an object' });
      continue;
    }

    // id — UUID v4
    if (typeof item.id !== 'string' || !UUID_RE.test(item.id)) {
      errors.push({ index: i, field: 'id', message: `events[${i}].id must be a valid UUID v4` });
    }

    // action — client-uploadable only
    if (
      typeof item.action !== 'string' ||
      !(CLIENT_UPLOADABLE_ACTIONS as readonly string[]).includes(item.action)
    ) {
      const allowed = CLIENT_UPLOADABLE_ACTIONS.join(', ');
      errors.push({
        index: i,
        field: 'action',
        message: `events[${i}].action must be one of: ${allowed}`,
      });
    }

    // timestamp — canonical ISO 8601
    if (!isISOString(item.timestamp)) {
      errors.push({
        index: i,
        field: 'timestamp',
        message: `events[${i}].timestamp must be a canonical ISO 8601 string`,
      });
    }

    // old_value / new_value — string, null, or absent
    for (const field of ['old_value', 'new_value'] as const) {
      const v = item[field];
      if (v !== undefined && v !== null && typeof v !== 'string') {
        errors.push({
          index: i,
          field,
          message: `events[${i}].${field} must be a string or null`,
        });
      }
    }

    if (errors.length === 0 || errors.every((e) => e.index !== i)) {
      validated.push({
        id: item.id as string,
        action: item.action as ClientEvent['action'],
        timestamp: item.timestamp as string,
        old_value: (item.old_value as string | null | undefined) ?? null,
        new_value: (item.new_value as string | null | undefined) ?? null,
      });
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: validated };
}
