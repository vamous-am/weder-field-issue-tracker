import express from 'express';
import { hello } from '@shared/hello';
import { createReportsRouter } from './reports.js';
import {
  bodyParserErrorHandler,
  apiErrorHandler,
  internalErrorHandler,
  notFoundHandler,
} from './errors.js';
import type { Database } from './db.js';

export function createApp(db: Database) {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', shared: hello() });
  });

  app.use('/api/reports', createReportsRouter(db));

  // Must be after all routes, in this order:
  // 1. unknown routes → 404
  // 2. body-parser JSON errors → 400
  // 3. ApiError instances → their status code
  // 4. everything else → 500
  app.use(notFoundHandler);
  app.use(bodyParserErrorHandler);
  app.use(apiErrorHandler);
  app.use(internalErrorHandler);

  return app;
}
