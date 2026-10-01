import { describe, it } from 'vitest';
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
