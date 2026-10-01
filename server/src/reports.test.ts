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
