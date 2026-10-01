import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { validateReport } from './validation';
import { CATEGORIES, PRIORITIES } from './types';

const good = {
  category: 'water_point',
  description: 'Hand pump at the north well is broken.',
  location: 'North well, 200m past the school',
  lat: 12.34,
  lng: -56.78,
  priority: 'high',
};

describe('validateReport — happy path', () => {
  it('accepts a complete valid report', () => {
    const result = validateReport(good);
    assert.deepStrictEqual(result, {
      valid: true,
      value: {
        category: 'water_point',
        description: 'Hand pump at the north well is broken.',
        location: 'North well, 200m past the school',
        lat: 12.34,
        lng: -56.78,
        priority: 'high',
      },
    });
  });

  it('trims description and location text', () => {
    const result = validateReport({
      ...good,
      description: '   Pump is broken again.   ',
      location: '   South well   ',
    });
    assert.ok(result.valid);
    assert.equal(result.value.description, 'Pump is broken again.');
    assert.equal(result.value.location, 'South well');
  });

  it('accepts text location without coordinates', () => {
    const result = validateReport({
      category: 'safety',
      description: 'Open cable box near the market.',
      location: 'Central market, east gate',
      priority: 'critical',
    });
    assert.ok(result.valid);
    assert.equal(result.value.location, 'Central market, east gate');
    assert.equal(result.value.lat, null);
    assert.equal(result.value.lng, null);
  });

  it('accepts coordinates without text location', () => {
    const result = validateReport({
      ...good,
      location: undefined,
    });
    assert.ok(result.valid);
    assert.equal(result.value.location, null);
    assert.equal(result.value.lat, 12.34);
    assert.equal(result.value.lng, -56.78);
  });

  it('treats whitespace-only location text as absent when coordinates exist', () => {
    const result = validateReport({ ...good, location: '   ' });
    assert.ok(result.valid);
    assert.equal(result.value.location, null);
  });

  it('accepts every known category', () => {
    for (const category of CATEGORIES) {
      const result = validateReport({ ...good, category });
      assert.ok(result.valid, `expected ${category} to be valid`);
      assert.equal(result.value.category, category);
    }
  });

  it('accepts every known priority', () => {
    for (const priority of PRIORITIES) {
      const result = validateReport({ ...good, priority });
      assert.ok(result.valid, `expected ${priority} to be valid`);
      assert.equal(result.value.priority, priority);
    }
  });

  it('accepts boundary coordinates: lat ±90, lng ±180', () => {
    for (const [lat, lng] of [[90, 180], [-90, -180], [0, 0]] as const) {
      const result = validateReport({ ...good, lat, lng });
      assert.ok(result.valid, `expected (${lat}, ${lng}) to be valid`);
    }
  });
});

describe('validateReport — description errors (§8.2: empty description)', () => {
  it('rejects a missing description', () => {
    const { description: _drop, ...rest } = good;
    const result = validateReport(rest);
    assert.deepStrictEqual(result, {
      valid: false,
      errors: ['description must be a non-empty string'],
    });
  });

  it('rejects an empty description', () => {
    const result = validateReport({ ...good, description: '' });
    assert.ok(!result.valid);
    assert.ok(
      result.errors.includes('description must be a non-empty string'),
    );
  });

  it('rejects a whitespace-only description', () => {
    const result = validateReport({ ...good, description: ' \n\t ' });
    assert.ok(!result.valid);
    assert.ok(
      result.errors.includes('description must be a non-empty string'),
    );
  });

  it('rejects a non-string description', () => {
    const result = validateReport({ ...good, description: 42 });
    assert.ok(!result.valid);
    assert.ok(
      result.errors.includes('description must be a non-empty string'),
    );
  });
});

describe('validateReport — category errors (§8.2: bad category)', () => {
  it('rejects an unknown category', () => {
    const result = validateReport({ ...good, category: 'road_damage' });
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.startsWith('category must be one of:')));
  });

  it('rejects a non-string category', () => {
    const result = validateReport({ ...good, category: 7 });
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.startsWith('category must be one of:')));
  });

  it('rejects a case-mismatched category', () => {
    const result = validateReport({ ...good, category: 'Water_Point' });
    assert.ok(!result.valid);
  });
});

