import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { AppDb } from './schema';
import { createRepository } from './repository';
import type { Identity } from '../identity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dbCounter = 0;
/** Fresh database per test -- a shared singleton that gets deleted while open
 *  causes flaky failures across tests. */
function freshDb() {
  return new AppDb(`test-db-${dbCounter++}`);
}

const worker1: Identity = { user_id: 'worker-1', role: 'field_worker' };
const worker2: Identity = { user_id: 'worker-2', role: 'field_worker' };

/** Minimal valid report content for submit tests. */
const VALID_FIELDS = {
  category: 'safety' as const,
  description: 'cracked wall',
  location: 'Block B, room 4',
  lat: null,
  lng: null,
  priority: 'high' as const,
  reported_at: new Date('2026-01-15T10:00:00.000Z').toISOString(),
};

// Monotonic clock so ordering tests are never flaky.
function makeClock(start = 0) {
  let t = start;
  return () => new Date(t++).toISOString();
}

// ---------------------------------------------------------------------------
// newId
// ---------------------------------------------------------------------------

describe('newId', () => {
  it('native path returns a valid v4 UUID', async () => {
    const { newId } = await import('./newId');
    const id = newId();
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(UUID_RE.test(id)).toBe(true);
  });

  it('fallback path (no randomUUID) returns a valid v4 UUID', async () => {
    const orig = crypto.randomUUID;
    // @ts-expect-error intentionally removing for test
    delete crypto.randomUUID;
    try {
      // re-import to get the module fresh
      const { newId } = await import('./newId');
      const id = newId();
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(UUID_RE.test(id)).toBe(true);
    } finally {
      crypto.randomUUID = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// createDraft
// ---------------------------------------------------------------------------

describe('createDraft', () => {
  it('stores a draft with the given ID and reporter_id from identity', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    const report = await repo.createDraft(worker1, id);
    expect(report.id).toBe(id);
    expect(report.reporter_id).toBe('worker-1');
    expect(report.status).toBe('draft');
    expect(report.sync_state).toBeNull();
    expect(report.version).toBeNull();
    expect(report.received_at).toBeNull();
    await db.delete();
  });

  it('writes exactly one created event in the same transaction', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000002';
    await repo.createDraft(worker1, id);
    const events = await db.reportHistory.where('report_id').equals(id).toArray();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('created');
    expect(events[0].uploaded).toBe(false);
    await db.delete();
  });
});

// ---------------------------------------------------------------------------
// updateDraft
// ---------------------------------------------------------------------------

describe('updateDraft', () => {
  it('persists fields without adding history', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000003';
    await repo.createDraft(worker1, id);
    await repo.updateDraft(worker1, id, { description: 'updated text' });
    const report = await db.reports.get(id);
    expect(report?.description).toBe('updated text');
    const events = await db.reportHistory.where('report_id').equals(id).toArray();
    expect(events).toHaveLength(1); // only the original created
    await db.delete();
  });

  it('accepts an empty description (no validation on autosave)', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000004';
    await repo.createDraft(worker1, id);
    await expect(
      repo.updateDraft(worker1, id, { description: '' }),
    ).resolves.not.toThrow();
    await db.delete();
  });

  it('is refused when the report is not a draft', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000005';
    await repo.createDraft(worker1, id, VALID_FIELDS);
    await repo.submitDraft(worker1, id);
    await expect(
      repo.updateDraft(worker1, id, { description: 'nope' }),
    ).rejects.toThrow('not a draft');
    await db.delete();
  });
});

// ---------------------------------------------------------------------------
// submitDraft
// ---------------------------------------------------------------------------

