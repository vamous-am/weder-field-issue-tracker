import { describe, it, test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createDb } from './db.js';
import { createApp } from './app.js';

// Each test gets a fresh in-memory DB — no shared state between tests.
function makeApp() {
  return createApp(createDb(':memory:'));
}

const ISO = '2026-10-01T08:00:00.000Z';
// Use randomUUID() so the format is always valid — no hand-typed hex that can fail the v4 regex.
const UUID1 = randomUUID();
const UUID2 = randomUUID();

const WORKER_HEADERS = {
  'X-Simulated-Role': 'field_worker',
  'X-Simulated-User': 'worker-1',
};
const WORKER2_HEADERS = {
  'X-Simulated-Role': 'field_worker',
  'X-Simulated-User': 'worker-2',
};
const COORD_HEADERS = {
  'X-Simulated-Role': 'coordinator',
  'X-Simulated-User': 'coord-1',
};

const VALID_BODY = {
  id: UUID1,
  category: 'water_point',
  description: 'Pump leaking at north well',
  location: 'North well',
  priority: 'high',
  reported_at: ISO,
  created_at: ISO,
};

// ── Identity middleware ──────────────────────────────────────────────────────

describe('identity middleware', () => {
  it('400 when X-Simulated-Role is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set('X-Simulated-User', 'worker-1')
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  it('400 when X-Simulated-User is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set('X-Simulated-Role', 'field_worker')
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  it('400 when X-Simulated-Role is unrecognised', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set('X-Simulated-Role', 'admin')
      .set('X-Simulated-User', 'u1')
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });
});

// ── Error shape ──────────────────────────────────────────────────────────────

describe('error shape', () => {
  it('bad JSON returns 400 in standard shape', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set('Content-Type', 'application/json')
      .set('X-Simulated-Role', 'field_worker')
      .set('X-Simulated-User', 'worker-1')
      .send('{not json');
    assert.equal(res.status, 400);
    assert.ok(res.body.error?.code);
  });

  it('unknown route returns 404 in standard shape', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/does-not-exist')
      .set(WORKER_HEADERS);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

// ── POST /api/reports ────────────────────────────────────────────────────────

describe('POST /api/reports', () => {
  it('201 on valid create', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send(VALID_BODY);
    assert.equal(res.status, 201);
    assert.equal(res.body.report.id, UUID1);
    assert.equal(res.body.report.status, 'submitted');
    assert.equal(res.body.report.version, 1);
    assert.equal(res.body.report.reporter_id, 'worker-1');
    // server sets received_at — must be a valid ISO string
    assert.ok(new Date(res.body.report.received_at).toISOString());
  });

  it('422 when status is draft', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({ ...VALID_BODY, status: 'draft' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'UNPROCESSABLE');
  });

  it('422 when status is any non-submitted value', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({ ...VALID_BODY, id: UUID2, status: 'resolved' });
    assert.equal(res.status, 422);
  });

  it('403 when coordinator tries to create', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set(COORD_HEADERS)
      .send(VALID_BODY);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  it('422 when id is not a valid UUID', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({ ...VALID_BODY, id: 'not-a-uuid' });
    assert.equal(res.status, 422);
    assert.ok(Array.isArray(res.body.error.details));
    assert.ok(res.body.error.details.includes('id must be a valid UUID v4'));
  });

  it('422 with details when content is invalid', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({ ...VALID_BODY, description: '', category: 'bad_cat' });
    assert.equal(res.status, 422);
    assert.ok(Array.isArray(res.body.error.details));
    assert.ok(res.body.error.details.length > 0);
  });

  it('422 when reported_at is missing', async () => {
    const app = makeApp();
    const { reported_at: _, ...body } = VALID_BODY;
    const res = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send(body);
    assert.equal(res.status, 422);
  });

  it('422 when created_at is missing', async () => {
    const app = makeApp();
    const { created_at: _, ...body } = VALID_BODY;
    const res = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send(body);
    assert.equal(res.status, 422);
  });
});

// ── GET /api/reports ─────────────────────────────────────────────────────────

