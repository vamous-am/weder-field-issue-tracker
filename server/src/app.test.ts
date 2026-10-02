import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDb } from './db.js';
import { createApp } from './app.js';

// ── Fixture: a minimal dist/ directory ───────────────────────────────────────

let distDir: string;

beforeAll(() => {
  distDir = mkdtempSync(path.join(tmpdir(), 'weder-test-dist-'));
  // Minimal shell — just needs to exist for sendFile.
  writeFileSync(path.join(distDir, 'index.html'), '<html><body>app</body></html>');
  // A nested asset to confirm static serving works.
  mkdirSync(path.join(distDir, 'assets'));
  writeFileSync(path.join(distDir, 'assets', 'main.js'), 'console.log("app")');
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

function makeApp() {
  // In-memory DB — no file on disk needed for these tests.
  const db = createDb(':memory:');
  return createApp(db, { webDist: distDir });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('static serving and SPA fallback', () => {
  it('unknown /api/* route returns a JSON 404', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('a deep non-API route returns index.html', async () => {
    const app = makeApp();
    const res = await request(app).get('/reports/some-uuid');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('app');
  });

  it('a static asset is served directly', async () => {
    const app = makeApp();
    const res = await request(app).get('/assets/main.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log');
  });

  it('/api/health still works', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
