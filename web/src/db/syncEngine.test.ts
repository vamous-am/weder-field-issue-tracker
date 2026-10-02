import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AppDb } from './schema';
import { createSyncEngine } from './syncEngine';
import { createRepository } from './repository';
import type { Identity } from '../identity';

// ---------------------------------------------------------------------------
// Harness — every non-deterministic dependency is injected, so no fake timers
// are needed except for the timeout test (toFake: ['setTimeout','clearTimeout']
// only, leaving fake-indexeddb's setImmediate untouched).
// ---------------------------------------------------------------------------

let dbCounter = 0;
function freshDb() {
  return new AppDb(`sync-engine-db-${dbCounter++}`);
}

const worker1: Identity = { user_id: 'worker-1', role: 'field_worker' };
const ts = '2026-10-01T08:00:00.000Z';

interface Harness {
  db: AppDb;
  repo: ReturnType<typeof createRepository>;
  /** Completed HTTP calls: [path, init]. */
  calls: Array<[string, RequestInit]>;
  /** Responses to serve, one per fetch; the last repeats when exhausted. */
  responses: Array<Response | Error>;
  /** Scheduled backoff callbacks by delay (does not fire them itself). */
  scheduled: Array<{ delayMs: number; fn: () => void }>;
  /** Run all pending scheduled callbacks immediately. */
  runScheduled: () => Promise<void>;
  engine: ReturnType<typeof createSyncEngine>;
}

function setup(responses: Array<Response | Error> = []): Harness {
  const db = freshDb();
  const repo = createRepository(db, { now: () => ts });
  const calls: Array<[string, RequestInit]> = [];
  const queue = [...responses];
  const scheduled: Harness['scheduled'] = [];

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
    schedule: (fn, delayMs) => {
      scheduled.push({ delayMs, fn });
    },
    clear: () => {
      scheduled.length = 0;
    },
  });

  return {
    db,
    repo,
    calls,
    responses: queue,
    scheduled,
    runScheduled: async () => {
      const fns = scheduled.splice(0).map((s) => s.fn);
      // Run all scheduled callbacks and await any returned promises so that
      // re-scheduled backoff entries are present before the caller checks them.
      for (const fn of fns) await fn();
    },
    engine,
  };
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Server-echo shapes. version/received_at presence is required for success. */
const echo = (reporterId: string) => ({
  report: {
    id: 'x',
    reporter_id: reporterId,
    version: 1,
    received_at: ts,
  },
  events: [],
});

/** Seed a submitted report + create op through the real repository. */
async function seedPending(h: Harness, reporterId = 'worker-1') {
  await h.repo.createDraft({ user_id: reporterId, role: 'field_worker' }, 'r-1', {
    description: 'Hand pump leaking',
    location: 'Village A',
  });
  const result = await h.repo.submitDraft({ user_id: reporterId, role: 'field_worker' }, 'r-1');
  if (!result.ok) throw new Error('seed failed');
  return result.report;
}

async function state(h: Harness, id = 'r-1') {
  return h.db.reports.get(id);
}

async function outboxCount(h: Harness) {
  return h.db.outbox.count();
}

// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe('success outcomes', () => {
  it('201 makes the report synced, deletes the op, marks events uploaded and writes one synced event', async () => {
    const h = setup([jsonRes(201, echo('worker-1'))]);
    await seedPending(h);
    await h.engine.syncOnce();

    const r = await state(h);
    expect(r!.sync_state).toBe('synced');
    expect(r!.version).toBe(1);
    expect(r!.received_at).toBe(ts);
    expect(r!.attempts).toBe(0);
    expect(r!.last_error).toBeNull();
    expect(await outboxCount(h)).toBe(0);

    const events = await h.db.reportHistory.where('report_id').equals('r-1').toArray();
    const created = events.find((e) => e.action === 'created')!;
    expect(created.uploaded).toBe(true);
    expect(events.filter((e) => e.action === 'synced')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'sync_failed')).toHaveLength(0);
  });

  it('a 200 replay counts as success', async () => {
    const h = setup([jsonRes(200, echo('worker-1'))]);
    await seedPending(h);
    await h.engine.syncOnce();
    expect((await state(h))!.sync_state).toBe('synced');
    expect(await outboxCount(h)).toBe(0);
  });

  it('does not stop the pass and syncs the next report too', async () => {
    const h = setup([jsonRes(201, echo('worker-1')), jsonRes(201, echo('worker-1'))]);
    await seedPending(h);
    await h.repo.createDraft(worker1, 'r-2', { description: 'Second', location: 'B' });
    await h.repo.submitDraft(worker1, 'r-2');
    await h.engine.syncOnce();

    expect((await state(h, 'r-1'))!.sync_state).toBe('synced');
    expect((await state(h, 'r-2'))!.sync_state).toBe('synced');
    expect(h.calls).toHaveLength(2);
  });

  it('a terminal failure does not block the next report op in the same pass', async () => {
    const h = setup([
      jsonRes(422, { error: { code: 'UNPROCESSABLE', message: 'nope' } }),
      jsonRes(201, echo('worker-1')),
    ]);
    await seedPending(h);
    await h.repo.createDraft(worker1, 'r-2', { description: 'Second', location: 'B' });
    await h.repo.submitDraft(worker1, 'r-2');
    await h.engine.syncOnce();

    expect((await state(h, 'r-1'))!.sync_state).toBe('failed');
    expect((await state(h, 'r-2'))!.sync_state).toBe('synced');
  });
});

