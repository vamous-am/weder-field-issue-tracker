/**
 * Seed script — populates the SQLite DB with demo data.
 *
 * Usage:
 *   node server/scripts/seed.mjs              # uses data.sqlite at repo root
 *   DB_PATH=./custom.sqlite node server/scripts/seed.mjs
 *
 * Idempotent: each report has a fixed UUID so re-running is safe.
 * Only inserts rows that don't already exist.
 *
 * No external dependencies — uses node:sqlite directly.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH
  ?? path.join(__dirname, '../../data.sqlite');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date().toISOString();

function insertReport(r) {
  const exists = db.prepare('SELECT 1 FROM reports WHERE id = ?').get(r.id);
  if (exists) {
    console.log(`  skip  ${r.id.slice(0, 8)}  (${r.status})`);
    return;
  }
  db.prepare(`
    INSERT INTO reports
      (id, reporter_id, category, description, location, lat, lng,
       priority, status, reported_at, created_at, received_at,
       updated_at, version, assigned_to, resolution_notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    r.id, r.reporter_id, r.category, r.description,
    r.location ?? null, r.lat ?? null, r.lng ?? null,
    r.priority, r.status,
    r.reported_at ?? now, r.created_at ?? now, now, now,
    r.version ?? 1,
    r.assigned_to ?? null, r.resolution_notes ?? null,
  );

  db.prepare(`
    INSERT INTO report_history (id, report_id, action, old_value, new_value, actor_role, actor_id, timestamp)
    VALUES (?, ?, 'created', NULL, NULL, 'field_worker', ?, ?)
  `).run(randomUUID(), r.id, r.reporter_id, r.created_at ?? now);

  console.log(`  insert ${r.id.slice(0, 8)}  (${r.status})`);
}

// ── Seed data ─────────────────────────────────────────────────────────────────

const reports = [
  {
    id: '11111111-0000-4000-8000-000000000001',
    reporter_id: 'worker-1',
    category: 'water_point',
    description: 'Hand pump at well B3 is leaking around the base. Water pooling on the ground.',
    location: 'Village Kara, well B3',
    priority: 'high',
    status: 'submitted',
  },
  {
    id: '11111111-0000-4000-8000-000000000002',
    reporter_id: 'worker-1',
    category: 'equipment',
    description: 'Generator at health post needs fuel filter replaced. Last service was 6 months ago.',
    location: 'Health Post 4, generator shed',
    priority: 'medium',
    status: 'assigned',
    version: 2,
    assigned_to: 'coordinator-1',
  },
  {
    id: '11111111-0000-4000-8000-000000000003',
    reporter_id: 'worker-2',
    category: 'safety',
    description: 'Exposed electrical wiring near school entrance. Children walk past daily.',
    location: 'Primary School, east entrance',
    priority: 'critical',
    status: 'in_progress',
    version: 3,
    assigned_to: 'coordinator-1',
  },
  {
    id: '11111111-0000-4000-8000-000000000004',
    reporter_id: 'worker-2',
    category: 'maintenance',
    description: 'Roof of community centre leaking during rains. Three sections affected.',
    location: 'Community Centre, main hall',
    priority: 'medium',
    status: 'resolved',
    version: 3,
    resolution_notes: 'Temporary patching applied. Permanent repair scheduled for next dry season.',
  },
  {
    id: '11111111-0000-4000-8000-000000000005',
    reporter_id: 'worker-1',
    category: 'service_interruption',
    description: 'Water supply to blocks C and D interrupted since yesterday morning.',
    location: 'Residential blocks C–D',
    priority: 'high',
    status: 'rejected',
    version: 2,
    resolution_notes: 'Duplicate report — already tracked under report 003. Please use that thread.',
  },
];

console.log(`Seeding ${dbPath}`);
for (const r of reports) insertReport(r);
console.log('Done.');
