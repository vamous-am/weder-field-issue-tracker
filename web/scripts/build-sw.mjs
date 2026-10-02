/**
 * Post-build script: fills placeholders in dist/sw.js.
 *
 * - Walks dist/, collects every file except sw.js, sw-routing.js, *.map
 *   and any path containing a dot-directory segment.
 * - Converts OS paths to forward-slash URL strings.
 * - Adds '/' to the list (the root HTML is served as /index.html).
 * - Hashes all collected file contents → cache name.
 * - Writes the filled-in copy over dist/sw.js.
 *
 * No external dependencies — only Node built-ins.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');

// ── Collect files ─────────────────────────────────────────────────────────────

/**
 * Walk `dir` recursively, yielding absolute paths.
 * Skips dot-directories (e.g. .vite) and the files excluded by the spec.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue; // dot-directory guard
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      results.push(...walk(abs));
    } else {
      results.push(abs);
    }
  }
  return results;
}

const allFiles = walk(distDir);

const EXCLUDED = new Set(['sw.js', 'sw-routing.js']);

const precacheFiles = allFiles.filter((abs) => {
  const rel = path.relative(distDir, abs);
  // Skip map files and TypeScript declaration files.
  if (rel.endsWith('.map') || rel.endsWith('.d.ts')) return false;
  // Skip excluded names (sw itself, routing module).
  if (EXCLUDED.has(path.basename(abs))) return false;
  // Skip anything inside a dot-directory anywhere in the path.
  if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return false;
  return true;
});

// Convert to forward-slash URL strings (Windows path.relative gives backslashes).
const precacheUrls = [
  '/',
  ...precacheFiles.map((abs) => {
    const rel = path.relative(distDir, abs).split(path.sep).join('/');
    return `/${rel}`;
  }),
];

// ── Hash ──────────────────────────────────────────────────────────────────────

const hash = createHash('sha256');
for (const abs of precacheFiles) {
  hash.update(readFileSync(abs));
}
const cacheName = `weder-v${hash.digest('hex').slice(0, 12)}`;

// ── Fill placeholders ─────────────────────────────────────────────────────────

const swTemplate = readFileSync(path.join(distDir, 'sw.js'), 'utf8');

const filled = swTemplate
  .replace("'__CACHE_NAME__'", JSON.stringify(cacheName))
  .replace("'__PRECACHE__'", JSON.stringify(JSON.stringify(precacheUrls)));

writeFileSync(path.join(distDir, 'sw.js'), filled, 'utf8');

console.log(`build-sw: cache name = ${cacheName}`);
console.log(`build-sw: ${precacheUrls.length} URLs precached`);
precacheUrls.forEach((u) => console.log(`  ${u}`));