describe('GET /api/reports', () => {
  it('coordinator sees all reports', async () => {
    const app = makeApp();
    // create one report
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    const res = await request(app).get('/api/reports').set(COORD_HEADERS);
    assert.equal(res.status, 200);
    assert.equal(res.body.reports.length, 1);
  });

  it('field_worker without ?reporter=me gets 403', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/reports').set(WORKER_HEADERS);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  it('field_worker with ?reporter=me gets own reports only', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    // worker-2 creates a separate report
    await request(app)
      .post('/api/reports')
      .set(WORKER2_HEADERS)
      .send({ ...VALID_BODY, id: UUID2 });
    const res = await request(app)
      .get('/api/reports?reporter=me')
      .set(WORKER_HEADERS);
    assert.equal(res.status, 200);
    assert.equal(res.body.reports.length, 1);
    assert.equal(res.body.reports[0].reporter_id, 'worker-1');
  });

  it('?reporter=other returns 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/reports?reporter=worker-2')
      .set(WORKER_HEADERS);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });
});

// ── GET /api/reports/:id ──────────────────────────────────────────────────────

describe('GET /api/reports/:id', () => {
  it('owner can fetch their own report with events', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    const res = await request(app)
      .get(`/api/reports/${UUID1}`)
      .set(WORKER_HEADERS);
    assert.equal(res.status, 200);
    assert.equal(res.body.report.id, UUID1);
    assert.ok(Array.isArray(res.body.events));
    assert.equal(res.body.events.length, 1);
  });

  it('non-owner worker gets 404 (existence not leaked)', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    const res = await request(app)
      .get(`/api/reports/${UUID1}`)
      .set(WORKER2_HEADERS);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  it('coordinator can fetch any report', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    const res = await request(app)
      .get(`/api/reports/${UUID1}`)
      .set(COORD_HEADERS);
    assert.equal(res.status, 200);
  });

  it('unknown id returns 404', async () => {
    const app = makeApp();
    const res = await request(app)
      .get(`/api/reports/${UUID2}`)
      .set(COORD_HEADERS);
    assert.equal(res.status, 404);
  });
});

// ── M3: Idempotency and history events ───────────────────────────────────────

const EVENT_UUID = '33333333-3333-4333-8333-333333333333';

describe('POST /api/reports — idempotent replay', () => {
  it('201 then 200: second POST with same id returns 200', async () => {
    const app = makeApp();
    const r1 = await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    assert.equal(r1.status, 201);
    const r2 = await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    assert.equal(r2.status, 200);
  });

  it('replay returns the stored record, not the replay payload', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    // send a replay with invalid content — must still return the stored record
    const r2 = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({ ...VALID_BODY, description: '' });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.report.description, VALID_BODY.description);
  });

  it('replay leaves exactly one row in the DB', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    const list = await request(app).get('/api/reports').set(COORD_HEADERS);
    assert.equal(list.body.reports.length, 1);
  });

  it('replay adds no new history events', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    const r2 = await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.events.length, 1); // only the original created event
  });

  it('new events in a replay payload are not stored', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    // replay with an extra sync_failed event — must be ignored
    const r2 = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({
        ...VALID_BODY,
        events: [{ id: randomUUID(), action: 'sync_failed', timestamp: ISO }],
      });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.events.length, 1); // still only the original created event
  });

  it('different reporter with same id returns 409', async () => {
    const app = makeApp();
    await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    const r2 = await request(app)
      .post('/api/reports')
      .set(WORKER2_HEADERS)
      .send(VALID_BODY);
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error.code, 'CONFLICT');
    // must not leak any field from the stored record
    assert.equal(r2.body.report, undefined);
  });
});

