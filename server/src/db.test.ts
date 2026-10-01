// Verifies node:sqlite works under Vitest (known vite-node stripping issue).
// If this fails with "Failed to load url sqlite", upgrade vitest to ^3.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDb, runInTransaction } from './db.js';

describe('node:sqlite sanity check', () => {
  it('DatabaseSync works in-memory', () => {
    const db = new DatabaseSync(':memory:');
    const row = db.prepare('SELECT 1 AS n').get() as { n: number };
    assert.equal(row.n, 1);
  });

  it('createDb initialises both tables', () => {
    const db = createDb(':memory:');
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    assert.ok(names.includes('reports'), 'reports table missing');
    assert.ok(names.includes('report_history'), 'report_history table missing');
  });
});

describe('runInTransaction — rollback on throw', () => {
  it('rolls back an insert when the callback throws', () => {
    const db = createDb(':memory:');
    const ISO = '2026-10-01T08:00:00.000Z';
    try {
      runInTransaction(db, () => {
        db.prepare(`
          INSERT INTO reports (id, reporter_id, category, description, location,
            lat, lng, priority, status, reported_at, created_at, received_at,
            updated_at, version)
          VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          '44444444-4444-4444-8444-444444444444',
          'worker-1', 'water_point', 'test', 'high', 'submitted',
          ISO, ISO, ISO, ISO,
        );
        throw new Error('deliberate rollback');
      });
    } catch { /* expected */ }

    const row = db
      .prepare('SELECT id FROM reports WHERE id = ?')
      .get('44444444-4444-4444-8444-444444444444');
    assert.equal(row, undefined, 'row must not exist after rollback');
  });
});
