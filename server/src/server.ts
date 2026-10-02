import path from 'node:path';
import { createDb } from './db.js';
import { createApp } from './app.js';

const dbPath = process.env.DB_PATH
  ?? path.join(import.meta.dirname, '../../data.sqlite');

const distDir = path.join(import.meta.dirname, '../../web/dist');

const db = createDb(dbPath);
const app = createApp(db, { webDist: distDir });
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => console.log(`server on :${port}`));
