import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateReport } from '@shared/validation';
import { validateEvents } from '@shared/events';
import { STATUSES } from '@shared/types';
import { isValidTransition } from '@shared/transitions';
import { requireIdentity, requireRole } from './identity.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from './errors.js';
import { runInTransaction } from './db.js';
import type { Database } from './db.js';
import type { Status } from '@shared/types';
import type { Identity } from './identity.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReportRow {
  id: string;
  reporter_id: string;
  status: Status;
  version: number;
  assigned_to: string | null;
  resolution_notes: string | null;
  [key: string]: unknown;
}

// Fields a field_worker may update via /resubmit (§11).
const WHITELIST_KEYS = [
  'category', 'description', 'location', 'lat', 'lng', 'priority', 'reported_at',
] as const;

// ── applyStatusChange ─────────────────────────────────────────────────────────
// Executes the CAS UPDATE + status_changed event INSERT in one transaction.
// Throws conflict() if the CAS row count is zero.

interface ApplyStatusChangeArgs {
  report: ReportRow;
  to: Status;
  notes: string;          // trimmed; empty string when not required
  identity: Identity;
  expectedVersion: number;
}

function applyStatusChange(db: Database, args: ApplyStatusChangeArgs): ReportRow {
  const { report, to, notes, identity, expectedVersion } = args;
  const now = new Date().toISOString();
  const from = report.status;

  // Calculate side-effects
  let assignedTo: string | null = report.assigned_to;
  let resolutionNotes: string | null = report.resolution_notes;

  if (to === 'assigned') {
    assignedTo = identity.userId;
    // resolution_notes unchanged
  } else if (to === 'rejected') {
    assignedTo = null;            // §8: rejection always clears assignment
    resolutionNotes = notes;
  } else if (to === 'resolved') {
    resolutionNotes = notes;
    // assigned_to unchanged
  } else if (from === 'resolved' && to === 'in_progress') {
    // §6: reopen — do NOT overwrite resolution_notes; notes go to event only
    // assigned_to unchanged
  }

  // Build event values
  const oldValue = JSON.stringify({ status: from });
  const newValueObj: Record<string, string> = { status: to };
  if (to === 'rejected' || to === 'resolved' || (from === 'resolved' && to === 'in_progress')) {
    newValueObj.reason = notes;
  }
  const newValue = JSON.stringify(newValueObj);

  let updatedReport: ReportRow | undefined;

  runInTransaction(db, () => {
    const result = db.prepare(`
      UPDATE reports
      SET status = ?, assigned_to = ?, resolution_notes = ?,
          updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?
    `).run(to, assignedTo, resolutionNotes, now, report.id, expectedVersion);

    if ((result as { changes: number }).changes === 0) {
      throw conflict('Version conflict: expectedVersion does not match current version');
    }

    db.prepare(`
      INSERT INTO report_history
        (id, report_id, action, old_value, new_value, actor_role, actor_id, timestamp)
      VALUES (?, ?, 'status_changed', ?, ?, ?, ?, ?)
    `).run(randomUUID(), report.id, oldValue, newValue, identity.role, identity.userId, now);

    updatedReport = db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id) as ReportRow;
  });

  return updatedReport!;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUUID(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

function isISOString(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try { return new Date(s).toISOString() === s; } catch { return false; }
}

export function createReportsRouter(db: Database): Router {
  const router = Router();
  router.use(requireIdentity);

  // ── POST / ─────────────────────────────────────────────────────────────────
  // field_worker only. Check order per §M3:
  //   1. identity + role (handled by middleware above)
  //   2. id is a valid UUID, status is absent or 'submitted'
  //   3. existing-id lookup → 200 (same reporter) or 409 (different reporter)
  //   4. validateReport, validateEvents
  //   5. runInTransaction: insert report + events
  router.post('/', requireRole('field_worker'), (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;

      // ── 2. Basic shape ───────────────────────────────────────────────────
      if (!isUUID(body.id)) {
        return next(unprocessable('id must be a valid UUID v4', ['id must be a valid UUID v4']));
      }

      if (body.status !== undefined && body.status !== 'submitted') {
        return next(
          unprocessable('status must be \'submitted\' or omitted — server sets status on create'),
        );
      }

      if (!isISOString(body.reported_at)) {
        return next(
          unprocessable('reported_at must be a canonical ISO 8601 string (e.g. new Date().toISOString())'),
        );
      }
      if (!isISOString(body.created_at)) {
        return next(
          unprocessable('created_at must be a canonical ISO 8601 string (e.g. new Date().toISOString())'),
        );
      }

      // ── 3. Idempotency check ─────────────────────────────────────────────
      const existing = db
        .prepare('SELECT reporter_id FROM reports WHERE id = ?')
        .get(body.id as string) as { reporter_id: string } | undefined;

      if (existing) {
        if (existing.reporter_id !== req.identity.userId) {
          // Different reporter: refuse without leaking the stored record (§M3).
          // ponytail: UUID collision is practically impossible; this is a
          // safety backstop. Document as accepted risk in §14.
          return next(conflict('Report ID already exists'));
        }
        // Same reporter: idempotent replay — return the stored record.
        const report = db
          .prepare('SELECT * FROM reports WHERE id = ?')
          .get(body.id as string);
        const events = db
          .prepare('SELECT * FROM report_history WHERE report_id = ? ORDER BY timestamp ASC')
          .all(body.id as string);
        return res.status(200).json({ report, events });
      }

      // ── 4. Content + events validation ───────────────────────────────────
      const contentResult = validateReport(body);
      if (!contentResult.valid) {
        return next(unprocessable('Report content is invalid', contentResult.errors));
      }

      const eventsResult = validateEvents(body.events);
      if (!eventsResult.valid) {
        return next(
          unprocessable(
            'Invalid events',
            eventsResult.errors.map((e) => e.message),
          ),
        );
      }

      const { category, description, location, lat, lng, priority, reported_at } =
        contentResult.value;
      const now = new Date().toISOString();
      const reporterId = req.identity.userId;
      const clientEvents = eventsResult.value;

      // ── 5. Transaction: insert report + events ───────────────────────────
      const insertReport = db.prepare(`
        INSERT INTO reports
          (id, reporter_id, category, description, location, lat, lng,
           priority, status, reported_at, created_at, received_at,
           updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, 1)
      `);

      // ON CONFLICT(id) DO NOTHING skips only duplicate PK, unlike OR IGNORE
      // which would also swallow CHECK/NOT NULL violations (§M3 decision).
      const insertEvent = db.prepare(`
        INSERT INTO report_history (id, report_id, action, old_value, new_value, actor_role, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `);

      // Determine the server-added 'created' event.
      // If the client sent one, use it. Otherwise add one timestamped now.
      const hasClientCreated = clientEvents.some((e) => e.action === 'created');
      const serverCreatedEvent = hasClientCreated
        ? null
        : { id: randomUUID(), action: 'created' as const, timestamp: now };

      const allEvents = [
        ...(serverCreatedEvent ? [serverCreatedEvent] : []),
        ...clientEvents,
      ];

      runInTransaction(db, () => {
        insertReport.run(
          body.id as string,
          reporterId,
          category,
          description,
          location ?? null,
          lat ?? null,
          lng ?? null,
          priority,
          reported_at,
          body.created_at as string,
          now,  // received_at
          now,  // updated_at
        );

        for (const ev of allEvents) {
          insertEvent.run(
            'id' in ev ? ev.id : randomUUID(),
            body.id as string,
            ev.action,
            ('old_value' in ev ? ev.old_value : null) ?? null,
            ('new_value' in ev ? ev.new_value : null) ?? null,
            req.identity.role,
            ev.timestamp,
          );
        }
      });

      const report = db
        .prepare('SELECT * FROM reports WHERE id = ?')
        .get(body.id as string);
      const storedEvents = db
        .prepare('SELECT * FROM report_history WHERE report_id = ? ORDER BY timestamp ASC')
        .all(body.id as string);

      res.status(201).json({ report, events: storedEvents });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /:id/resubmit ────────────────────────────────────────────────────
  // field_worker only. Validation order per §M4:
  //   1. identity (middleware)
  //   2. role = field_worker           → 403
  //   3. report exists AND belongs to caller → 404 (same for both, §13)
  //   4. current status is rejected    → 409
  //   5. expectedVersion matches       → 409
  //   6. merge whitelisted fields only
  //   7. validate merged result        → 422
  //   8. validate client events        → 422
  //   9. atomic update + history       → commit
  router.post('/:id/resubmit', requireRole('field_worker'), (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;

      // 2. expectedVersion present + integer (body-level check before DB hit)
      const ev = body.expectedVersion;
      if (typeof ev !== 'number' || !Number.isInteger(ev)) {
        return next(badRequest('body.expectedVersion must be an integer'));
      }

      // 3. report exists and belongs to caller (identical 404 for both cases)
      const report = db
        .prepare('SELECT * FROM reports WHERE id = ?')
        .get(req.params.id) as ReportRow | undefined;

      if (!report || report.reporter_id !== req.identity.userId) {
        return next(notFound('Report not found'));
      }

      // 4. current status must be rejected
      if (report.status !== 'rejected') {
        return next(conflict('Report must be in rejected status to resubmit'));
      }

      // 5. CAS version check (pre-flight — final enforcement is in the UPDATE)
      if (report.version !== ev) {
        return next(conflict('Version conflict: expectedVersion does not match current version'));
      }

      // 6. merge whitelisted fields only
      const incoming = (body.fields !== null && typeof body.fields === 'object' && !Array.isArray(body.fields))
        ? body.fields as Record<string, unknown>
        : {};
      const merged: Record<string, unknown> = { ...report };
      for (const key of WHITELIST_KEYS) {
        if (Object.prototype.hasOwnProperty.call(incoming, key)) {
          merged[key] = incoming[key];
        }
      }

      // 7. validate merged result as a submitted report
      const contentResult = validateReport(merged);
      if (!contentResult.valid) {
        return next(unprocessable('Merged report content is invalid', contentResult.errors));
      }

      // 8. validate client events
      const eventsResult = validateEvents(body.events);
      if (!eventsResult.valid) {
        return next(
          unprocessable('Invalid events', eventsResult.errors.map((e) => e.message)),
        );
      }

      const { category, description, location, lat, lng, priority, reported_at } =
        contentResult.value;
      const clientEvents = eventsResult.value;
      const now = new Date().toISOString();

      // 9. atomic update + history
      const insertEvent = db.prepare(`
        INSERT INTO report_history
          (id, report_id, action, old_value, new_value, actor_role, actor_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `);

      runInTransaction(db, () => {
        // CAS update — clears assignment + notes, bumps version
        const result = db.prepare(`
          UPDATE reports
          SET category = ?, description = ?, location = ?, lat = ?, lng = ?,
              priority = ?, reported_at = ?,
              status = 'submitted',
              assigned_to = NULL,
              resolution_notes = NULL,
              updated_at = ?,
              version = version + 1
          WHERE id = ? AND version = ?
        `).run(
          category, description, location ?? null, lat ?? null, lng ?? null,
          priority, reported_at, now,
          report.id, ev,
        );

        if ((result as { changes: number }).changes === 0) {
          throw conflict('Version conflict: expectedVersion does not match current version');
        }

        // edited event — only if any whitelisted field actually changed
        const changed = WHITELIST_KEYS.filter(
          (k) => String(report[k] ?? '') !== String(merged[k] ?? ''),
        );
        if (changed.length > 0) {
          const oldDiff: Record<string, unknown> = {};
          const newDiff: Record<string, unknown> = {};
          for (const k of changed) {
            oldDiff[k] = report[k];
            newDiff[k] = merged[k];
          }
          insertEvent.run(
            randomUUID(), report.id, 'edited',
            JSON.stringify(oldDiff), JSON.stringify(newDiff),
            req.identity.role, req.identity.userId, now,
          );
        }

        // status_changed event: rejected → submitted
        insertEvent.run(
          randomUUID(), report.id, 'status_changed',
          JSON.stringify({ status: 'rejected' }),
          JSON.stringify({ status: 'submitted' }),
          req.identity.role, req.identity.userId, now,
        );

        // client events — idempotent
        for (const ce of clientEvents) {
          insertEvent.run(
            'id' in ce ? ce.id : randomUUID(),
            report.id,
            ce.action,
            ('old_value' in ce ? ce.old_value : null) ?? null,
            ('new_value' in ce ? ce.new_value : null) ?? null,
            req.identity.role,
            req.identity.userId,
            ce.timestamp,
          );
        }
      });

      const updated = db.prepare('SELECT * FROM reports WHERE id = ?').get(report.id);
      const events = db
        .prepare('SELECT * FROM report_history WHERE report_id = ? ORDER BY timestamp ASC, rowid ASC')
        .all(report.id);

      res.json({ report: updated, events });
    } catch (err) {
      next(err);
    }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  router.get('/', (req, res, next) => {
    try {
      const { role, userId } = req.identity;

      if (role === 'coordinator') {
        const reports = db.prepare('SELECT * FROM reports').all();
        return res.json({ reports });
      }

      const reporter = req.query['reporter'];
      if (reporter === undefined) {
        return next(forbidden('field_worker must supply ?reporter=me'));
      }
      if (reporter !== 'me') {
        return next(badRequest("reporter query param must be 'me'"));
      }

      const reports = db
        .prepare('SELECT * FROM reports WHERE reporter_id = ?')
        .all(userId);
      return res.json({ reports });
    } catch (err) {
      next(err);
    }
  });

  // ── PATCH /:id/status ─────────────────────────────────────────────────────
  // coordinator only. Validation order per §M4:
  //   1. identity (middleware)      → 400
  //   2. role = coordinator         → 403
  //   3. body is plain object       → 400
  //   4. body.to is a known status  → 400
  //   5. body.expectedVersion is integer → 400
  //   6. report exists              → 404
  //   7. transition is legal        → 409
  //   8. required notes present     → 422
  //   9. CAS update                 → 409
  router.patch('/:id/status', requireRole('coordinator'), (req, res, next) => {
    try {
      const body = req.body;

      // 3. plain object
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return next(badRequest('Request body must be a JSON object'));
      }

      // 4. known status
      if (!STATUSES.includes(body.to as Status)) {
        return next(badRequest(`body.to must be one of: ${STATUSES.join(', ')}`));
      }
      const to = body.to as Status;

      // 5. integer expectedVersion
      const ev = body.expectedVersion;
      if (typeof ev !== 'number' || !Number.isInteger(ev)) {
        return next(badRequest('body.expectedVersion must be an integer'));
      }

      // 6. report exists
      const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id) as ReportRow | undefined;
      if (!report) return next(notFound('Report not found'));

      // 7. legal transition for coordinator
      if (!isValidTransition(report.status, to, 'coordinator')) {
        return next(conflict(`Transition ${report.status} → ${to} is not allowed for coordinator`));
      }

      // 8. required notes
      const rawNotes = typeof body.resolution_notes === 'string' ? body.resolution_notes.trim() : '';
      const needsNotes =
        to === 'rejected' ||
        to === 'resolved' ||
        (report.status === 'resolved' && to === 'in_progress');

      if (needsNotes && rawNotes.length === 0) {
        return next(unprocessable('resolution_notes is required for this transition'));
      }

      // 9. CAS update + event — atomically
      const updated = applyStatusChange(db, { report, to, notes: rawNotes, identity: req.identity, expectedVersion: ev });
      res.json({ report: updated });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /:id ───────────────────────────────────────────────────────────────
  router.get('/:id', (req, res, next) => {
    try {
      const { role, userId } = req.identity;
      const report = db
        .prepare('SELECT * FROM reports WHERE id = ?')
        .get(req.params.id);

      if (!report) return next(notFound('Report not found'));

      const row = report as { reporter_id: string };
      if (role === 'field_worker' && row.reporter_id !== userId) {
        return next(notFound('Report not found'));
      }

      const events = db
        .prepare('SELECT * FROM report_history WHERE report_id = ? ORDER BY timestamp ASC')
        .all(req.params.id);

      res.json({ report, events });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
