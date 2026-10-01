import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { validateReport } from '@shared/validation';
import { requireIdentity, requireRole } from './identity.js';
import { badRequest, forbidden, notFound, unprocessable } from './errors.js';
import { runInTransaction } from './db.js';
import type { Database } from './db.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUUID(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Strict ISO 8601 round-trip check — same rule as validateReport. */
function isISOString(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    return new Date(s).toISOString() === s;
  } catch {
    return false;
  }
}

export function createReportsRouter(db: Database): Router {
  const router = Router();
  router.use(requireIdentity);

  // ── POST / ─────────────────────────────────────────────────────────────────
  // field_worker only. Validates content, rejects any status other than
  // submitted or absent. Server sets status = submitted, version = 1.
  router.post('/', requireRole('field_worker'), (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;

      // id — required, must be a UUID (doubles as idempotency key, §6)
      if (!isUUID(body.id)) {
        return next(unprocessable('id must be a valid UUID v4', ['id must be a valid UUID v4']));
      }

      // status — reject anything other than 'submitted' or absent (§2.5, §Q1)
      if (body.status !== undefined && body.status !== 'submitted') {
        return next(
          unprocessable(
            `status must be 'submitted' or omitted — server sets status on create`,
          ),
        );
      }

      // timestamps — client must supply both (§4, Q1 discussion)
      if (!isISOString(body.reported_at)) {
        return next(
          unprocessable(
            'reported_at must be a canonical ISO 8601 string (e.g. new Date().toISOString())',
          ),
        );
      }
      if (!isISOString(body.created_at)) {
        return next(
          unprocessable(
            'created_at must be a canonical ISO 8601 string (e.g. new Date().toISOString())',
          ),
        );
      }

      // content validation (§2.11)
      const validation = validateReport(body);
      if (!validation.valid) {
        return next(unprocessable('Report content is invalid', validation.errors));
      }

      const { category, description, location, lat, lng, priority, reported_at } =
        validation.value;
      const now = new Date().toISOString();
      const reporterId = req.identity.userId;
      const historyId = randomUUID();

      // Insert report + created history event in one transaction (§3, §4).
      // node:sqlite rejects undefined bind parameters — use null explicitly.
      const insert = db.prepare(`
        INSERT INTO reports
          (id, reporter_id, category, description, location, lat, lng,
           priority, status, reported_at, created_at, received_at,
           updated_at, version)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, 1)
      `);

      const insertHistory = db.prepare(`
        INSERT INTO report_history
          (id, report_id, action, old_value, new_value, actor_role, timestamp)
        VALUES (?, ?, 'created', NULL, NULL, ?, ?)
      `);

      runInTransaction(db, () => {
        insert.run(
          body.id as string,
          reporterId,
          category,
          description,
          location ?? null,   // TEXT nullable
          lat ?? null,        // REAL nullable
          lng ?? null,        // REAL nullable
          priority,
          reported_at,
          body.created_at as string,
          now, // received_at
          now, // updated_at
        );
        insertHistory.run(historyId, body.id as string, req.identity.role, now);
      });

      const report = db
        .prepare('SELECT * FROM reports WHERE id = ?')
        .get(body.id as string);

      res.status(201).json({ report, events: [{ id: historyId }] });
    } catch (err) {
      next(err);
    }
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  // Coordinator: all reports.
  // field_worker: must supply ?reporter=me, anything else → 400/403.
  router.get('/', (req, res, next) => {
    try {
      const { role, userId } = req.identity;

      if (role === 'coordinator') {
        const reports = db.prepare('SELECT * FROM reports').all();
        return res.json({ reports });
      }

      // field_worker path
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
  // Both roles. field_worker: 404 if not owner (don't leak existence, §Q2).
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