describe('POST /api/reports — history events', () => {
  it('server adds a created event when none supplied', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/reports').set(WORKER_HEADERS).send(VALID_BODY);
    assert.equal(r.status, 201);
    assert.ok(Array.isArray(r.body.events));
    assert.equal(r.body.events.length, 1);
    assert.equal(r.body.events[0].action, 'created');
  });

  it('events are persisted and echoed: full event data in 201 response', async () => {
    const app = makeApp();
    const syncedId = randomUUID();
    const r = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({
        ...VALID_BODY,
        id: UUID2,
        events: [{ id: syncedId, action: 'synced', timestamp: ISO }],
      });
    assert.equal(r.status, 201);
    // echoed back in response
    const echoed = r.body.events.find((e: { id: string }) => e.id === syncedId);
    assert.ok(echoed, 'synced event must be echoed in the 201 response');
    assert.equal(echoed.action, 'synced');
    // also persisted: GET confirms it
    const get = await request(app)
      .get(`/api/reports/${UUID2}`)
      .set(WORKER_HEADERS);
    assert.ok(get.body.events.some((e: { id: string }) => e.id === syncedId));
  });

  it('client-supplied created event is preserved, not duplicated', async () => {
    const app = makeApp();
    const r = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({ ...VALID_BODY, events: [{ id: EVENT_UUID, action: 'created', timestamp: ISO }] });
    assert.equal(r.status, 201);
    const createdEvents = r.body.events.filter((e: { action: string }) => e.action === 'created');
    assert.equal(createdEvents.length, 1);
    assert.equal(createdEvents[0].id, EVENT_UUID);
  });

  it('status_changed upload is refused with 422', async () => {
    const app = makeApp();
    const r = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({
        ...VALID_BODY,
        id: UUID2,
        events: [{ id: EVENT_UUID, action: 'status_changed', timestamp: ISO }],
      });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'UNPROCESSABLE');
  });

  it('more than 50 events returns 422', async () => {
    const app = makeApp();
    const manyEvents = Array.from({ length: 51 }, () => ({
      id: randomUUID(),
      action: 'synced',
      timestamp: ISO,
    }));
    const r = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({ ...VALID_BODY, id: UUID2, events: manyEvents });
    assert.equal(r.status, 422);
  });

  it('a bad event leaves no report row', async () => {
    const app = makeApp();
    const r = await request(app)
      .post('/api/reports')
      .set(WORKER_HEADERS)
      .send({
        ...VALID_BODY,
        id: UUID2,
        events: [{ id: 'not-a-uuid', action: 'created', timestamp: ISO }],
      });
    assert.equal(r.status, 422);
    // confirm the report was not inserted
    const get = await request(app).get(`/api/reports/${UUID2}`).set(COORD_HEADERS);
    assert.equal(get.status, 404);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

import { DatabaseSync } from 'node:sqlite';
import { createDb } from './db.js';
import { TRANSITIONS } from '@shared/transitions';
import type { Status } from '@shared/types';

interface SeedRow {
  id: string;
  reporter_id: string;
  category: string;
  description: string;
  location: string;
  priority: string;
  status: string;
  reported_at: string;
  created_at: string;
  received_at: string;
  updated_at: string;
  version: number;
  assigned_to: string | null;
  resolution_notes: string | null;
}

function seedReport(db: DatabaseSync, overrides: Partial<SeedRow> = {}): SeedRow {
  const row: SeedRow = {
    id: randomUUID(),
    reporter_id: 'worker-1',   // matches WORKER_HEADERS 'X-Simulated-User'
    category: 'water_point',
    description: 'Pump leaking',
    location: 'North well',
    priority: 'high',
    status: 'submitted',
    reported_at: ISO,
    created_at: ISO,
    received_at: ISO,
    updated_at: ISO,
    version: 1,
    assigned_to: null,
    resolution_notes: null,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO reports
      (id, reporter_id, category, description, location, priority, status,
       reported_at, created_at, received_at, updated_at, version,
       assigned_to, resolution_notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.reporter_id, row.category, row.description, row.location,
    row.priority, row.status, row.reported_at, row.created_at,
    row.received_at, row.updated_at, row.version,
    row.assigned_to, row.resolution_notes,
  );

  // seed a 'created' history event so the report has a valid history
  db.prepare(`
    INSERT INTO report_history (id, report_id, action, old_value, new_value, actor_role, timestamp)
    VALUES (?, ?, 'created', NULL, NULL, 'field_worker', ?)
  `).run(randomUUID(), row.id, ISO);

  return row;
}

// Returns the first app+db pair so tests can inspect the DB directly.
function makeAppWithDb() {
  const db = createDb(':memory:');
  return { app: createApp(db), db };
}

// ── PATCH /api/reports/:id/status — Phase 1 tests ────────────────────────────

// Drive legal cases from the actual TRANSITIONS table.
const coordinatorMoves = Object.entries(TRANSITIONS).flatMap(
  ([from, moves]) =>
    moves
      .filter((move) => move.role === 'coordinator')
      .map((move) => ({ from: from as Status, to: move.to as Status })),
);

// Notes are required for these target statuses (or this specific source).
function notesFor(from: Status, to: Status): string | undefined {
  if (to === 'rejected') return 'Duplicate of INC-1024';
  if (to === 'resolved') return 'Pump seal replaced.';
  if (from === 'resolved' && to === 'in_progress') return 'Issue returned.';
  return undefined;
}

describe('PATCH /api/reports/:id/status — legal transitions', () => {
  test.each(coordinatorMoves)('$from → $to returns 200', async ({ from, to }) => {
    const { app, db } = makeAppWithDb();
    const notes = notesFor(from, to);

    // for resolved → in_progress: seed resolution_notes so the field is populated
    const report = seedReport(db, {
      status: from,
      version: 1,
      assigned_to: from === 'assigned' || from === 'in_progress' ? 'c1' : null,
      resolution_notes: from === 'resolved' ? 'Prior notes.' : null,
    });

    const body: Record<string, unknown> = { to, expectedVersion: 1 };
    if (notes) body.resolution_notes = notes;

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send(body);

    assert.equal(res.status, 200, `${from} → ${to}: ${JSON.stringify(res.body)}`);
  });

  test.each(coordinatorMoves)('$from → $to: status is updated', async ({ from, to }) => {
    const { app, db } = makeAppWithDb();
    const notes = notesFor(from, to);
    const report = seedReport(db, {
      status: from,
      version: 1,
      assigned_to: from === 'assigned' || from === 'in_progress' ? 'c1' : null,
      resolution_notes: from === 'resolved' ? 'Prior notes.' : null,
    });

    const body: Record<string, unknown> = { to, expectedVersion: 1 };
    if (notes) body.resolution_notes = notes;

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send(body);

    const stored = db.prepare('SELECT status, version FROM reports WHERE id = ?').get(report.id) as { status: string; version: number };
    assert.equal(stored.status, to);
    assert.equal(stored.version, 2);
  });

  test.each(coordinatorMoves)('$from → $to: one status_changed event inserted', async ({ from, to }) => {
    const { app, db } = makeAppWithDb();
    const notes = notesFor(from, to);
    const report = seedReport(db, {
      status: from,
      version: 1,
      assigned_to: from === 'assigned' || from === 'in_progress' ? 'c1' : null,
      resolution_notes: from === 'resolved' ? 'Prior notes.' : null,
    });

    const body: Record<string, unknown> = { to, expectedVersion: 1 };
    if (notes) body.resolution_notes = notes;

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send(body);

    const events = db.prepare(
      "SELECT * FROM report_history WHERE report_id = ? AND action = 'status_changed'"
    ).all(report.id) as { action: string }[];
    assert.equal(events.length, 1);
  });
});

describe('PATCH /api/reports/:id/status — failure cases', () => {
  it('submitted → resolved returns 409 (illegal transition)', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'resolved', expectedVersion: 1 });

    assert.equal(res.status, 409);
  });

  it('illegal transition leaves status unchanged', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'resolved', expectedVersion: 1 });

    const stored = db.prepare('SELECT status FROM reports WHERE id = ?').get(report.id) as { status: string };
    assert.equal(stored.status, 'submitted');
  });

  it('illegal transition leaves version unchanged', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'resolved', expectedVersion: 1 });

    const stored = db.prepare('SELECT version FROM reports WHERE id = ?').get(report.id) as { version: number };
    assert.equal(stored.version, 1);
  });

  it('field_worker receives 403', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(WORKER_HEADERS)
      .send({ to: 'assigned', expectedVersion: 1 });

    assert.equal(res.status, 403);
  });

  it('missing notes on resolve returns 422', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'in_progress', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'resolved', expectedVersion: 1 });

    assert.equal(res.status, 422);
  });

  it('missing notes on reject returns 422', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'rejected', expectedVersion: 1 });

    assert.equal(res.status, 422);
  });

  it('missing reopen reason returns 422', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, {
      status: 'resolved',
      version: 1,
      resolution_notes: 'Fixed.',
    });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'in_progress', expectedVersion: 1 });

    assert.equal(res.status, 422);
  });

  it('stale expectedVersion returns 409', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 2 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'assigned', expectedVersion: 1 });

    assert.equal(res.status, 409);
  });

  it('unknown report returns 404', async () => {
    const app = makeApp();

    const res = await request(app)
      .patch(`/api/reports/${randomUUID()}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'assigned', expectedVersion: 1 });

    assert.equal(res.status, 404);
  });

  it('unknown to value returns 400', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'foobar', expectedVersion: 1 });

    assert.equal(res.status, 400);
  });

  it('missing expectedVersion returns 400', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'assigned' });

    assert.equal(res.status, 400);
  });

  it('non-integer expectedVersion returns 400', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'assigned', expectedVersion: 1.5 });

    assert.equal(res.status, 400);
  });

  it('non-object body returns 400', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send('"a string"');

    assert.equal(res.status, 400);
  });

  it('submitted → assigned uses caller X-Simulated-User', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set({ 'X-Simulated-Role': 'coordinator', 'X-Simulated-User': 'coord-99' })
      .send({ to: 'assigned', expectedVersion: 1 });

    const stored = db.prepare('SELECT assigned_to FROM reports WHERE id = ?').get(report.id) as { assigned_to: string };
    assert.equal(stored.assigned_to, 'coord-99');
  });

  it('assigned_to in request body is ignored — caller identity wins', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set({ 'X-Simulated-Role': 'coordinator', 'X-Simulated-User': 'coord-1' })
      .send({ to: 'assigned', expectedVersion: 1, assigned_to: 'hijack-user' });

    const stored = db.prepare('SELECT assigned_to FROM reports WHERE id = ?').get(report.id) as { assigned_to: string };
    assert.equal(stored.assigned_to, 'coord-1');
  });

  it('reopen does not modify resolution_notes', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, {
      status: 'resolved',
      version: 1,
      resolution_notes: 'Pump seal replaced.',
    });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'in_progress', expectedVersion: 1, resolution_notes: 'It broke again.' });

    const stored = db.prepare('SELECT resolution_notes FROM reports WHERE id = ?').get(report.id) as { resolution_notes: string };
    assert.equal(stored.resolution_notes, 'Pump seal replaced.');
  });

  it('reopen stores reason in event new_value only', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, {
      status: 'resolved',
      version: 1,
      resolution_notes: 'Pump seal replaced.',
    });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'in_progress', expectedVersion: 1, resolution_notes: 'It broke again.' });

    const ev = db.prepare(
      "SELECT new_value FROM report_history WHERE report_id = ? AND action = 'status_changed'"
    ).get(report.id) as { new_value: string };
    const newVal = JSON.parse(ev.new_value);
    assert.equal(newVal.reason, 'It broke again.');
    assert.equal(newVal.status, 'in_progress');
  });

  it('rejection stores notes in report column', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'rejected', expectedVersion: 1, resolution_notes: 'Duplicate of INC-1024' });

    const stored = db.prepare('SELECT resolution_notes FROM reports WHERE id = ?').get(report.id) as { resolution_notes: string };
    assert.equal(stored.resolution_notes, 'Duplicate of INC-1024');
  });

  it('rejection stores reason in event new_value', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'rejected', expectedVersion: 1, resolution_notes: 'Duplicate of INC-1024' });

    const ev = db.prepare(
      "SELECT new_value FROM report_history WHERE report_id = ? AND action = 'status_changed'"
    ).get(report.id) as { new_value: string };
    const newVal = JSON.parse(ev.new_value);
    assert.equal(newVal.reason, 'Duplicate of INC-1024');
  });

  it('rejection clears assigned_to', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, {
      status: 'assigned',
      version: 1,
      assigned_to: 'coord-1',
    });

    await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'rejected', expectedVersion: 1, resolution_notes: 'Duplicate' });

    const stored = db.prepare('SELECT assigned_to FROM reports WHERE id = ?').get(report.id) as { assigned_to: string | null };
    assert.equal(stored.assigned_to, null);
  });

  it('assigned → submitted returns 409 (transition not in table)', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'assigned', version: 1 });

    const res = await request(app)
      .patch(`/api/reports/${report.id}/status`)
      .set(COORD_HEADERS)
      .send({ to: 'submitted', expectedVersion: 1 });

    assert.equal(res.status, 409);
  });
});

// ── POST /api/reports/:id/resubmit — Phase 2 tests ───────────────────────────

describe('POST /api/reports/:id/resubmit', () => {
  it('successful edit produces two events (edited + status_changed)', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1, fields: { description: 'Updated description' } });

    assert.equal(res.status, 200, JSON.stringify(res.body));

    const events = db.prepare(
      'SELECT action FROM report_history WHERE report_id = ? ORDER BY timestamp ASC, rowid ASC'
    ).all(report.id) as { action: string }[];

    // created (seeded) + edited + status_changed
    const actions = events.map((e) => e.action);
    assert.ok(actions.includes('edited'), `events: ${actions}`);
    assert.ok(actions.includes('status_changed'), `events: ${actions}`);
    const editedIdx = actions.lastIndexOf('edited');
    const statusIdx = actions.lastIndexOf('status_changed');
    assert.ok(editedIdx < statusIdx, 'edited must come before status_changed');
  });

  it('successful edit increments version once', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1, fields: { description: 'Updated description' } });

    const stored = db.prepare('SELECT version FROM reports WHERE id = ?').get(report.id) as { version: number };
    assert.equal(stored.version, 2);
  });

  it('no-op resubmit (no field changes) produces only status_changed event', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1 });

    assert.equal(res.status, 200, JSON.stringify(res.body));

    const events = db.prepare(
      "SELECT action FROM report_history WHERE report_id = ? AND action != 'created'"
    ).all(report.id) as { action: string }[];

    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'status_changed');
  });

  it('validation failure leaves report unchanged', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1, fields: { description: '' } });

    const stored = db.prepare('SELECT status, version, description FROM reports WHERE id = ?')
      .get(report.id) as { status: string; version: number; description: string };
    assert.equal(stored.status, 'rejected');
    assert.equal(stored.version, 1);
    assert.equal(stored.description, 'Pump leaking');
  });

  it('validation failure adds no events', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1, fields: { description: '' } });

    assert.equal(res.status, 422);
    const events = db.prepare(
      "SELECT * FROM report_history WHERE report_id = ? AND action != 'created'"
    ).all(report.id);
    assert.equal(events.length, 0);
  });

  it('non-owner gets same 404 as unknown report', async () => {
    const { app, db } = makeAppWithDb();
    // report belongs to 'w1', but worker-2 tries to resubmit
    const report = seedReport(db, { status: 'rejected', version: 1 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER2_HEADERS)
      .send({ expectedVersion: 1 });

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  it('non-rejected report returns 409', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'submitted', version: 1 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1 });

    assert.equal(res.status, 409);
  });

  it('second resubmit (now submitted) returns 409', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    // first resubmit succeeds
    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1 });

    // second attempt on now-submitted report
    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 2 });

    assert.equal(res.status, 409);
  });

  it('status inside fields is ignored', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1, fields: { status: 'resolved' } });

    const stored = db.prepare('SELECT status FROM reports WHERE id = ?').get(report.id) as { status: string };
    assert.equal(stored.status, 'submitted');
  });

  it('assigned_to inside fields is ignored', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, {
      status: 'rejected',
      version: 1,
      reporter_id: 'worker-1',
      assigned_to: 'coord-1',
    });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1, fields: { assigned_to: 'hijack-coord' } });

    const stored = db.prepare('SELECT assigned_to FROM reports WHERE id = ?').get(report.id) as { assigned_to: string | null };
    assert.equal(stored.assigned_to, null); // cleared by resubmit, not overridden
  });

  it('resolution_notes inside fields is ignored', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, {
      status: 'rejected',
      version: 1,
      reporter_id: 'worker-1',
      resolution_notes: 'Duplicate',
    });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1, fields: { resolution_notes: 'Injected notes' } });

    const stored = db.prepare('SELECT resolution_notes FROM reports WHERE id = ?').get(report.id) as { resolution_notes: string | null };
    assert.equal(stored.resolution_notes, null); // always cleared on resubmit
  });

  it('coordinator receives 403', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(COORD_HEADERS)
      .send({ expectedVersion: 1 });

    assert.equal(res.status, 403);
  });

  it('stale expectedVersion returns 409', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 3 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1 });

    assert.equal(res.status, 409);
  });

  it('resolution_notes is cleared after successful resubmit', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, {
      status: 'rejected',
      version: 1,
      reporter_id: 'worker-1',
      resolution_notes: 'Rejected because duplicate',
    });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1 });

    const stored = db.prepare('SELECT resolution_notes FROM reports WHERE id = ?').get(report.id) as { resolution_notes: string | null };
    assert.equal(stored.resolution_notes, null);
  });

  it('assigned_to is cleared after successful resubmit', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, {
      status: 'rejected',
      version: 1,
      reporter_id: 'worker-1',
      assigned_to: 'coord-1',
    });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1 });

    const stored = db.prepare('SELECT assigned_to FROM reports WHERE id = ?').get(report.id) as { assigned_to: string | null };
    assert.equal(stored.assigned_to, null);
  });

  it('client event IDs are idempotent (duplicate not inserted twice)', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });
    const clientEventId = randomUUID();

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({
        expectedVersion: 1,
        events: [{ id: clientEventId, action: 'synced', timestamp: ISO }],
      });

    // Re-seed the same ID in a second call — use a fresh rejected report
    const report2 = seedReport(db, { status: 'rejected', version: 1, reporter_id: 'w1' });

    await request(app)
      .post(`/api/reports/${report2.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({
        expectedVersion: 1,
        events: [{ id: clientEventId, action: 'synced', timestamp: ISO }],
      });

    // The duplicate clientEventId must appear exactly once across all reports
    const rows = db.prepare(
      'SELECT * FROM report_history WHERE id = ?'
    ).all(clientEventId);
    assert.equal(rows.length, 1);
  });

  it('invalid client events return 422', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({
        expectedVersion: 1,
        events: [{ id: 'not-a-uuid', action: 'synced', timestamp: ISO }],
      });

    assert.equal(res.status, 422);
  });

  it('invalid client events leave report unchanged', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({
        expectedVersion: 1,
        events: [{ id: 'not-a-uuid', action: 'synced', timestamp: ISO }],
      });

    const stored = db.prepare('SELECT status, version FROM reports WHERE id = ?').get(report.id) as { status: string; version: number };
    assert.equal(stored.status, 'rejected');
    assert.equal(stored.version, 1);
  });

  it('status set to submitted after successful resubmit', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1 });

    const stored = db.prepare('SELECT status FROM reports WHERE id = ?').get(report.id) as { status: string };
    assert.equal(stored.status, 'submitted');
  });

  it('unknown report returns 404', async () => {
    const app = makeApp();

    const res = await request(app)
      .post(`/api/reports/${randomUUID()}/resubmit`)
      .set(WORKER_HEADERS)
      .send({ expectedVersion: 1 });

    assert.equal(res.status, 404);
  });

  it('missing expectedVersion returns 400', async () => {
    const { app, db } = makeAppWithDb();
    const report = seedReport(db, { status: 'rejected', version: 1 });

    const res = await request(app)
      .post(`/api/reports/${report.id}/resubmit`)
      .set(WORKER_HEADERS)
      .send({});

    assert.equal(res.status, 400);
  });
});
