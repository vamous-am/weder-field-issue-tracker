/**
 * Generate a UUID v4.
 *
 * Uses crypto.randomUUID() when available (secure contexts: HTTPS or localhost).
 * Falls back to crypto.getRandomValues() for plain-HTTP LAN addresses.
 * Throws if neither exists — never falls back to Math.random().
 *
 * Version bits: 0100xxxx (4 in the third group).
 * Variant bits:  10xxxxxx (8/9/a/b in the fourth group).
 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version 4
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    // Set variant bits (10xx)
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [
      hex(bytes, 0, 4),
      hex(bytes, 4, 6),
      hex(bytes, 6, 8),
      hex(bytes, 8, 10),
      hex(bytes, 10, 16),
    ].join('-');
  }

  throw new Error('newId: no secure random source available');
}

function hex(bytes: Uint8Array, start: number, end: number): string {
  return Array.from(bytes.slice(start, end))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
