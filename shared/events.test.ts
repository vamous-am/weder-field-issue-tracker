import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { validateEvents } from './events';
import { CLIENT_UPLOADABLE_ACTIONS } from './types';

const ISO = '2026-10-01T08:00:00.000Z';
const UUID = '11111111-1111-4111-8111-111111111111';

const goodEvent = {
  id: UUID,
  action: 'created',
  timestamp: ISO,
};

describe('validateEvents — absent or empty input', () => {
  it('undefined returns valid empty array', () => {
    const r = validateEvents(undefined);
    assert.ok(r.valid);
    assert.deepEqual(r.value, []);
  });

  it('null returns valid empty array', () => {
    const r = validateEvents(null);
    assert.ok(r.valid);
    assert.deepEqual(r.value, []);
  });

  it('empty array returns valid empty array', () => {
    const r = validateEvents([]);
    assert.ok(r.valid);
    assert.deepEqual(r.value, []);
  });
});

describe('validateEvents — happy path', () => {
  it('accepts a single valid created event', () => {
    const r = validateEvents([goodEvent]);
    assert.ok(r.valid);
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].action, 'created');
  });

  it('accepts every client-uploadable action', () => {
    for (const action of CLIENT_UPLOADABLE_ACTIONS) {
      const r = validateEvents([{ ...goodEvent, action }]);
      assert.ok(r.valid, `expected ${action} to be valid`);
    }
  });

  it('accepts old_value and new_value as strings', () => {
    const r = validateEvents([{ ...goodEvent, old_value: 'a', new_value: 'b' }]);
    assert.ok(r.valid);
    assert.equal(r.value[0].old_value, 'a');
    assert.equal(r.value[0].new_value, 'b');
  });

  it('accepts old_value and new_value as null', () => {
    const r = validateEvents([{ ...goodEvent, old_value: null, new_value: null }]);
    assert.ok(r.valid);
  });

  it('defaults absent old_value and new_value to null', () => {
    const r = validateEvents([goodEvent]);
    assert.ok(r.valid);
    assert.equal(r.value[0].old_value, null);
    assert.equal(r.value[0].new_value, null);
  });
});

describe('validateEvents — top-level shape errors', () => {
  it('rejects a non-array', () => {
    const r = validateEvents({ id: UUID, action: 'created', timestamp: ISO });
    assert.ok(!r.valid);
    assert.ok(r.errors.some((e) => e.field === 'events'));
  });

  it('rejects more than 50 events', () => {
    const items = Array.from({ length: 51 }, () => goodEvent);
    const r = validateEvents(items);
    assert.ok(!r.valid);
    assert.ok(r.errors.some((e) => e.message.includes('50')));
  });

  it('rejects a non-object item', () => {
    const r = validateEvents(['not-an-object']);
    assert.ok(!r.valid);
    assert.equal(r.errors[0].index, 0);
  });
});

describe('validateEvents — per-item field errors', () => {
  it('rejects an invalid UUID id', () => {
    const r = validateEvents([{ ...goodEvent, id: 'not-a-uuid' }]);
    assert.ok(!r.valid);
    assert.ok(r.errors.some((e) => e.index === 0 && e.field === 'id'));
  });

  it('rejects status_changed (server-only action)', () => {
    const r = validateEvents([{ ...goodEvent, action: 'status_changed' }]);
    assert.ok(!r.valid);
    assert.ok(r.errors.some((e) => e.index === 0 && e.field === 'action'));
  });

  it('rejects an unknown action', () => {
    const r = validateEvents([{ ...goodEvent, action: 'deleted' }]);
    assert.ok(!r.valid);
    assert.ok(r.errors.some((e) => e.field === 'action'));
  });

  it('rejects a non-canonical timestamp', () => {
    const r = validateEvents([{ ...goodEvent, timestamp: '2026-10-01' }]);
    assert.ok(!r.valid);
    assert.ok(r.errors.some((e) => e.index === 0 && e.field === 'timestamp'));
  });

  it('rejects a numeric old_value', () => {
    const r = validateEvents([{ ...goodEvent, old_value: 42 }]);
    assert.ok(!r.valid);
    assert.ok(r.errors.some((e) => e.field === 'old_value'));
  });

  it('errors are indexed: events[i].field format', () => {
    const r = validateEvents([goodEvent, { ...goodEvent, id: 'bad' }]);
    assert.ok(!r.valid);
    assert.ok(r.errors.some((e) => e.index === 1 && e.message.includes('events[1]')));
  });
});
