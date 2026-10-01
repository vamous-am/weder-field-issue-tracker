// Verifies node:sqlite works under Vitest (known vite-node stripping issue).
// If this fails with "Failed to load url sqlite", upgrade vitest to ^3.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDb } from './db.js';

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
