/**
 * Tests for M7b resubmit flow.
 *
 * Required scenarios from spec:
 *  1. expectedVersion is read at send time
 *  2. all three 409 outcomes:
 *     a. applied (server status is no longer rejected) → cleared op, synced
 *     b. conflict (still rejected) → failed with edits kept, status=rejected
 *     c. "already assigned" edge case → treated as applied
 *  3. a duplicate resubmit is blocked
 *  4. a 422 restores rejected with edits kept
 *  5. the wire identity comes from the report (not active UI identity)
 *
 * Extra required by spec:
 *  6. a failed resubmit leaves the report resubmittable (rejected, edits intact)
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AppDb } from './schema';
import { createSyncEngine } from './syncEngine';
import { createRepository } from './repository';
import type { Identity } from '../identity';

// ── Helpers ───────────────────────────────────────────────────────────────────

let dbCounter = 0;
function freshDb() { return new AppDb(`resubmit-db-${dbCounter++}`); }

const worker1: Identity = { user_id: 'worker-1', role: 'field_worker' };
const ts  = '2026-10-01T08:00:00.000Z';
const ts2 = '2026-10-01T09:00:00.000Z';

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Minimal server echo for a successful resubmit (2xx). */
function resubmitEcho(version = 2) {
  return jsonRes(200, {
    report: { id: 'r-1', reporter_id: 'worker-1', version, received_at: ts2 },
    events: [],
  });
}

interface Harness {
  db: AppDb;
  repo: ReturnType<typeof createRepository>;
  calls: Array<[string, RequestInit]>;
  responses: Array<Response | Error>;
  engine: ReturnType<typeof createSyncEngine>;
}

function setup(responses: Array<Response | Error> = []): Harness {
  const db = freshDb();
  const repo = createRepository(db, { now: () => ts });
  const calls: Array<[string, RequestInit]> = [];
  const queue = [...responses];

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init ?? {}]);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error('no response queued');
    if (next instanceof Error) throw next;
    return next;
  });

  const engine = createSyncEngine({
    db,
    fetch: fetchFn as unknown as typeof fetch,
    now: () => ts,
    schedule: () => {},
    clear: () => {},
    noPull: true,
  });

  return { db, repo, calls, responses: queue, engine };
}

/** Seed a report that is already rejected (version=2, synced history). */
async function seedRejected(h: Harness) {
  await h.repo.createDraft(worker1, 'r-1', { description: 'Hand pump', location: 'Village A' });
  await h.repo.submitDraft(worker1, 'r-1');
  // Simulate: server received it, coordinator rejected it.
  await h.db.reports.where('id').equals('r-1').modify({
    status: 'rejected',
    sync_state: 'synced',
    version: 2,
    received_at: ts,
    resolution_notes: 'Incomplete description',
  });
  await h.db.outbox.where('report_id').equals('r-1').delete();
  return (await h.db.reports.get('r-1'))!;
}

afterEach(() => { vi.restoreAllMocks(); });

// ── 1. Repository: duplicate resubmit is blocked ──────────────────────────────

describe('repository.resubmit', () => {
  it('(3) a duplicate resubmit op is blocked — second call sees no-rejected status', async () => {
    const h = setup([]);
    await seedRejected(h);

    const first = await h.repo.resubmit(worker1, 'r-1');
    expect(first.ok).toBe(true);

    // After the first resubmit the report is now submitted — a second call
    // is rejected by the status check (not rejected anymore).
    const second = await h.repo.resubmit(worker1, 'r-1');
    expect(second.ok).toBe(false);
    if (!second.ok && second.kind === 'validation') {
      expect(second.errors[0]).toMatch(/not rejected/i);
    }

    // Only one op in the outbox.
    expect(await h.db.outbox.count()).toBe(1);
  });

  it('(3b) concurrent transaction: in-transaction guard prevents double-op', async () => {
    const h = setup([]);
    await seedRejected(h);

    // Manually plant a resubmit op while the report is still rejected (simulates
    // a race where a second tab planted the op before the status flip committed).
    await h.db.outbox.add({ type: 'resubmit', report_id: 'r-1', created_at: ts });

    // Now try to resubmit — the pre-flight outbox check should block it.
    const result = await h.repo.resubmit(worker1, 'r-1');
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'validation') {
      expect(result.errors[0]).toMatch(/pending sync op/i);
    }
    expect(await h.db.outbox.count()).toBe(1); // no second op added
  });

  it('resubmit of a non-rejected report is rejected', async () => {
    const h = setup([]);
    await h.repo.createDraft(worker1, 'r-1', { description: 'Hand pump', location: 'Village A' });
    const result = await h.repo.resubmit(worker1, 'r-1');
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'validation') expect(result.errors[0]).toMatch(/not rejected/i);
  });

  it('resubmit sets status=submitted, sync_state=pending, content_dirty=false', async () => {
    const h = setup([]);
    await seedRejected(h);
    await h.repo.resubmit(worker1, 'r-1');

    const r = await h.db.reports.get('r-1');
    expect(r!.status).toBe('submitted');
    expect(r!.sync_state).toBe('pending');
    expect(r!.content_dirty).toBe(false);
  });
});

