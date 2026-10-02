/**
 * Tests for the service worker routing function.
 * Importing the JS directly — no transpilation step needed for pure logic.
 */
import { describe, it, expect } from 'vitest';
import { classifyRequest } from '../../public/sw-routing.js';

const ORIGIN = 'https://example.com';
const PRECACHE = new Set(['/index.html', '/assets/index-abc123.js', '/assets/style-def456.css']);

function req(method: string, pathname: string, mode = 'no-cors'): { method: string; url: string; mode: string } {
  return { method, url: `${ORIGIN}${pathname}`, mode };
}

describe('classifyRequest', () => {
  it('precached asset returns "asset"', () => {
    expect(classifyRequest(req('GET', '/assets/index-abc123.js'), ORIGIN, PRECACHE)).toBe('asset');
  });

  it('unknown asset path returns "bypass"', () => {
    expect(classifyRequest(req('GET', '/assets/unknown-xyz.js'), ORIGIN, PRECACHE)).toBe('bypass');
  });

  it('POST returns "bypass"', () => {
    expect(classifyRequest(req('POST', '/assets/index-abc123.js', 'cors'), ORIGIN, PRECACHE)).toBe('bypass');
  });

  it('HEAD returns "bypass"', () => {
    expect(classifyRequest(req('HEAD', '/index.html'), ORIGIN, PRECACHE)).toBe('bypass');
  });

  it('/api/reports fetch returns "bypass"', () => {
    expect(classifyRequest(req('GET', '/api/reports'), ORIGIN, PRECACHE)).toBe('bypass');
  });

  it('navigation to /api/reports returns "bypass" (API path checked before navigate mode)', () => {
    expect(classifyRequest({ method: 'GET', url: `${ORIGIN}/api/reports`, mode: 'navigate' }, ORIGIN, PRECACHE)).toBe('bypass');
  });

  it('navigation to / returns "navigation"', () => {
    expect(classifyRequest({ method: 'GET', url: `${ORIGIN}/`, mode: 'navigate' }, ORIGIN, PRECACHE)).toBe('navigation');
  });

  it('navigation to /anything?x=1 returns "navigation"', () => {
    expect(classifyRequest({ method: 'GET', url: `${ORIGIN}/anything?x=1`, mode: 'navigate' }, ORIGIN, PRECACHE)).toBe('navigation');
  });

  it('cross-origin returns "bypass"', () => {
    expect(classifyRequest(req('GET', '/index.html'), 'https://other.com', PRECACHE)).toBe('bypass');
    // also: request from a different origin than the SW
    expect(classifyRequest({ method: 'GET', url: 'https://cdn.example.com/lib.js', mode: 'no-cors' }, ORIGIN, PRECACHE)).toBe('bypass');
  });

  it('/sw.js returns "bypass"', () => {
    expect(classifyRequest(req('GET', '/sw.js'), ORIGIN, PRECACHE)).toBe('bypass');
  });
});