// ---------------------------------------------------------------------------
// Retryable failures
// ---------------------------------------------------------------------------

describe('retryable failures', () => {
  it.each([
    ['network error', new Error('fetch failed')],
    ['5xx', jsonRes(500, { error: { code: 'INTERNAL', message: 'boom' } })],
    ['429', jsonRes(429, { error: { code: 'INTERNAL', message: 'slow down' } })],
  ])('%s keeps the op, sets pending, increments attempts and schedules a retry', async (_name, failure) => {
    const h = setup([failure as Response | Error]);
    await seedPending(h);
    await h.engine.syncOnce();

    const r = await state(h);
    expect(r!.sync_state).toBe('pending');
    expect(r!.attempts).toBe(1);
    expect(r!.last_error).toBeTruthy();
    expect(await outboxCount(h)).toBe(1);
    expect(h.scheduled).toHaveLength(1);
    // backoff for attempts=1: 2s base doubled = 4s
    expect(h.scheduled[0].delayMs).toBeGreaterThanOrEqual(3_200);
    expect(h.scheduled[0].delayMs).toBeLessThanOrEqual(4_800);

    const events = await h.db.reportHistory.where('report_id').equals('r-1').toArray();
    expect(events.filter((e) => e.action === 'sync_failed')).toHaveLength(0);
  });

  it('a 500 with an empty body becomes pending with attempts incremented (Vite proxy case)', async () => {
    const h = setup([new Response(null, { status: 500 })]);
    await seedPending(h);
    await h.engine.syncOnce();

    const r = await state(h);
    expect(r!.sync_state).toBe('pending');
    expect(r!.attempts).toBe(1);
    expect(r!.last_error).toBe('Server unreachable (500)');
  });

  it('a 2xx with an unparseable body is retried and the op is kept', async () => {
    const h = setup([new Response('<html>proxy</html>', { status: 200 })]);
    await seedPending(h);
    await h.engine.syncOnce();

    const r = await state(h);
    expect(r!.sync_state).toBe('pending');
    expect(r!.attempts).toBe(1);
    expect(r!.last_error).toBe('Unreadable response from server');
    expect(await outboxCount(h)).toBe(1);
    // The 2xx never means "drop the data" — events stay un-uploaded.
    const events = await h.db.reportHistory.where('report_id').equals('r-1').toArray();
    expect(events.find((e) => e.action === 'created')!.uploaded).toBe(false);
  });

  it('a retryable failure stops the pass: later ops are untouched', async () => {
    const h = setup([new Error('offline')]);
    await seedPending(h);
    await h.repo.createDraft(worker1, 'r-2', { description: 'Second', location: 'B' });
    await h.repo.submitDraft(worker1, 'r-2');
    await h.engine.syncOnce();

    expect(h.calls).toHaveLength(1); // pass stopped after the first op
    expect((await state(h, 'r-2'))!.sync_state).toBe('pending');
    expect(h.scheduled).toHaveLength(1);
  });

  it('backoff doubles per failed pass and is capped at 60s (in-memory timer)', async () => {
    const h = setup([new Error('offline')]);
    await seedPending(h);

    await h.engine.syncOnce();
    // attempts=1 after the first failed pass → 4s raw ±20%
    expect(h.scheduled[0].delayMs).toBeGreaterThanOrEqual(3_200);
    expect(h.scheduled[0].delayMs).toBeLessThanOrEqual(4_800);

    // Simulate the timer firing: attempts becomes 2, next delay doubles.
    await h.runScheduled();
    expect(h.scheduled[0].delayMs).toBeGreaterThanOrEqual(6_400); // 8s ±20%
    expect(h.scheduled[0].delayMs).toBeLessThanOrEqual(9_600);

    for (let i = 0; i < 10; i++) await h.runScheduled();
    const r = await state(h);
    expect(r!.attempts).toBe(12);
    expect(h.scheduled[0].delayMs).toBeLessThanOrEqual(60_000);
    expect(h.scheduled[0].delayMs).toBeGreaterThanOrEqual(48_000); // raw is capped
  });
});

