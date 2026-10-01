import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  TRANSITIONS,
  allowedTransitions,
  isValidTransition,
  isValidTransitionRequest,
} from './transitions';
import { ROLES, STATUSES } from './types';

// The exact set of legal moves from PROJECT_DECISIONS.md §5, hardcoded here
// so the TRANSITIONS table itself is pinned, not just the lookup behavior.
const DOC_TRANSITIONS = [
  'draft|submitted|field_worker',
  'submitted|assigned|coordinator',
  'submitted|rejected|coordinator',
  'assigned|in_progress|coordinator',
  'assigned|rejected|coordinator',
  'in_progress|resolved|coordinator',
  'in_progress|rejected|coordinator',
  'resolved|in_progress|coordinator',
  'rejected|submitted|field_worker',
];

describe('TRANSITIONS table matches the documented workflow (§5)', () => {
  it('contains exactly the 9 documented moves, nothing more', () => {
    const keys = Object.entries(TRANSITIONS).flatMap(([from, moves]) =>
      moves.map((m) => `${from}|${m.to}|${m.role}`),
    );
    assert.equal(keys.length, DOC_TRANSITIONS.length);
    for (const key of DOC_TRANSITIONS) {
      assert.ok(keys.includes(key), `table is missing ${key}`);
    }
  });

  it('every status has an entry (possibly empty)', () => {
    for (const status of STATUSES) {
      assert.ok(Array.isArray(TRANSITIONS[status]));
    }
  });
});


// Exhaustive loop (§8.1): all 6 × 6 × 2 = 72 combinations, asserting
// isValidTransition returns true only where the table allows.


const expected = new Set(
  Object.entries(TRANSITIONS).flatMap(([from, moves]) =>
    moves.map((m) => `${from}|${m.to}|${m.role}`),
  ),
);

describe('isValidTransition — exhaustive 72-combination loop', () => {
  for (const current of STATUSES) {
    for (const role of ROLES) {
      for (const next of STATUSES) {
        const key = `${current}|${next}|${role}`;
        it(`${current} -> ${next} as ${role}`, () => {
          assert.strictEqual(
            isValidTransition(current, next, role),
            expected.has(key),
            `expected ${key} to be ${expected.has(key)}`,
          );
        });
      }
    }
  }
});

describe('isValidTransition — pinned behaviors (§5 rules)', () => {
  it('regression: rejected -> draft is false, for every role', () => {
    assert.equal(isValidTransition('rejected', 'draft', 'field_worker'), false);
    assert.equal(isValidTransition('rejected', 'draft', 'coordinator'), false);
  });

  it('same-state transitions are false', () => {
    for (const status of STATUSES) {
      for (const role of ROLES) {
        assert.equal(isValidTransition(status, status, role), false);
      }
    }
  });

  it('draft -> submitted is field_worker only', () => {
    assert.equal(isValidTransition('draft', 'submitted', 'field_worker'), true);
    assert.equal(isValidTransition('draft', 'submitted', 'coordinator'), false);
  });

  it('rejected -> submitted is field_worker only (resubmit path)', () => {
    assert.equal(isValidTransition('rejected', 'submitted', 'field_worker'), true);
    assert.equal(isValidTransition('rejected', 'submitted', 'coordinator'), false);
  });

  it('coordinator cannot skip assignment: submitted -> in_progress is false', () => {
    assert.equal(isValidTransition('submitted', 'in_progress', 'coordinator'), false);
  });

  it('no coordinator action moves a report out of rejected (§6 conflict model)', () => {
    for (const status of STATUSES) {
      assert.equal(
        isValidTransition('rejected', status, 'coordinator'),
        false,
        `coordinator -> ${status} must not be legal from rejected`,
      );
    }
  });

  it('resolved -> in_progress is the only reopen path (§2.8)', () => {
    assert.equal(isValidTransition('resolved', 'in_progress', 'coordinator'), true);
    assert.equal(isValidTransition('resolved', 'assigned', 'coordinator'), false);
    assert.equal(isValidTransition('resolved', 'in_progress', 'field_worker'), false);
  });
});

describe('isValidTransition — robustness', () => {
  // Garbage inputs reach the API as `unknown` HTTP body values, so these
  // exercise the boundary function, not the statically-typed lookup.
  it('is false for unknown statuses', () => {
    assert.equal(isValidTransitionRequest('unknown', 'submitted', 'field_worker'), false);
    assert.equal(isValidTransitionRequest('draft', 'unknown', 'field_worker'), false);
    assert.equal(isValidTransitionRequest('unknown', 'unknown', 'coordinator'), false);
  });

  it('is false for unknown roles', () => {
    assert.equal(isValidTransitionRequest('draft', 'submitted', 'admin'), false);
    assert.equal(isValidTransitionRequest('draft', 'submitted', 'worker'), false);
  });

  it('is false for non-string inputs', () => {
    assert.equal(isValidTransitionRequest(undefined, 'submitted', 'field_worker'), false);
    assert.equal(isValidTransitionRequest('draft', null, 'field_worker'), false);
    assert.equal(isValidTransitionRequest('draft', 'submitted', 42), false);
    assert.equal(isValidTransitionRequest('draft', 'submitted', undefined), false);
  });

  it('is directional: a legal A → B does not make B → A legal', () => {
    assert.equal(isValidTransition('draft', 'submitted', 'field_worker'), true);
    assert.equal(isValidTransition('submitted', 'draft', 'field_worker'), false);
    assert.equal(isValidTransition('submitted', 'assigned', 'coordinator'), true);
    assert.equal(isValidTransition('assigned', 'submitted', 'coordinator'), false);
  });

  it('resolved and in_progress are reachable from each other (reopen, §2.8)', () => {
    assert.equal(isValidTransition('in_progress', 'resolved', 'coordinator'), true);
    assert.equal(isValidTransition('resolved', 'in_progress', 'coordinator'), true);
  });
});

describe('allowedTransitions — UI gating helper (§5)', () => {
  it('returns only moves available to the given role, in table order', () => {
    assert.deepEqual(allowedTransitions('draft', 'field_worker'), ['submitted']);
    assert.deepEqual(allowedTransitions('draft', 'coordinator'), []);
    assert.deepEqual(allowedTransitions('submitted', 'coordinator'), [
      'assigned',
      'rejected',
    ]);
    assert.deepEqual(allowedTransitions('in_progress', 'coordinator'), [
      'resolved',
      'rejected',
    ]);
    assert.deepEqual(allowedTransitions('rejected', 'field_worker'), ['submitted']);
    assert.deepEqual(allowedTransitions('rejected', 'coordinator'), []);
  });
});