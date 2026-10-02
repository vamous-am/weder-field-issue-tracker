import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hello } from '@shared/hello';
import { createReportsRouter } from './reports.js';
import {
  bodyParserErrorHandler,
  apiErrorHandler,
  internalErrorHandler,
  notFoundHandler,
} from './errors.js';
import type { Database } from './db.js';

export interface AppOptions {
  /** Absolute path to the built web app (dist/).  Skipped if absent. */
  webDist?: string;
}

export function createApp(db: Database, options: AppOptions = {}) {
  const app = express();
  app.use(express.json());

  // ── API routes ──────────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', shared: hello() });
  });

  app.use('/api/reports', createReportsRouter(db));

  // ── Static web app ──────────────────────────────────────────────────────────
  const distDir = options.webDist ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../web/dist',
  );

  if (existsSync(distDir)) {
    // sw.js must never be served from a stale browser cache — the browser's
    // SW update check depends on this response being fresh every time.
    app.get('/sw.js', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-cache');
      next(); // pass through to express.static below
    });

    app.use(express.static(distDir));

    // SPA fallback: any GET that isn't an /api route and wasn't served by
    // express.static gets the shell.  Unknown /api/* still hits the JSON
    // handlers below.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    console.log(`[server] web dist not found at ${distDir} — static serving skipped`);
  }

  // ── Error handlers (must be after all routes) ───────────────────────────────
  // Order: unknown API routes → 404 JSON; body-parse errors → 400 JSON;
  // ApiError → its status code; everything else → 500.
  app.use(notFoundHandler);
  app.use(bodyParserErrorHandler);
  app.use(apiErrorHandler);
  app.use(internalErrorHandler);

  return app;
}