// ---------------------------------------------------------------------------
// Terminal failures
// ---------------------------------------------------------------------------

describe('terminal failures', () => {
  it.each([
    ['400', 400],
    ['403', 403],
    ['404', 404],
    ['409', 409],
    ['422', 422],
  ])('%s becomes failed with the server message and exactly one sync_failed event', async (_name, status) => {
    const h = setup([
      jsonRes(status, { error: { code: 'X', message: `rejected ${status}` } }),
    ]);
    await seedPending(h);
    await h.engine.syncOnce();

    const r = await state(h);
    expect(r!.sync_state).toBe('failed');
    expect(r!.last_error).toBe(`rejected ${status}`);
    expect(r!.attempts).toBe(1);

    const events = await h.db.reportHistory.where('report_id').equals('r-1').toArray();
    expect(events.filter((e) => e.action === 'sync_failed')).toHaveLength(1);
    expect(await outboxCount(h)).toBe(0); // op deleted → next pass skips it
  });

  it('a 4xx with a non-JSON body becomes failed with the fallback message', async () => {
    const h = setup([new Response(null, { status: 400 })]);
    await seedPending(h);
    await h.engine.syncOnce();
    expect((await state(h))!.last_error).toBe('Rejected by server (400)');
  });

  it('409 with a non-JSON body is terminal with a fallback message', async () => {
    const h = setup([new Response(null, { status: 409 })]);
    await seedPending(h);
    await h.engine.syncOnce();
    const r = await state(h);
    expect(r!.sync_state).toBe('failed');
    expect(r!.last_error).toBe('Rejected by server (409)');
  });

  it('the next pass skips a failed report (op already deleted)', async () => {
    const h = setup([
      jsonRes(422, { error: { code: 'UNPROCESSABLE', message: 'bad content' } }),
    ]);
    await seedPending(h);
    await h.engine.syncOnce();
    expect(h.calls).toHaveLength(1);

    await h.engine.syncOnce();
    expect(h.calls).toHaveLength(1); // no new request
    expect((await state(h))!.sync_state).toBe('failed');
  });

  it('retry() moves failed to pending and the next pass succeeds', async () => {
    const h = setup([
      jsonRes(422, { error: { code: 'X', message: 'bad' } }),
      jsonRes(201, echo('worker-1')),
    ]);
    await seedPending(h);
    await h.engine.syncOnce();
    expect((await state(h))!.sync_state).toBe('failed');

    await h.engine.retry('r-1');
    expect((await state(h))!.sync_state).toBe('synced');
    expect(await outboxCount(h)).toBe(0);
  });

  it('retry() is a no-op for non-failed reports', async () => {
    const h = setup([new Error('offline')]);
    await seedPending(h);
    await h.engine.syncOnce();
    expect((await state(h))!.sync_state).toBe('pending');

    await h.engine.retry('r-1'); // pending, not failed → ignored
    // But the scheduled backoff timer was still cancelled first (amendment).
    expect(h.scheduled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency and recovery
// ---------------------------------------------------------------------------

describe('concurrency and recovery', () => {
  it('two concurrent syncOnce() calls make one request per op', async () => {
    const h = setup([jsonRes(201, echo('worker-1'))]);
    await seedPending(h);

    const p1 = h.engine.syncOnce();
    const p2 = h.engine.syncOnce();
    await Promise.all([p1, p2]);

    expect(h.calls).toHaveLength(1);
  });

  it('a call during a pass triggers exactly one rerun afterwards', async () => {
    const h = setup([]);
    await seedPending(h);

    // A fetch that blocks until we release it, so the second call lands
    // strictly DURING the first pass.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fetchCount = 0;
    const slowFetch = vi.fn(async () => {
      fetchCount++;
      await gate;
      return jsonRes(201, echo('worker-1'));
    });
    const engine = createSyncEngine({
      db: h.db,
      fetch: slowFetch as unknown as typeof fetch,
      now: () => ts,
      schedule: () => {},
      clear: () => {},
    });

    const first = engine.syncOnce();
    const second = engine.syncOnce(); // arrives while running → rerun flag
    release();
    await Promise.all([first, second]);

    expect(fetchCount).toBe(1); // single flight: one request for the one op
    expect(engine.isRunning()).toBe(false); // rerun drained
    expect((await state(h))!.sync_state).toBe('synced');
  });

  it('a thrown pass does not deadlock single-flight and the next call runs', async () => {
    const h = setup([jsonRes(201, echo('worker-1'))]);
    await seedPending(h);

    // Poison the FIRST read of the pass (getSendableOps' first report read).
    const spy = vi.spyOn(h.db.reports, 'get').mockRejectedValueOnce(new Error('IDB exploded'));
    const p = h.engine.syncOnce().catch(() => {});
    await p;
    spy.mockRestore();

    expect(h.engine.isRunning()).toBe(false);

    await h.engine.syncOnce();
    expect((await state(h))!.sync_state).toBe('synced');
  });

  it('a stale syncing report is reset at the start of a pass', async () => {
    const h = setup([jsonRes(201, echo('worker-1'))]);
    await seedPending(h);

    // Simulate a crash between send and outcome-write.
    await h.db.reports.put({ ...(await state(h))!, sync_state: 'syncing' });
    await h.engine.syncOnce();

    expect((await state(h))!.sync_state).toBe('synced');
    expect(h.calls).toHaveLength(1);
  });

  it('recoverOnStart resets syncing to pending in one go', async () => {
    const h = setup([]);
    await seedPending(h);
    await h.db.reports.put({ ...(await state(h))!, sync_state: 'syncing' });

    await h.engine.recoverOnStart();
    expect((await state(h))!.sync_state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

describe('wire contract', () => {
  it('the request uses the report reporter_id, not the active identity', async () => {
    const h = setup([jsonRes(201, echo('worker-1'))]);
    await seedPending(h, 'worker-1');
    await h.engine.syncOnce();

    const headers = new Headers(h.calls[0][1].headers as HeadersInit);
    expect(headers.get('X-Simulated-User')).toBe('worker-1');
    expect(headers.get('X-Simulated-Role')).toBe('field_worker');
  });

  it('the body contains no client-only fields', async () => {
    const h = setup([jsonRes(201, echo('worker-1'))]);
    await seedPending(h);
    await h.engine.syncOnce();

    const body = JSON.parse(h.calls[0][1].body as string);
    for (const key of [
      'sync_state',
      'attempts',
      'last_error',
      'version',
      'received_at',
      'assigned_to',
      'resolution_notes',
      'updated_at',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.status).toBe('submitted');
    expect(body.id).toBe('r-1');
  });

  it('the 10s timeout aborts the request and is retryable', { timeout: 30_000 }, async () => {
    // Seed the DB with real timers so fake-indexeddb setImmediate is unaffected.
    const h = setup([new Error('should never resolve')]);
    await seedPending(h);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Gate: lets us wait until the engine has actually called fetch (and therefore
    // registered the 10s AbortController timer) before advancing fake time.
    let fetchStarted!: () => void;
    const fetchStartedP = new Promise<void>((r) => (fetchStarted = r));
    const slowFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    );
    const engine = createSyncEngine({
      db: h.db,
      fetch: slowFetch as unknown as typeof fetch,
      now: () => ts,
      schedule: () => {},
      clear: () => {},
    });

    try {
      const pass = engine.syncOnce();
      // Wait until the engine has reached the fetch call (and registered the
      // AbortController timer) before advancing fake time.
      await fetchStartedP;
      await vi.advanceTimersByTimeAsync(10_000);
      await pass;

      const r = await h.db.reports.get('r-1');
      expect(r!.sync_state).toBe('pending');
      expect(r!.attempts).toBe(1);
      expect(r!.last_error).toContain('aborted');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Lost-response convergence (simulated — labelled, not an end-to-end claim)
// ---------------------------------------------------------------------------

describe('simulated lost response', () => {
  it('commit-then-reject, then 200 on replay: exactly one record and the report syncs', async () => {
    // Stateful fake: the first POST "commits" then the response is lost
    // (network error after the server saved it). The retry replays the same
    // ID and the server answers 200 with the stored record.
    const db = freshDb();
    const repo = createRepository(db, { now: () => ts });
    const stored: Record<string, unknown>[] = [];

    let firstCall = true;
    const statefulFetch = vi.fn(async () => {
      if (firstCall) {
        firstCall = false;
        stored.push({ id: 'r-1', reporter_id: 'worker-1', version: 1, received_at: ts });
        throw new Error('connection reset — response lost');
      }
      return jsonRes(200, { report: stored[0], events: [] });
    });

    const engine = createSyncEngine({
      db,
      fetch: statefulFetch as unknown as typeof fetch,
      now: () => ts,
      schedule: () => {},
      clear: () => {},
    });

    await repo.createDraft(worker1, 'r-1', { description: 'Lost response test', location: 'C' });
    await repo.submitDraft(worker1, 'r-1');
    await engine.syncOnce(); // fails retryably
    expect((await db.reports.get('r-1'))!.sync_state).toBe('pending');

    await engine.syncOnce(); // replay succeeds via 200
    expect((await db.reports.get('r-1'))!.sync_state).toBe('synced');

    // The server side of the simulation: exactly one stored record.
    expect(stored).toHaveLength(1);
  });
});
