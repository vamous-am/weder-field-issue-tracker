import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AppDb } from './schema';
import { Autosaver } from './autosaver';
import type { Identity } from '../identity';

// Use debounceMs=0 for sequencing/coalescing/recovery tests (avoids the
// fake-timer / IDB setImmediate conflict). A separate suite uses
// toFake: ['setTimeout', 'clearTimeout'] only, which leaves IDB's
// setImmediate untouched, so the 300 ms boundary can be tested directly.

let dbCounter = 0;
function freshDb() {
  return new AppDb(`autosaver-db-${dbCounter++}`);
}

const worker1: Identity = { user_id: 'worker-1', role: 'field_worker' };

/** Yield to the event loop once (lets debounce=0 timers fire). */function nextTick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Autosaver', () => {
  it('rapid changes coalesce into one write', async () => {
    const db = freshDb();
    const saver = new Autosaver(db, worker1, null, 0);

    saver.onChange({ description: 'first' });
    saver.onChange({ description: 'second' });
    saver.onChange({ description: 'third' });

    await nextTick();
    await saver.drain();

    const id = saver.id!;
    expect(id).not.toBeNull();
    const report = await db.reports.get(id);
    expect(report?.description).toBe('third');

    // Only one report created, not three
    expect(await db.reports.count()).toBe(1);
    await db.delete();
  });

  it('the first change creates the record; subsequent changes update it', async () => {
    const db = freshDb();
    const saver = new Autosaver(db, worker1, null, 0);

    saver.onChange({ description: 'hello' });
    await nextTick();
    await saver.drain();

    const id = saver.id!;
    expect(id).not.toBeNull();
    expect((await db.reports.get(id))?.description).toBe('hello');

    saver.onChange({ description: 'world' });
    await nextTick();
    await saver.drain();

    expect((await db.reports.get(id))?.description).toBe('world');

    // One report, one history event (the created event from createDraft)
    expect(await db.reports.count()).toBe(1);
    expect(await db.reportHistory.count()).toBe(1);
    await db.delete();
  });

  it('flush() commits pending changes immediately', async () => {
    const db = freshDb();
    const saver = new Autosaver(db, worker1, null, 300); // long debounce

    saver.onChange({ description: 'flushed' });
    saver.flush(); // bypass the 300ms
    await saver.drain();

    const id = saver.id!;
    expect((await db.reports.get(id))?.description).toBe('flushed');
    await db.delete();
  });

  it('a failed write does not block later writes', async () => {
    const db = freshDb();
    const saver = new Autosaver(db, worker1, null, 0);

    // Create the record first
    saver.onChange({ description: 'good' });
    await nextTick();
    await saver.drain();

    // Poison the next update
    vi.spyOn(db.reports, 'put').mockRejectedValueOnce(new Error('quota exceeded'));
    saver.onChange({ description: 'bad write' });
    await nextTick();
    await saver.drain();

    expect(saver.saveError).toContain('quota exceeded');

    // Third write must succeed
    vi.restoreAllMocks();
    saver.onChange({ description: 'recovered' });
    await nextTick();
    await saver.drain();

    const id = saver.id!;
    expect((await db.reports.get(id))?.description).toBe('recovered');
    expect(saver.saveError).toBeNull();
    await db.delete();
  });
});

// ---------------------------------------------------------------------------
// Debounce timing — only fakes setTimeout/clearTimeout so IDB's setImmediate
// keeps running and transactions can resolve normally.
// ---------------------------------------------------------------------------

describe('Autosaver debounce timing', () => {
  afterEach(() => vi.useRealTimers());

  it('does not write before 300 ms but writes exactly once after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const db = new AppDb(`autosaver-db-timing-${dbCounter++}`);
    const saver = new Autosaver(db, worker1, null, 300);

    saver.onChange({ description: 'debounced' });

    // 299 ms -- timer has not fired yet, no write
    await vi.advanceTimersByTimeAsync(299);
    expect(await db.reports.count()).toBe(0);

    // 1 ms more -- timer fires, IDB write completes
    await vi.advanceTimersByTimeAsync(1);
    await saver.drain();

    expect(await db.reports.count()).toBe(1);
    expect((await db.reports.toArray())[0].description).toBe('debounced');

    await db.delete();
    vi.useRealTimers();
  });
});
