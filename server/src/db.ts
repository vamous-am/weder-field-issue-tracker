import { DatabaseSync } from 'node:sqlite';
import { CATEGORIES, PRIORITIES, STATUSES, HISTORY_ACTIONS } from '@shared/types';

export type Database = DatabaseSync;

// Build enum CHECK values from shared constants — one source of truth (§3).
// Safe to interpolate: these are compile-time constants, not user input.
const CATEGORY_CHECK = CATEGORIES.map((c) => `'${c}'`).join(', ');
const PRIORITY_CHECK = PRIORITIES.map((p) => `'${p}'`).join(', ');
// Server never stores draft (§2.5) — excluded from the CHECK.
const STATUS_CHECK = STATUSES.filter((s) => s !== 'draft')
  .map((s) => `'${s}'`)
  .join(', ');
// Built from shared constant — one source of truth for valid history actions.
const HISTORY_ACTION_CHECK = HISTORY_ACTIONS.map((a) => `'${a}'`).join(', ');

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id               TEXT    NOT NULL PRIMARY KEY,
      reporter_id      TEXT    NOT NULL,
      category         TEXT    NOT NULL CHECK (category IN (${CATEGORY_CHECK})),
      description      TEXT    NOT NULL,
      location         TEXT,
      lat              REAL    CHECK (lat IS NULL OR (lat >= -90  AND lat <= 90)),
      lng              REAL    CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)),
      priority         TEXT    NOT NULL CHECK (priority IN (${PRIORITY_CHECK})),
      status           TEXT    NOT NULL CHECK (status IN (${STATUS_CHECK})),
      reported_at      TEXT    NOT NULL,
      created_at       TEXT    NOT NULL,
      received_at      TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL,
      version          INTEGER NOT NULL DEFAULT 1,
      assigned_to      TEXT,
      resolution_notes TEXT,
      -- lat and lng must be provided together or not at all (§4, §2)
      CHECK ((lat IS NULL) = (lng IS NULL))
    );

    CREATE TABLE IF NOT EXISTS report_history (
      id          TEXT    NOT NULL PRIMARY KEY,
      report_id   TEXT    NOT NULL REFERENCES reports(id),
      action      TEXT    NOT NULL CHECK (action IN (${HISTORY_ACTION_CHECK})),
      old_value   TEXT,
      new_value   TEXT,
      actor_role  TEXT    NOT NULL,
      actor_id    TEXT,
      timestamp   TEXT    NOT NULL
    );
  `);
}

export function createDb(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  initSchema(db);
  return db;
}

/**
 * Synchronous transaction helper for node:sqlite, which has no .transaction()
 * method unlike better-sqlite3.
 *
 * BEGIN IMMEDIATE takes the write lock upfront so a check-then-insert cannot
 * race with another request. fn() must be synchronous — an await inside would
 * allow other requests to interleave on the same connection mid-transaction.
 */
export function runInTransaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* keep the original error */ }
    throw err;
  }
}
