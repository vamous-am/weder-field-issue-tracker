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
  /**
   * Absolute path to the built web app (dist/).
   * When omitted, static serving is disabled — only API routes are active.
   * server.ts passes this explicitly; tests omit it or pass a temp dir.
   */
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

  // ── Static web app (only when webDist is explicitly supplied) ───────────────
  if (options.webDist && existsSync(options.webDist)) {
    const distDir = options.webDist;

    // sw.js must never be served from a stale browser cache — the browser's
    // SW update check depends on seeing a fresh response every time.
    app.get('/sw.js', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-cache');
      next();
    });

    app.use(express.static(distDir));

    // SPA fallback: any GET that is neither /api nor /api/* falls through to
    // the shell.  Unknown /api and /api/* still reach the JSON error handlers.
    app.get(/^(?!\/api(?:\/|$))/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // ── Error handlers (must be after all routes) ───────────────────────────────
  app.use(notFoundHandler);
  app.use(bodyParserErrorHandler);
  app.use(apiErrorHandler);
  app.use(internalErrorHandler);

  return app;
}
