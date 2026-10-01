import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateReport } from '@shared/validation';
import { validateEvents } from '@shared/events';
import { requireIdentity, requireRole } from './identity.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from './errors.js';
import { runInTransaction } from './db.js';
import type { Database } from './db.js';

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
