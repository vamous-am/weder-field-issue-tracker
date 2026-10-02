/**
 * Tests for M7a pull sync.
 *
 * Split into two sections:
 *   1. Pure merge functions (mergeEvents, mergeServerReport) — no DB needed.
 *   2. pullOnce integration — fake fetch + real Dexie (fake-indexeddb).
 *
 * Required scenarios from spec:
 *  a. a server status change propagates
 *  b. a pending op is skipped
 *  c. a dirty or failed-op report keeps its local content while status updates
 *  d. a draft is untouched
 *  e. a server-only report is inserted
 *  f. two pulls leave no duplicate events
 *  g. a failed pull changes nothing
 *  h. a local sync_failed event survives a pull
 *  i. a pull never touches a report owned by a different reporter_id
 *  j. GET /:id called only when version differs or no events held
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mergeEvents, mergeServerReport } from './pullMerge';
import type { ServerReportRow, ServerEventRow } from './pullMerge';
import { AppDb } from './schema';
import { createSyncEngine } from './syncEngine';
import { createRepository } from './repository';
import type { LocalReport, LocalHistoryEvent } from './types';
import type { Identity } from '../identity';

// ── Helpers ───────────────────────────────────────────────────────────────────

let dbCounter = 0;
function freshDb() { return new AppDb(`pull-sync-db-${dbCounter++}`); }

const worker1: Identity = { user_id: 'worker-1', role: 'field_worker' };
const ts  = '2026-10-01T08:00:00.000Z';
const ts2 = '2026-10-01T09:00:00.000Z';

function makeLocalReport(overrides: Partial<LocalReport> = {}): LocalReport {
  return {
    id: 'r-1',
    reporter_id: 'worker-1',
    status: 'submitted',
    version: 1,
    category: 'maintenance',
    description: 'Hand pump',
    location: 'Village A',
    lat: null, lng: null,
    priority: 'low',
    reported_at: ts,
    created_at: ts,
    updated_at: ts,
    received_at: ts,
    assigned_to: null,
    resolution_notes: null,
    sync_state: 'synced',
    attempts: 0,
    last_error: null,
    content_dirty: false,
    ...overrides,
  };
}

function makeServerRow(overrides: Partial<ServerReportRow> = {}): ServerReportRow {
  return {
    id: 'r-1',
    reporter_id: 'worker-1',
    status: 'assigned',
    version: 2,
    category: 'maintenance',
    description: 'Hand pump',
    location: 'Village A',
    lat: null, lng: null,
    priority: 'low',
    reported_at: ts,
    created_at: ts,
    updated_at: ts2,
    received_at: ts,
    assigned_to: 'coordinator-1',
    resolution_notes: null,
    ...overrides,
  };
}

function makeLocalEvent(overrides: Partial<LocalHistoryEvent> = {}): LocalHistoryEvent {
  return {
    id: 'ev-1',
    report_id: 'r-1',
    action: 'created',
    old_value: null,
    new_value: null,
    actor_role: 'field_worker',
    actor_id: 'worker-1',
    timestamp: ts,
    uploaded: true,
    ...overrides,
  };
}

function makeServerEvent(overrides: Partial<ServerEventRow> = {}): ServerEventRow {
  return {
    id: 'ev-2',
    report_id: 'r-1',
    action: 'status_changed',
    old_value: JSON.stringify({ status: 'submitted' }),
    new_value: JSON.stringify({ status: 'assigned' }),
    actor_role: 'coordinator',
    actor_id: 'coordinator-1',
    timestamp: ts2,
    ...overrides,
  };
}

// ── 1. Pure merge functions ───────────────────────────────────────────────────

describe('mergeServerReport', () => {
  it('(a) server status change propagates for a normal synced report', () => {
    const local = makeLocalReport({ sync_state: 'synced' });
    const server = makeServerRow({ status: 'assigned', version: 2, assigned_to: 'coordinator-1' });
    const result = mergeServerReport(local, server, false);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('assigned');
    expect(result!.version).toBe(2);
    expect(result!.assigned_to).toBe('coordinator-1');
    // client-only fields preserved
    expect(result!.sync_state).toBe('synced');
    expect(result!.attempts).toBe(0);
  });

  it('(b) pending op is skipped — returns null', () => {
    const local = makeLocalReport({ sync_state: 'pending' });
    const result = mergeServerReport(local, makeServerRow(), true);
    expect(result).toBeNull();
  });

  it('(b) syncing op is also skipped', () => {
    const local = makeLocalReport({ sync_state: 'syncing' });
    const result = mergeServerReport(local, makeServerRow(), true);
    expect(result).toBeNull();
  });

  it('(c) failed-op report keeps local content, takes server status/version', () => {
    const local = makeLocalReport({
      sync_state: 'failed',
      description: 'Edited locally',
      status: 'submitted',
      version: 1,
    });
    const server = makeServerRow({ status: 'rejected', version: 3, resolution_notes: 'Incomplete' });
    const result = mergeServerReport(local, server, false);
    expect(result).not.toBeNull();
    // server metadata
    expect(result!.status).toBe('rejected');
    expect(result!.version).toBe(3);
    expect(result!.resolution_notes).toBe('Incomplete');
    // local content preserved
    expect(result!.description).toBe('Edited locally');
    expect(result!.sync_state).toBe('failed');
  });

  it('(c) content_dirty report keeps local content, takes server status', () => {
    const local = makeLocalReport({
      content_dirty: true,
      sync_state: 'synced',
      description: 'Dirty edit',
      status: 'rejected',
    });
    const server = makeServerRow({ status: 'rejected', version: 2, resolution_notes: 'Bad data' });
    const result = mergeServerReport(local, server, false);
    expect(result!.description).toBe('Dirty edit');
    expect(result!.status).toBe('rejected');
    expect(result!.resolution_notes).toBe('Bad data');
    expect(result!.content_dirty).toBe(true);
  });

  it('(d) draft is untouched — returns null', () => {
    const local = makeLocalReport({ status: 'draft', sync_state: null });
    const result = mergeServerReport(local, makeServerRow(), false);
    expect(result).toBeNull();
  });

  it('(e) server-only report (null local) is inserted as synced', () => {
    const server = makeServerRow({ id: 'r-new', status: 'submitted', version: 1 });
    const result = mergeServerReport(null, server, false);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('r-new');
    expect(result!.sync_state).toBe('synced');
    expect(result!.content_dirty).toBe(false);
    expect(result!.attempts).toBe(0);
  });
});

describe('mergeEvents', () => {
  it('(f) same server event returned twice — no duplicates', () => {
    const local = [makeLocalEvent({ id: 'ev-1' })];
    const server = [makeServerEvent({ id: 'ev-1', action: 'created', timestamp: ts })];
    const first  = mergeEvents(local, server, 'r-1');
    const second = mergeEvents(first, server, 'r-1');
    const ids = second.map((e) => e.id);
    expect(ids).toHaveLength(new Set(ids).size);  // all unique
    expect(ids.filter((id) => id === 'ev-1')).toHaveLength(1);
  });

  it('server event wins over local copy for the same UUID', () => {
    const local = [makeLocalEvent({ id: 'ev-1', action: 'created', uploaded: false })];
    const server = [makeServerEvent({ id: 'ev-1', action: 'created', timestamp: ts2 })];
    const result = mergeEvents(local, server, 'r-1');
    expect(result).toHaveLength(1);
    expect(result[0].uploaded).toBe(true);
    expect(result[0].timestamp).toBe(ts2);
  });

  it('local-only event survives with uploaded=false', () => {
    const local = [makeLocalEvent({ id: 'local-only', uploaded: false })];
    const server = [makeServerEvent({ id: 'sv-ev' })];
    const result = mergeEvents(local, server, 'r-1');
    const localOnly = result.find((e) => e.id === 'local-only')!;
    expect(localOnly.uploaded).toBe(false);
  });

  it('(h) local sync_failed event survives a pull', () => {
    const syncFailed: LocalHistoryEvent = {
      ...makeLocalEvent({ id: 'sf-1', action: 'sync_failed', uploaded: false }),
    };
    const result = mergeEvents([syncFailed], [], 'r-1');
    expect(result.find((e) => e.id === 'sf-1')).toBeDefined();
    expect(result.find((e) => e.id === 'sf-1')!.uploaded).toBe(false);
  });

  it('server-only event is inserted as uploaded=true', () => {
    const result = mergeEvents([], [makeServerEvent({ id: 'sv-only' })], 'r-1');
    expect(result).toHaveLength(1);
    expect(result[0].uploaded).toBe(true);
  });

  it('result is sorted chronologically', () => {
    const local = [makeLocalEvent({ id: 'late', timestamp: ts2 })];
    const server = [makeServerEvent({ id: 'early', timestamp: ts })];
    const result = mergeEvents(local, server, 'r-1');
    expect(result[0].timestamp).toBe(ts);
    expect(result[1].timestamp).toBe(ts2);
  });
});

// ── 2. pullOnce integration ───────────────────────────────────────────────────

interface PullHarness {
  db: AppDb;
  repo: ReturnType<typeof createRepository>;
  calls: Array<[string, RequestInit]>;
  responses: Array<Response | Error>;
  engine: ReturnType<typeof createSyncEngine>;
}

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a minimal server list-response entry. */
function listRow(overrides: Partial<ServerReportRow> = {}): ServerReportRow {
  return makeServerRow(overrides);
}

