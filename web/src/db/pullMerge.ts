/**
 * Pure merge functions for M7a pull sync.
 *
 * Design constraints (from spec):
 * - Network calls cannot happen inside a Dexie transaction.
 * - All fetches must complete BEFORE the transaction that writes merged state.
 * - hasOutboxOp must be read INSIDE the transaction (not before), so the
 *   caller passes it in from inside the rw transaction.
 * - mergeServerReport and mergeEvents are both pure: no DB access, no side
 *   effects, deterministic output.
 */

import type { LocalReport, LocalHistoryEvent } from './types';
import type { Status } from '@shared/types';

// ── Wire shapes (what the server sends) ──────────────────────────────────────

/** A row from GET /api/reports or GET /api/reports/:id */
export interface ServerReportRow {
  id: string;
  reporter_id: string;
  status: Status;
  version: number;
  category: string;
  description: string;
  location: string | null;
  lat: number | null;
  lng: number | null;
  priority: string;
  reported_at: string;
  assigned_to: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
  received_at: string;
}

/** A history event row from GET /api/reports/:id */
export interface ServerEventRow {
  id: string;
  report_id: string;
  action: string;
  old_value: string | null;
  new_value: string | null;
  actor_role: string;
  actor_id: string | null;
  timestamp: string;
}

// ── mergeEvents ───────────────────────────────────────────────────────────────

/**
 * Merge local and server event arrays by UUID.
 *
 * Rules (§M7a):
 * - Server events are authoritative: if a UUID exists on the server, the
 *   server's copy wins (action, values, timestamp, actor fields).
 * - Local events not on the server are kept with uploaded=false.
 * - No duplicates: each UUID appears exactly once in the output.
 * - A local sync_failed event (never uploadable) always survives.
 *
 * The report_id on server events may differ from the local row if the
 * server normalises it; we preserve the local report_id to avoid orphaning.
 */
export function mergeEvents(
  localEvents: LocalHistoryEvent[],
  serverEvents: ServerEventRow[],
  reportId: string,
): LocalHistoryEvent[] {
  const serverById = new Map(serverEvents.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const result: LocalHistoryEvent[] = [];

  // First pass: local events, replaced by server copy when the UUID matches.
  for (const local of localEvents) {
    seen.add(local.id);
    const sv = serverById.get(local.id);
    if (sv) {
      // Server wins on all fields except uploaded (mark true since server has it).
      result.push({
        id: sv.id,
        report_id: reportId,
        action: sv.action as LocalHistoryEvent['action'],
        old_value: sv.old_value,
        new_value: sv.new_value,
        actor_role: (sv.actor_role ?? 'field_worker') as LocalHistoryEvent['actor_role'],
        actor_id: sv.actor_id ?? local.actor_id,
        timestamp: sv.timestamp,
        uploaded: true,
      });
    } else {
      // Local-only: keep as-is (uploaded stays false, sync_failed events survive).
      result.push(local);
    }
  }

  // Second pass: server events not already in local set → insert as uploaded.
  for (const sv of serverEvents) {
    if (!seen.has(sv.id)) {
      result.push({
        id: sv.id,
        report_id: reportId,
        action: sv.action as LocalHistoryEvent['action'],
        old_value: sv.old_value,
        new_value: sv.new_value,
        actor_role: (sv.actor_role ?? 'field_worker') as LocalHistoryEvent['actor_role'],
        actor_id: sv.actor_id ?? '',
        timestamp: sv.timestamp,
        uploaded: true,
      });
    }
  }

  // Sort chronologically so the timeline is correct.
  result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return result;
}

// ── mergeServerReport ─────────────────────────────────────────────────────────

/**
 * Merge a server report row into the local record.
 *
 * Rules (§6 + §M7a gap):
 *
 * 1. pending or syncing op  → skip entirely (return local unchanged).
 * 2. failed op or content_dirty → take server's status/version/assigned_to/
 *    resolution_notes; keep local content fields.
 * 3. local draft → untouched (return local unchanged).
 * 4. server-only (no local) → insert as synced, content_dirty=false.
 * 5. otherwise → server wins on all fields; client-only fields
 *    (sync_state, attempts, last_error, content_dirty) are always preserved.
 *
 * `hasOutboxOp` MUST be read inside the caller's rw transaction to avoid a
 * race where a submit lands between the pre-transaction read and the write.
 *
 * @param local         The current local record, or null if server-only.
 * @param server        The authoritative server row.
 * @param hasOutboxOp   Whether the report currently has a pending/sincing outbox op.
 * @returns             The record to write, or null to skip (rule 1 / rule 3).
 */
export function mergeServerReport(
  local: LocalReport | null,
  server: ServerReportRow,
  hasOutboxOp: boolean,
): LocalReport | null {
  // Rule 4: server-only insert.
  if (local === null) {
    return {
      id: server.id,
      reporter_id: server.reporter_id,
      status: server.status,
      version: server.version,
      category: server.category as LocalReport['category'],
      description: server.description,
      location: server.location,
      lat: server.lat,
      lng: server.lng,
      priority: server.priority as LocalReport['priority'],
      reported_at: server.reported_at,
      assigned_to: server.assigned_to,
      resolution_notes: server.resolution_notes,
      created_at: server.created_at,
      updated_at: server.updated_at,
      received_at: server.received_at,
      sync_state: 'synced',
      attempts: 0,
      last_error: null,
      content_dirty: false,
    };
  }

  // Rule 3: drafts are untouched.
  if (local.status === 'draft') return null;

  // Rule 1: pending or syncing op → skip.
  if (hasOutboxOp) return null;

  // Rule 2: failed op or content_dirty → server metadata, local content.
  if (local.sync_state === 'failed' || local.content_dirty) {
    return {
      ...local,
      status: server.status,
      version: server.version,
      assigned_to: server.assigned_to,
      resolution_notes: server.resolution_notes,
      updated_at: server.updated_at,
      received_at: server.received_at,
    };
  }

  // Rule 5: server wins, client-only fields preserved.
  return {
    id: server.id,
    reporter_id: server.reporter_id,
    status: server.status,
    version: server.version,
    category: server.category as LocalReport['category'],
    description: server.description,
    location: server.location,
    lat: server.lat,
    lng: server.lng,
    priority: server.priority as LocalReport['priority'],
    reported_at: server.reported_at,
    assigned_to: server.assigned_to,
    resolution_notes: server.resolution_notes,
    created_at: server.created_at,
    updated_at: server.updated_at,
    received_at: server.received_at,
    // Preserve client-only fields.
    sync_state: local.sync_state,
    attempts: local.attempts,
    last_error: local.last_error,
    content_dirty: local.content_dirty,
  };
}
