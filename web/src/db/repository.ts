import type { AppDb } from './schema';
import type { LocalReport, LocalHistoryEvent, OutboxOp } from './types';
import type { ReportContent } from '@shared/types';
import { validateReport } from '@shared/validation';
import { newId as defaultNewId } from './newId';
import type { Identity } from '../identity';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { ok: true; report: LocalReport }
  | { ok: false; kind: 'validation'; errors: string[] }
  | { ok: false; kind: 'storage'; message: string };

// ---------------------------------------------------------------------------
// Dependencies injected so tests can control time and IDs
// ---------------------------------------------------------------------------

export interface RepoDeps {
  now?: () => string;   // returns ISO 8601 string
  newId?: () => string;
}

type DraftFields = Partial<Omit<ReportContent, never>>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRepository(db: AppDb, deps: RepoDeps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? defaultNewId;

  // -------------------------------------------------------------------------
  // createDraft
  // Creates the report + one "created" history event in a single transaction.
  // reporter_id is stamped here and never rewritten.
  // -------------------------------------------------------------------------
  async function createDraft(
    identity: Identity,
    id: string,
    fields: DraftFields = {},
  ): Promise<LocalReport> {
    const ts = now();
    const report: LocalReport = {
      id,
      reporter_id: identity.user_id,
      status: 'draft',
      sync_state: null,
      version: null,
      received_at: null,
      assigned_to: null,
      resolution_notes: null,
      created_at: ts,
      updated_at: ts,
      // M6 sync fields — 0 attempts, no error yet
      attempts: 0,
      last_error: null,
      // ReportContent defaults (all overridable by fields)
      category: 'maintenance',
      description: '',
      location: null,
      lat: null,
      lng: null,
      priority: 'low',
      reported_at: ts,
      ...fields,
    };

    const event: LocalHistoryEvent = {
      id: newId(),
      report_id: id,
      action: 'created',
      old_value: null,
      new_value: null,
      actor_role: identity.role,
      actor_id: identity.user_id,
      timestamp: ts,
      uploaded: false,
    };

    await db.transaction('rw', db.reports, db.reportHistory, async () => {
      await db.reports.add(report);
      await db.reportHistory.add(event);
    });

    return report;
  }

  // -------------------------------------------------------------------------
  // updateDraft
  // Writes the given fields onto the report. Refuses if the report is not an
  // owned draft. No history written — autosave would flood the timeline.
  // -------------------------------------------------------------------------
  async function updateDraft(
    identity: Identity,
    id: string,
    fields: DraftFields,
  ): Promise<LocalReport> {
    return db.transaction('rw', db.reports, async () => {
      const report = await db.reports.get(id);
      if (!report) throw new Error(`Report ${id} not found`);
      if (report.reporter_id !== identity.user_id)
        throw new Error(`Report ${id} is not owned by ${identity.user_id}`);
      if (report.status !== 'draft')
        throw new Error(`Report ${id} is not a draft (status: ${report.status})`);

      const updated: LocalReport = { ...report, ...fields, updated_at: now() };
      await db.reports.put(updated);
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // submitDraft
  // Validates the stored record, then in one transaction:
  //   - moves status to submitted, sync_state to pending
  //   - adds one create outbox row
  // Returns errors without changing anything if validation fails.
  // A second submit returns the report as-is (status check prevents the outbox
  // add; the compound index is defense in depth).
  // -------------------------------------------------------------------------
  async function submitDraft(
    identity: Identity,
    id: string,
  ): Promise<SubmitResult> {
    const report = await db.reports.get(id);
    if (!report) return { ok: false, kind: 'validation', errors: [`Report ${id} not found`] };
    if (report.reporter_id !== identity.user_id)
      return { ok: false, kind: 'validation', errors: [`Report ${id} is not owned by ${identity.user_id}`] };

    // Already submitted — idempotent return, no second outbox row.
    if (report.status !== 'draft') {
      return { ok: true, report };
    }

    const result = validateReport(report);
    if (!result.valid) return { ok: false, kind: 'validation', errors: result.errors };

    const ts = now();
    const submitted: LocalReport = {
      ...report,
      status: 'submitted',
      sync_state: 'pending',
      updated_at: ts,
    };

    const op: OutboxOp = {
      type: 'create',
      report_id: id,
      created_at: ts,
    };

    try {
      await db.transaction('rw', db.reports, db.outbox, async () => {
        // Re-check status inside the transaction — primary double-submit guard.
        const current = await db.reports.get(id);
        if (!current || current.status !== 'draft') return;

        await db.reports.put(submitted);
        await db.outbox.add(op);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: 'storage', message };
    }

    // Read back what was actually written.
    const final = (await db.reports.get(id))!;
    return { ok: true, report: final };
  }

  // -------------------------------------------------------------------------
  // listReports
  // Returns reports owned by the active identity, newest updated_at first.
  // -------------------------------------------------------------------------
  async function listReports(identity: Identity): Promise<LocalReport[]> {
    const rows = await db.reports
      .where('reporter_id')
      .equals(identity.user_id)
      .toArray();
    return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  // -------------------------------------------------------------------------
  // getReport
  // Returns the report if it exists and is owned by the caller.
  // -------------------------------------------------------------------------
  async function getReport(
    identity: Identity,
    id: string,
  ): Promise<LocalReport | undefined> {
    const report = await db.reports.get(id);
    if (!report || report.reporter_id !== identity.user_id) return undefined;
    return report;
  }

  return { createDraft, updateDraft, submitDraft, listReports, getReport };
}
