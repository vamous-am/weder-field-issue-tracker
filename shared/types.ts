// Domain enums and shared types for the field issue tracker

export const STATUSES = [
  'draft',
  'submitted',
  'assigned',
  'in_progress',
  'resolved',
  'rejected',
] as const;

export type Status = (typeof STATUSES) [number];

//  source of truth for roles.
export const ROLES = ['field_worker', 'coordinator'] as const;
export type Role = (typeof ROLES) [number];

//  source of truth for categories.
export const CATEGORIES = [ 'water_point', 'equipment', 'service_interruption', 'safety', 'maintenance'] as const;
export type Category = typeof CATEGORIES[number];

//  source of truth for priorities.
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Priority = typeof PRIORITIES[number];

export const HISTORY_ACTIONS = [
  'created',
  'edited',
  'synced',
  'sync_failed',
  'status_changed',
] as const;
export type HistoryAction = typeof HISTORY_ACTIONS[number];

/** Actions the client may upload. status_changed is server-only. */
export const CLIENT_UPLOADABLE_ACTIONS = HISTORY_ACTIONS.filter(
  (a) => a !== 'status_changed',
) as readonly Exclude<HistoryAction, 'status_changed'>[];

export interface ReportContent {
  category: Category;
  description: string;
  /** Free-text location. Null when the report locates the issue by coordinates only. */
  location: string | null;
  /** Coordinates. Null when absent; validated range when present. */
  lat: number | null;
  lng: number | null;
  priority: Priority;
  /**
   * When the field worker observed the issue (user-entered, §2 row 4).
   * Validated as a canonical ISO 8601 string: new Date(s).toISOString() === s.
   * The client defaults this to creation time in the form.
   */
  reported_at: string;
}