describe('validateReport — location and coordinate errors (§8.2: out-of-range)', () => {
  it('rejects lat without lng', () => {
    const result = validateReport({ ...good, lng: undefined });
    assert.ok(!result.valid);
    assert.ok(
      result.errors.includes('lat and lng must be provided together'),
    );
  });

  it('rejects lng without lat', () => {
    const result = validateReport({ ...good, lat: undefined });
    assert.ok(!result.valid);
    assert.ok(
      result.errors.includes('lat and lng must be provided together'),
    );
  });

  it('rejects lat above 90', () => {
    const result = validateReport({ ...good, lat: 90.01 });
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('lat must be between -90 and 90'));
  });

  it('rejects lng above 180', () => {
    const result = validateReport({ ...good, lng: 180.5 });
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('lng must be between -180 and 180'));
  });

  it('rejects non-finite coordinates', () => {
    const result = validateReport({ ...good, lat: Number.NaN });
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('lat must be a finite number'));

    const result2 = validateReport({ ...good, lng: Infinity });
    assert.ok(!result2.valid);
    assert.ok(result2.errors.includes('lng must be a finite number'));
  });

  it('rejects non-number coordinates', () => {
    const result = validateReport({ ...good, lat: '12.34', lng: '56.78' });
    assert.ok(!result.valid);
  });

  it('rejects a non-string location when provided', () => {
    const result = validateReport({ ...good, location: 123 });
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('location must be a string when provided'));
  });

  it('rejects a report with no location information at all (assumption)', () => {
    const { location: _l, lat: _la, lng: _ln, ...rest } = good;
    const result = validateReport(rest);
    assert.ok(!result.valid);
    assert.ok(
      result.errors.some((e) => e.startsWith('location is required')),
    );
  });
});

describe('validateReport — priority errors', () => {
  it('rejects an unknown priority', () => {
    const result = validateReport({ ...good, priority: 'urgent' });
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.startsWith('priority must be one of:')));
  });

  it('rejects a missing priority', () => {
    const { priority: _p, ...rest } = good;
    const result = validateReport(rest);
    assert.ok(!result.valid);
    assert.ok(result.errors.some((e) => e.startsWith('priority must be one of:')));
  });
});

describe('validateReport — multiple errors accumulate in field order', () => {
  it('reports category, description, location and priority problems together', () => {
    const result = validateReport({
      category: 'nope',
      description: '',
      priority: 'nope',
    });
    assert.deepStrictEqual(result, {
      valid: false,
      errors: [
        'category must be one of: water_point, equipment, service_interruption, safety, maintenance',
        'description must be a non-empty string',
        'location is required: provide location text and/or lat/lng coordinates',
        'priority must be one of: low, medium, high, critical',
      ],
    });
  });

  it('reports both coordinate problems in order', () => {
    const result = validateReport({ ...good, lat: Number.NaN, lng: 'x' });
    assert.deepStrictEqual(result, {
      valid: false,
      errors: [
        'lat must be a finite number',
        'lng must be a finite number',
      ],
    });
  });
});

describe('validateReport — scope boundaries (§2.5, §2.11)', () => {
  it('ignores status: content validation does not reject draft payloads', () => {
    // The server refuses status: draft as a payload rule; that is not this
    // function's job. A status key must neither break nor bias the result.
    const result = validateReport({ ...good, status: 'draft' });
    assert.ok(result.valid);
  });

  it('ignores server-side keys like id, version and timestamps', () => {
    const result = validateReport({
      ...good,
      id: 'abc-123',
      version: 3,
      reported_at: '2026-10-01T08:00:00Z',
    });
    assert.ok(result.valid);
  });

  it('does not require resolution_notes (that is the API rule, not content validation)', () => {
    const result = validateReport(good);
    assert.ok(result.valid);
  });
});

describe('validateReport — bad input shapes', () => {
  it('rejects null input', () => {
    assert.deepStrictEqual(validateReport(null), {
      valid: false,
      errors: ['input must be a non-null object'],
    });
  });

  it('rejects undefined input', () => {
    assert.deepStrictEqual(validateReport(undefined), {
      valid: false,
      errors: ['input must be a non-null object'],
    });
  });

  it('rejects non-object input', () => {
    const result = validateReport('report' as never);
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('input must be a non-null object'));
  });

  it('rejects array input', () => {
    const result = validateReport([good] as never);
    assert.ok(!result.valid);
    assert.ok(result.errors.includes('input must be a non-null object'));
  });
});
