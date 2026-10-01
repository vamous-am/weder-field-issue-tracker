
// Runs on every transition INTO `submitted` (§2.11) — both
// `draft → submitted` and `rejected → submitted` (via resubmit). Draft
// autosave is never validated (§2.11).
//
// Deliberately NOT checked here:
// - `status`: transitions are governed by TRANSITIONS/isValidTransition, and
//   rejecting `status: draft` payloads is a server-level rule (§2.5).
// - `resolution_notes`: required on reject/resolve, enforced by the API (§5).

import { CATEGORIES, PRIORITIES } from './types';
import type { Category, Priority, ReportContent } from './types';

/**
 * Loose shape a report payload arrives in before validation. Extra keys
 * (id, status, timestamps, ...) are ignored — validateReport owns content only.
 */
export interface ReportInput {
  category?: unknown;
  description?: unknown;
  /** Free-text location, one half of the "string and/or lat/lng" pair (§4). */
  location?: unknown;
  /** Coordinates: optional, but lat/lng must come together and be in range (§4). */
  lat?: unknown;
  lng?: unknown;
  priority?: unknown;
  /** Observation time, user-entered (§2 row 4). Must be canonical ISO 8601. */
  reported_at?: unknown;
  [key: string]: unknown;
}

export type ValidationResult =
  | { valid: true; value: ReportContent }
  | { valid: false; errors: string[] };

/**
 * Validate report content. On success returns the normalized content
 * (trimmed strings, coordinates as finite numbers or null). Otherwise
 * every problem found, in field order: category, description, location,
 * priority.
 *
 * Location rule: at least one of text or coordinates must be present.
 * The doc only pins "validated range if coordinates are used" (§4), so
 * requiring some form of location is a product assumption — list it in
 * the README assumptions.
 */
export function validateReport(
  input: ReportInput | null | undefined,
): ValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['input must be a non-null object'] };
  }

  const errors: string[] = [];

  // category — fixed enum (§4)
  if (
    typeof input.category !== 'string' ||
    !CATEGORIES.includes(input.category as Category)
  ) {
    errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  }

  // description — required at submit (§4)
  let description = '';
  if (
    typeof input.description !== 'string' ||
    input.description.trim().length === 0
  ) {
    errors.push('description must be a non-empty string');
  } else {
    description = input.description.trim();
  }

  // location — text and/or lat/lng (§4)
  let location: string | null = null;
  let lat: number | null = null;
  let lng: number | null = null;

  if (input.location !== undefined && input.location !== null) {
    if (typeof input.location !== 'string') {
      errors.push('location must be a string when provided');
    } else if (input.location.trim().length > 0) {
      location = input.location.trim(); // whitespace-only counts as absent
    }
  }

  const hasLat = input.lat !== undefined && input.lat !== null;
  const hasLng = input.lng !== undefined && input.lng !== null;
  if (hasLat !== hasLng) {
    errors.push('lat and lng must be provided together');
  } else if (hasLat && hasLng) {
    if (typeof input.lat !== 'number' || !Number.isFinite(input.lat)) {
      errors.push('lat must be a finite number');
    } else if (input.lat < -90 || input.lat > 90) {
      errors.push('lat must be between -90 and 90');
    } else {
      lat = input.lat;
    }
    if (typeof input.lng !== 'number' || !Number.isFinite(input.lng)) {
      errors.push('lng must be a finite number');
    } else if (input.lng < -180 || input.lng > 180) {
      errors.push('lng must be between -180 and 180');
    } else {
      lng = input.lng;
    }
  }

  // At least one form of location (assumption — see doc comment).
  if (location === null && !hasLat && !hasLng) {
    errors.push(
      'location is required: provide location text and/or lat/lng coordinates',
    );
  }

  // priority — fixed enum (§4)
  if (
    typeof input.priority !== 'string' ||
    !PRIORITIES.includes(input.priority as Priority)
  ) {
    errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }

  // reported_at — canonical ISO 8601, round-trip check (§2 row 4)
  let reported_at = '';
  if (typeof input.reported_at !== 'string') {
    errors.push('reported_at must be a string');
  } else {
    try {
      const parsed = new Date(input.reported_at).toISOString();
      if (parsed !== input.reported_at) {
        errors.push('reported_at must be a canonical ISO 8601 string (e.g. new Date().toISOString())');
      } else {
        reported_at = parsed;
      }
    } catch {
      errors.push('reported_at must be a canonical ISO 8601 string (e.g. new Date().toISOString())');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    value: {
      category: input.category as Category,
      description,
      location,
      lat,
      lng,
      priority: input.priority as Priority,
      reported_at,
    },
  };
}
