/**
 * Pure request classification for the service worker.
 * Exported as an ES module so it can be unit-tested directly.
 *
 * @param {{ method: string, url: string, mode: string }} req
 * @param {string} origin - the SW's own origin (self.location.origin)
 * @param {ReadonlySet<string>} precacheSet - set of precached URL pathnames
 * @returns {'navigation' | 'asset' | 'bypass'}
 */
export function classifyRequest(req, origin, precacheSet) {
  // Only handle GET.
  if (req.method !== 'GET') return 'bypass';

  // Only handle same-origin.
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return 'bypass';
  }
  if (url.origin !== origin) return 'bypass';

  const path = url.pathname;

  // Never intercept the worker itself.
  if (path === '/sw.js') return 'bypass';

  // Never intercept API calls — check before navigation so a browser
  // navigation to /api/something still gets a JSON response from the server.
  if (path.startsWith('/api/')) return 'bypass';

  // Navigation request (typed URL, link click, back/forward).
  if (req.mode === 'navigate') return 'navigation';

  // Sub-resource: only handle if it's in the precache manifest.
  if (precacheSet.has(path)) return 'asset';

  return 'bypass';
}