// ── 2. Engine: resubmit wire dispatch ────────────────────────────────────────

describe('engine resubmit dispatch', () => {
  it('(5) wire identity comes from the report, not the active UI identity', async () => {
    const h = setup([resubmitEcho()]);
    await seedRejected(h);
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    const call = h.calls[0];
    const headers = new Headers(call[1].headers as HeadersInit);
    expect(headers.get('X-Simulated-User')).toBe('worker-1');
    expect(headers.get('X-Simulated-Role')).toBe('field_worker');
    expect(call[0]).toContain('/r-1/resubmit');
  });

  it('(1) expectedVersion in the request body is read at send time', async () => {
    const h = setup([resubmitEcho()]);
    await seedRejected(h);   // version=2
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    const body = JSON.parse(h.calls[0][1].body as string);
    expect(body.expectedVersion).toBe(2);
  });

  it('golden path: 200 → synced, op deleted, content_dirty cleared', async () => {
    const h = setup([resubmitEcho(3)]);
    await seedRejected(h);
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    const r = await h.db.reports.get('r-1');
    expect(r!.sync_state).toBe('synced');
    expect(r!.version).toBe(3);
    expect(r!.content_dirty).toBeFalsy();
    expect(await h.db.outbox.count()).toBe(0);
  });

  it('(2a) 409 with server status=submitted (applied) → synced, op cleared', async () => {
    // Server status is no longer rejected (was concurrently assigned/moved on).
    const h = setup([
      jsonRes(409, {
        report: { id: 'r-1', reporter_id: 'worker-1', status: 'submitted', version: 3 },
      }),
    ]);
    await seedRejected(h);
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    const r = await h.db.reports.get('r-1');
    // Treated as success — synced.
    expect(r!.sync_state).toBe('synced');
    expect(await h.db.outbox.count()).toBe(0);
  });

  it('(2c) 409 with server status=assigned (also "already applied") → synced', async () => {
    const h = setup([
      jsonRes(409, {
        report: { id: 'r-1', reporter_id: 'worker-1', status: 'assigned', version: 4 },
      }),
    ]);
    await seedRejected(h);
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    const r = await h.db.reports.get('r-1');
    expect(r!.sync_state).toBe('synced');
  });

  it('(2b) 409 with server status still rejected → failed, edits kept, status=rejected', async () => {
    const h = setup([
      jsonRes(409, {
        report: {
          id: 'r-1',
          reporter_id: 'worker-1',
          status: 'rejected',
          version: 3,
          resolution_notes: 'New rejection reason',
        },
      }),
    ]);
    await seedRejected(h);
    // Edit locally before resubmitting.
    await h.db.reports.where('id').equals('r-1').modify({ description: 'My edit' });
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    const r = await h.db.reports.get('r-1');
    expect(r!.sync_state).toBe('failed');
    expect(r!.status).toBe('rejected');
    expect(r!.description).toBe('My edit'); // edits kept
    expect(r!.last_error).toMatch(/Rejected again/i);
    expect(r!.content_dirty).toBe(true);
  });

  it('(4) 422 restores status=rejected with edits kept', async () => {
    const h = setup([
      jsonRes(422, { error: { code: 'UNPROCESSABLE', message: 'content invalid' } }),
    ]);
    await seedRejected(h);
    await h.db.reports.where('id').equals('r-1').modify({ description: 'Bad edit' });
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    const r = await h.db.reports.get('r-1');
    expect(r!.status).toBe('rejected');
    expect(r!.sync_state).toBe('failed');
    expect(r!.description).toBe('Bad edit'); // edits kept
    expect(r!.content_dirty).toBe(true);
  });

  it('(6) after a failed resubmit the report is resubmittable (rejected + no op)', async () => {
    const h = setup([
      jsonRes(422, { error: { code: 'UNPROCESSABLE', message: 'invalid' } }),
    ]);
    await seedRejected(h);
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    // Op was deleted by applyOutcome (terminal). Report is rejected.
    const r = await h.db.reports.get('r-1');
    expect(r!.status).toBe('rejected');
    expect(await h.db.outbox.count()).toBe(0);

    // Can resubmit again.
    const result = await h.repo.resubmit(worker1, 'r-1');
    expect(result.ok).toBe(true);
  });

  it('network error on resubmit is retried (not terminal)', async () => {
    const h = setup([new Error('offline')]);
    await seedRejected(h);
    await h.repo.resubmit(worker1, 'r-1');
    await h.engine.syncOnce();

    const r = await h.db.reports.get('r-1');
    // Network error is retryable — stays pending, not rejected.
    expect(r!.sync_state).toBe('pending');
    expect(r!.status).toBe('submitted');
    expect(await h.db.outbox.count()).toBe(1);
  });
});
