import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { AppDb } from './schema';
import { Autosaver } from './autosaver';
import type { Identity } from '../identity';

// Use debounceMs=0 so the timer fires immediately on the next macrotask tick.
// This avoids fighting fake-timer / IDB microtask ordering -- the coalescing
// and sequencing logic is what we're testing, not the timer interval itself.

let dbCounter = 0;
function freshDb() {
  return new AppDb(`autosaver-db-${dbCounter++}`);
}

const worker1: Identity = { user_id: 'worker-1', role: 'field_worker' };

/** Yield to the event loop once (lets debounce=0 timers fire). */
function nextTick() {
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
