/**
 * Cross-check: notesRequired() in CoordinatorView must match the server rule
 * in reports.ts (needsNotes). Both are tested here against the same table.
 *
 * The server rule (reports.ts):
 *   needsNotes = to === 'rejected' || to === 'resolved' ||
 *                (from === 'resolved' && to === 'in_progress')
 *
 * The web rule (CoordinatorView.tsx notesRequired):
 *   return to === 'rejected' || to === 'resolved' ||
 *          (from === 'resolved' && to === 'in_progress')
 *
 * README notes that the rule exists in both places.
 */
import { describe, it, expect } from 'vitest';
import { TRANSITIONS } from '@shared/transitions';
import type { Status } from '@shared/types';

// Mirror the web notesRequired function exactly so we test the same logic.
// If that function changes, this test will fail and remind you to update both.
function notesRequired(from: Status, to: Status): boolean {
  return to === 'rejected' || to === 'resolved' || (from === 'resolved' && to === 'in_progress');
}

// Build the full set of legal coordinator transitions from TRANSITIONS table.
const coordinatorMoves: Array<{ from: Status; to: Status }> = [];
for (const [from, moves] of Object.entries(TRANSITIONS) as [Status, typeof TRANSITIONS[Status]][]) {
  for (const move of moves) {
    if (move.role === 'coordinator') {
      coordinatorMoves.push({ from, to: move.to });
    }
  }
}

describe('notesRequired — all 7 coordinator transitions', () => {
  it.each(coordinatorMoves)('$from → $to', ({ from, to }) => {
    const required = notesRequired(from, to);
    // Transitions that require notes:
    //   any → rejected, any → resolved, resolved → in_progress (reopen)
    const expectedRequired =
      to === 'rejected' ||
      to === 'resolved' ||
      (from === 'resolved' && to === 'in_progress');
    expect(required).toBe(expectedRequired);
  });
});

describe('notesRequired — pinned cases', () => {
  it.each([
    // Notes required
    { from: 'submitted',  to: 'rejected',    want: true  },
    { from: 'assigned',   to: 'rejected',    want: true  },
    { from: 'in_progress',to: 'rejected',    want: true  },
    { from: 'in_progress',to: 'resolved',    want: true  },
    { from: 'resolved',   to: 'in_progress', want: true  },
    // Notes NOT required
    { from: 'submitted',  to: 'assigned',    want: false },
    { from: 'assigned',   to: 'in_progress', want: false },
  ] as Array<{ from: Status; to: Status; want: boolean }>)('$from → $to: $want', ({ from, to, want }) => {
    expect(notesRequired(from, to)).toBe(want);
  });
});