/** Build a server detail response { report, events }. */
function detailRes(row: ServerReportRow, events: ServerEventRow[] = []) {
  return jsonRes(200, { report: row, events });
}

function setupPull(responses: Array<Response | Error> = []): PullHarness {
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
  });

  return { db, repo, calls, responses: queue, engine };
}

/** Seed a synced report (already on server). */
async function seedSynced(h: PullHarness, id = 'r-1', reporterId = 'worker-1') {
  const identity: Identity = { user_id: reporterId, role: 'field_worker' };
  await h.repo.createDraft(identity, id, { description: 'Hand pump', location: 'Village A' });
  await h.repo.submitDraft(identity, id);
  // Manually mark as synced with version 1 (simulates a prior successful push).
  await h.db.reports.where('id').equals(id).modify({
    sync_state: 'synced', version: 1, received_at: ts,
  });
  await h.db.outbox.where('report_id').equals(id).delete();
  return (await h.db.reports.get(id))!;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('pullOnce integration', () => {
  it('(a) server status change propagates to local report', async () => {
    const h = setupPull();
    await seedSynced(h);

    // List returns version=2, assigned; detail needed (version differs).
    const updated = listRow({ status: 'assigned', version: 2, assigned_to: 'coordinator-1' });
    const detailEvt = makeServerEvent({ id: 'ev-status', action: 'status_changed', timestamp: ts2 });

    // Responses: GET /api/reports?reporter=me, then GET /api/reports/r-1
    h.responses.length = 0;
    h.responses.push(
      jsonRes(200, { reports: [updated] }),
      detailRes(updated, [detailEvt]),
    );

    await h.engine.pullOnce('worker-1');

    const r = await h.db.reports.get('r-1');
    expect(r!.status).toBe('assigned');
    expect(r!.version).toBe(2);
    expect(r!.assigned_to).toBe('coordinator-1');
    const evts = await h.db.reportHistory.where('report_id').equals('r-1').toArray();
    expect(evts.some((e) => e.action === 'status_changed')).toBe(true);
  });

  it('(b) pending op is skipped — report unchanged', async () => {
    const h = setupPull();
    // Create a report with a pending outbox op (not yet synced).
    const identity: Identity = { user_id: 'worker-1', role: 'field_worker' };
    await h.repo.createDraft(identity, 'r-1', { description: 'Hand pump', location: 'Village A' });
    await h.repo.submitDraft(identity, 'r-1');
    // pending op still in outbox

    const server = listRow({ status: 'submitted', version: 1 });
    h.responses.length = 0;
    h.responses.push(jsonRes(200, { reports: [server] }));

    await h.engine.pullOnce('worker-1');

    const r = await h.db.reports.get('r-1');
    // Still pending (not touched by pull).
    expect(r!.sync_state).toBe('pending');
  });

  it('(c) failed-op report: status updated, local content preserved', async () => {
    const h = setupPull();
    await seedSynced(h);
    // Simulate a failed sync and a local content edit.
    await h.db.reports.where('id').equals('r-1').modify({
      sync_state: 'failed',
      description: 'Locally edited description',
    });

    const server = listRow({ status: 'rejected', version: 2, resolution_notes: 'Incomplete' });
    h.responses.length = 0;
    h.responses.push(
      jsonRes(200, { reports: [server] }),
      detailRes(server, [makeServerEvent({ id: 'ev-rej', action: 'status_changed', timestamp: ts2 })]),
    );

    await h.engine.pullOnce('worker-1');

    const r = await h.db.reports.get('r-1');
    expect(r!.status).toBe('rejected');
    expect(r!.resolution_notes).toBe('Incomplete');
    // local content kept
    expect(r!.description).toBe('Locally edited description');
    expect(r!.sync_state).toBe('failed');
  });

  it('(d) draft is untouched by pull', async () => {
    const h = setupPull();
    const identity: Identity = { user_id: 'worker-1', role: 'field_worker' };
    await h.repo.createDraft(identity, 'r-1', { description: 'Draft', location: 'X' });
    // Draft — no outbox op yet.

    // Server doesn't know about this draft (reporter=me list is empty).
    h.responses.length = 0;
    h.responses.push(jsonRes(200, { reports: [] }));

    await h.engine.pullOnce('worker-1');

    const r = await h.db.reports.get('r-1');
    expect(r!.status).toBe('draft');
    expect(r!.description).toBe('Draft');
  });

  it('(e) server-only report is inserted as synced', async () => {
    const h = setupPull();
    // Nothing in local DB for this report.
    const server = listRow({ id: 'r-new', status: 'submitted', version: 1, reporter_id: 'worker-1' });
    h.responses.length = 0;
    h.responses.push(
      jsonRes(200, { reports: [server] }),
      detailRes(server, [makeServerEvent({ id: 'ev-created', action: 'created', timestamp: ts })]),
    );

    await h.engine.pullOnce('worker-1');

    const r = await h.db.reports.get('r-new');
    expect(r).toBeDefined();
    expect(r!.sync_state).toBe('synced');
    expect(r!.content_dirty).toBe(false);
  });

  it('(f) two pulls leave no duplicate events', async () => {
    const h = setupPull();
    await seedSynced(h);

    const server = listRow({ status: 'assigned', version: 2 });
    const evt = makeServerEvent({ id: 'ev-assigned', action: 'status_changed', timestamp: ts2 });
    const listResponse = jsonRes(200, { reports: [server] });
    const detailResponse = detailRes(server, [evt]);

    // Each pull: list + detail.
    h.responses.length = 0;
    h.responses.push(listResponse, detailResponse, listResponse, detailResponse);

    await h.engine.pullOnce('worker-1');
    await h.engine.pullOnce('worker-1');

    const evts = await h.db.reportHistory.where('report_id').equals('r-1').toArray();
    const ids = evts.map((e) => e.id);
    expect(ids).toHaveLength(new Set(ids).size); // no duplicates
    expect(ids.filter((id) => id === 'ev-assigned')).toHaveLength(1);
  });

  it('(g) failed pull changes nothing', async () => {
    const h = setupPull();
    await seedSynced(h);
    const before = await h.db.reports.get('r-1');

    h.responses.length = 0;
    h.responses.push(new Error('Network failure'));

    await h.engine.pullOnce('worker-1'); // should not throw

    const after = await h.db.reports.get('r-1');
    expect(after).toEqual(before);
  });

  it('(h) local sync_failed event survives a pull', async () => {
    const h = setupPull();
    await seedSynced(h);

    // Plant a local sync_failed event.
    await h.db.reportHistory.add({
      id: 'sf-local',
      report_id: 'r-1',
      action: 'sync_failed',
      old_value: null,
      new_value: '{"error":"boom"}',
      actor_role: 'field_worker',
      actor_id: 'worker-1',
      timestamp: ts,
      uploaded: false,
    });

    const server = listRow({ status: 'assigned', version: 2 });
    h.responses.length = 0;
    h.responses.push(
      jsonRes(200, { reports: [server] }),
      detailRes(server, [makeServerEvent({ id: 'ev-a', action: 'status_changed', timestamp: ts2 })]),
    );

    await h.engine.pullOnce('worker-1');

    const evts = await h.db.reportHistory.where('report_id').equals('r-1').toArray();
    expect(evts.find((e) => e.id === 'sf-local')).toBeDefined();
    expect(evts.find((e) => e.id === 'sf-local')!.uploaded).toBe(false);
  });

  it('(i) pull never touches a report owned by a different reporter_id', async () => {
    const h = setupPull();
    // Seed a report for worker-2.
    const w2: Identity = { user_id: 'worker-2', role: 'field_worker' };
    await h.repo.createDraft(w2, 'r-w2', { description: 'Worker 2 report', location: 'B' });
    await h.repo.submitDraft(w2, 'r-w2');
    await h.db.reports.where('id').equals('r-w2').modify({ sync_state: 'synced', version: 1, received_at: ts });
    await h.db.outbox.where('report_id').equals('r-w2').delete();

    const before = await h.db.reports.get('r-w2');

    // Pull as worker-1 — list returns only worker-1's reports.
    h.responses.length = 0;
    h.responses.push(jsonRes(200, { reports: [] }));

    await h.engine.pullOnce('worker-1');

    const after = await h.db.reports.get('r-w2');
    expect(after).toEqual(before); // completely untouched
  });

  it('(j) GET /:id NOT called when version matches and local events exist', async () => {
    const h = setupPull();
    await seedSynced(h); // version=1

    // Plant a local event so "has events" is true.
    await h.db.reportHistory.add({
      ...makeLocalEvent({ id: 'ev-existing' }),
    });

    // Server returns same version=1 — no detail fetch needed.
    const server = listRow({ status: 'submitted', version: 1 });
    h.responses.length = 0;
    h.responses.push(jsonRes(200, { reports: [server] }));

    await h.engine.pullOnce('worker-1');

    // Only one call: the list.
    expect(h.calls.filter((c) => c[0].includes('/r-1'))).toHaveLength(0);
  });

  it('(j) GET /:id IS called when no local events are held', async () => {
    const h = setupPull();
    await seedSynced(h, 'r-1'); // version=1, no events planted after seedSynced
    // Remove all events (seedSynced doesn't plant any explicitly, but
    // createDraft adds a 'created' one — clear it to test the "no events" path).
    await h.db.reportHistory.where('report_id').equals('r-1').delete();

    const server = listRow({ status: 'submitted', version: 1 });
    h.responses.length = 0;
    h.responses.push(
      jsonRes(200, { reports: [server] }),
      detailRes(server, [makeServerEvent({ id: 'ev-created', action: 'created', timestamp: ts })]),
    );

    await h.engine.pullOnce('worker-1');

    expect(h.calls.some((c) => c[0].includes('/r-1'))).toBe(true);
  });
});
