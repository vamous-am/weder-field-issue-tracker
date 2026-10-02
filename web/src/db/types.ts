import type { ReportContent, Status, HistoryAction, Role } from '@shared/types';

export type SyncState = null | 'pending' | 'syncing' | 'synced' | 'failed';

/**
 * A report row as stored in local IndexedDB.
 *
 * Fields that only exist after a server round-trip (version, received_at)
 * are null for drafts. sync_state is null for drafts too — pending/syncing/
 * synced/failed only apply once the report has been submitted (M5 decision).
 *
 */
export interface LocalReport extends ReportContent {
  id: string;
  reporter_id: string;
  status: Status;
  created_at: string;
  updated_at: string;
  /** null until the server echoes the record back */
  received_at: string | null;
  /** null until the server assigns a version */
  version: number | null;
  assigned_to: string | null;
  resolution_notes: string | null;
  sync_state: SyncState;
  /**
   * Send attempts since the last successful/terminal outcome (M6).
   * Non-indexed. Missing values (old rows) read as 0 — never mutate schema.
   */
  attempts: number;
  /** Message from the most recent retryable failure (M6). Non-indexed. */
  last_error: string | null;
  /**
   * True when the worker has edited a rejected report locally but the
   * resubmit op has not yet synced (M7b). Non-indexed — no schema bump.
   * Missing values (old rows) read as undefined → treat as false.
   */
  content_dirty?: boolean;
}

/**
 * A history event row as stored locally.
 *
 * `timestamp` matches ClientEvent.timestamp so no field remapping is needed
 * when uploading in M6.
 *
 * old_value / new_value use string | null (not ?: string) so they survive
 * JSON round-trips without becoming undefined.
 */
export interface LocalHistoryEvent {
  id: string;
  report_id: string;
  action: HistoryAction;
  old_value: string | null;
  new_value: string | null;
  actor_role: Role;
  actor_id: string;
  /** ISO 8601 — when the event occurred on the device */
  timestamp: string;
  /** false until the server acknowledges it */
  uploaded: boolean;
}

/**
 * An outbox row. Carries no payload — the payload is built fresh at send
 * time from the stored report, so expectedVersion and events are always
 * current (Option B, M5 decision).
 */
export interface OutboxOp {
  /** Auto-incremented primary key */
  seq?: number;
  type: 'create' | 'resubmit';
  report_id: string;
  created_at: string;
}
