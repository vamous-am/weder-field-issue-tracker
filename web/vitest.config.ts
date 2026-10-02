import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../shared') }
  },
  test: {
    environment: 'jsdom',
    environmentMatchGlobs: [
      // repository tests use fake-indexeddb which works fine under node
      ['src/db/**', 'node'],
      // routing tests are pure logic — no DOM needed
      ['src/sw/**', 'node'],
    ],
  }
});