describe('submitDraft', () => {
  it('invalid draft returns errors and changes nothing', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000006';
    await repo.createDraft(worker1, id); // description is '' -- invalid
    const result = await repo.submitDraft(worker1, id);
    expect(result.ok).toBe(false);
    const report = await db.reports.get(id);
    expect(report?.status).toBe('draft');
    expect(report?.sync_state).toBeNull();
    const ops = await db.outbox.where('report_id').equals(id).toArray();
    expect(ops).toHaveLength(0);
    await db.delete();
  });

  it('valid draft becomes submitted + pending with exactly one outbox op', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000007';
    await repo.createDraft(worker1, id, VALID_FIELDS);
    const result = await repo.submitDraft(worker1, id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.status).toBe('submitted');
    expect(result.report.sync_state).toBe('pending');
    const ops = await db.outbox.where('report_id').equals(id).toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('create');
    await db.delete();
  });

  it('a second submit enqueues nothing', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000008';
    await repo.createDraft(worker1, id, VALID_FIELDS);
    await repo.submitDraft(worker1, id);
    const result = await repo.submitDraft(worker1, id);
    expect(result.ok).toBe(true);
    const ops = await db.outbox.where('report_id').equals(id).toArray();
    expect(ops).toHaveLength(1);
    await db.delete();
  });

  it('is atomic -- outbox failure leaves the report as draft', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-000000000009';
    await repo.createDraft(worker1, id, VALID_FIELDS);

    vi.spyOn(db.outbox, 'add').mockRejectedValueOnce(new Error('disk full'));

    const result = await repo.submitDraft(worker1, id);
    expect(result.ok).toBe(false);

    const report = await db.reports.get(id);
    expect(report?.status).toBe('draft');
    expect(report?.sync_state).toBeNull();
    const ops = await db.outbox.where('report_id').equals(id).toArray();
    expect(ops).toHaveLength(0);
    await db.delete();
  });
});

// ---------------------------------------------------------------------------
// Ownership & identity switching
// ---------------------------------------------------------------------------

describe('ownership', () => {
  it('a non-owner cannot update a draft', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-00000000000a';
    await repo.createDraft(worker1, id);
    await expect(
      repo.updateDraft(worker2, id, { description: 'hijack' }),
    ).rejects.toThrow();
    await db.delete();
  });

  it('a non-owner cannot submit a draft', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-00000000000b';
    await repo.createDraft(worker1, id, VALID_FIELDS);
    const result = await repo.submitDraft(worker2, id);
    expect(result.ok).toBe(false);
    await db.delete();
  });

  it('after switching identity the original draft is still readable as its owner', async () => {
    const db = freshDb();
    const repo = createRepository(db);
    const id = 'aaaaaaaa-0000-4000-8000-00000000000c';
    await repo.createDraft(worker1, id);

    // worker2 cannot see it
    expect(await repo.getReport(worker2, id)).toBeUndefined();
    const w2list = await repo.listReports(worker2);
    expect(w2list.find((r) => r.id === id)).toBeUndefined();

    // worker1 still can
    expect(await repo.getReport(worker1, id)).toBeDefined();
    await db.delete();
  });
});

// ---------------------------------------------------------------------------
// listReports ordering
// ---------------------------------------------------------------------------

describe('listReports', () => {
  it("returns only the active user's reports, newest updated_at first", async () => {
    const db = freshDb();
    const clock = makeClock(1_000_000);
    const repo = createRepository(db, { now: clock });

    const id1 = 'aaaaaaaa-0000-4000-8000-00000000000d';
    const id2 = 'aaaaaaaa-0000-4000-8000-00000000000e';
    const id3 = 'aaaaaaaa-0000-4000-8000-00000000000f';

    await repo.createDraft(worker1, id1); // ticks: created_at=T0 updated_at=T1, event=T2
    await repo.createDraft(worker1, id2); // ticks: created_at=T3 updated_at=T4, event=T5
    await repo.createDraft(worker2, id3); // worker2's, should not appear

    const list = await repo.listReports(worker1);
    expect(list).toHaveLength(2);
    // id2 was created later so its updated_at is larger
    expect(list[0].id).toBe(id2);
    expect(list[1].id).toBe(id1);
    await db.delete();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('data survives closing and reopening the database', async () => {
    const dbName = `test-db-persist-${dbCounter++}`;
    const db1 = new AppDb(dbName);
    const repo1 = createRepository(db1);
    const id = 'aaaaaaaa-0000-4000-8000-000000000010';
    await repo1.createDraft(worker1, id, VALID_FIELDS);
    await repo1.submitDraft(worker1, id);
    db1.close();

    const db2 = new AppDb(dbName);
    const report = await db2.reports.get(id);
    const events = await db2.reportHistory.where('report_id').equals(id).toArray();
    const ops = await db2.outbox.where('report_id').equals(id).toArray();
    expect(report?.status).toBe('submitted');
    expect(events).toHaveLength(1);
    expect(ops).toHaveLength(1);
    await db2.delete();
  });
});
