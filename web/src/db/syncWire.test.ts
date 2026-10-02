import { describe, it, expect, vi } from 'vitest';
import {
  nextDelay,
  wireHeaders,
  buildCreateBody,
  parseSuccessResponse,
  classifyFailure,
  networkErrorOutcome,
  timeoutSignal,
} from './syncWire';
import type { LocalReport, LocalHistoryEvent } from './types';

// No DB needed — pure functions only.

const ts = '2026-10-01T08:00:00.000Z';

function makeReport(overrides: Partial<LocalReport> = {}): LocalReport {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    reporter_id: 'worker-1',
    status: 'submitted',
    sync_state: 'pending',
    version: null,
    received_at: null,
    assigned_to: null,
    resolution_notes: null,
    created_at: ts,
    updated_at: ts,
    attempts: 0,
    last_error: null,
    category: 'maintenance',
    description: 'Hand pump leaking',
    location: 'Village A',
    lat: null,
    lng: null,
    priority: 'medium',
    reported_at: ts,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<LocalHistoryEvent> = {}): LocalHistoryEvent {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    report_id: '11111111-1111-4111-8111-111111111111',
    action: 'created',
    old_value: null,
    new_value: null,
    actor_role: 'field_worker',
    actor_id: 'worker-1',
    timestamp: '2026-10-01T08:00:00.000Z',
    uploaded: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// nextDelay
// ---------------------------------------------------------------------------

describe('nextDelay', () => {
  const rand = () => 0.5; // zero jitter

  it('doubles per attempt from a 2 s base', () => {
    expect(nextDelay(0, rand)).toBe(2_000);
    expect(nextDelay(1, rand)).toBe(4_000);
    expect(nextDelay(2, rand)).toBe(8_000);
  });

  it('caps the jittered delay at 60 s', () => {
    expect(nextDelay(10, rand)).toBe(60_000);
    // +20% jitter on an already-capped raw delay must not exceed 60 s
    expect(nextDelay(10, () => 1)).toBe(60_000);
    expect(nextDelay(10, () => 0)).toBe(48_000); // raw 60 s * 0.8
  });

  it('jitters ±20% around the raw delay', () => {
    expect(nextDelay(0, () => 1)).toBe(2_400); // +20%
    expect(nextDelay(0, () => 0)).toBe(1_600); // −20%
  });
});

// ---------------------------------------------------------------------------
// wireHeaders
// ---------------------------------------------------------------------------

describe('wireHeaders', () => {
  it('uses the report reporter_id with role field_worker', () => {
    expect(wireHeaders(makeReport({ reporter_id: 'worker-1' }))).toEqual({
      user_id: 'worker-1',
      role: 'field_worker',
    });
  });
});

// ---------------------------------------------------------------------------
// buildCreateBody
// ---------------------------------------------------------------------------

describe('buildCreateBody', () => {
  it('sends content fields, id, status and created_at', () => {
    const body = buildCreateBody(makeReport(), [makeEvent()]);
    expect(body).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'submitted',
      created_at: '2026-10-01T08:00:00.000Z',
      category: 'maintenance',
      description: 'Hand pump leaking',
      location: 'Village A',
      priority: 'medium',
      reported_at: '2026-10-01T08:00:00.000Z',
    });
  });

  it('excludes every client-only field', () => {
    const body = buildCreateBody(makeReport(), [makeEvent()]);
    for (const key of [
      'sync_state',
      'attempts',
      'last_error',
      'version',
      'received_at',
      'assigned_to',
      'resolution_notes',
      'updated_at',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('maps only un-uploaded events to the ClientEvent wire shape', () => {
    const events = [
      makeEvent({ id: '33333333-3333-4333-8333-333333333333', uploaded: false }),
      makeEvent({ id: '44444444-4444-4444-8444-444444444444', uploaded: true }),
    ];
    const body = buildCreateBody(makeReport(), events);
    expect(body.events).toEqual([
      {
        id: '33333333-3333-4333-8333-333333333333',
        action: 'created',
        timestamp: '2026-10-01T08:00:00.000Z',
        old_value: null,
        new_value: null,
      },
    ]);
  });

  it('omits the events key when everything is uploaded', () => {
    const body = buildCreateBody(makeReport(), [makeEvent({ uploaded: true })]);
    expect(body).not.toHaveProperty('events');
  });

  it('round-trips through JSON without losing null values', () => {
    const body = buildCreateBody(
      makeReport({ lat: null, lng: null }),
      [makeEvent({ old_value: null, new_value: null })],
    );
    const parsed = JSON.parse(JSON.stringify(body));
    expect(parsed.lat).toBeNull();
    expect(parsed.events[0].new_value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const emptyRes = (status: number) => new Response(null, { status });

describe('parseSuccessResponse', () => {
  it('accepts a 201 body with report and events', async () => {
    const outcome = await parseSuccessResponse(
      jsonRes(201, {
        report: { id: 'r1', version: 1, received_at: ts },
        events: [{ id: 'e1' }],
      }),
    );
    expect(outcome).toEqual({
      kind: 'success',
      report: { id: 'r1', version: 1, received_at: ts },
      events: [{ id: 'e1' }],
    });
  });

  it('treats a missing events array as empty', async () => {
    const outcome = await parseSuccessResponse(
      jsonRes(200, { report: { id: 'r1', version: 1, received_at: ts } }),
    );
    expect(outcome).toEqual({
      kind: 'success',
      report: { id: 'r1', version: 1, received_at: ts },
      events: [],
    });
  });

  it('is retryable when the echo lacks version or received_at', async () => {
    const outcome = await parseSuccessResponse(jsonRes(201, { report: { id: 'r1' } }));
    expect(outcome).toEqual({ kind: 'retry', last_error: 'Unreadable response from server' });
  });

  it('is retryable when the 2xx body is empty (stateful server possible)', async () => {
    const outcome = await parseSuccessResponse(emptyRes(200));
    expect(outcome).toEqual({ kind: 'retry', last_error: 'Unreadable response from server' });
  });

  it('is retryable when the 2xx body is not JSON', async () => {
    const res = new Response('<html>proxy error page</html>', { status: 200 });
    const outcome = await parseSuccessResponse(res);
    expect(outcome).toEqual({ kind: 'retry', last_error: 'Unreadable response from server' });
  });

  it('is retryable when the 2xx body lacks a report key', async () => {
    const outcome = await parseSuccessResponse(jsonRes(201, { hello: 'world' }));
    expect(outcome).toEqual({ kind: 'retry', last_error: 'Unreadable response from server' });
  });
});

describe('classifyFailure', () => {
  it('maps 5xx to retryable with a fallback message on an empty body', async () => {
    const outcome = await classifyFailure(emptyRes(500));
    expect(outcome).toEqual({ kind: 'retry', last_error: 'Server unreachable (500)' });
  });

  it('prefers the nested server message on 5xx with a JSON body', async () => {
    const outcome = await classifyFailure(
      jsonRes(503, { error: { code: 'INTERNAL', message: 'db reset' } }),
    );
    expect(outcome).toEqual({ kind: 'retry', last_error: 'db reset' });
  });

  it('treats 429 as retryable', async () => {
    const outcome = await classifyFailure(emptyRes(429));
    expect(outcome).toEqual({ kind: 'retry', last_error: 'Server overloaded (429)' });
  });

  it('is terminal for 422, keeping the server message', async () => {
    const outcome = await classifyFailure(
      jsonRes(422, {
        error: { code: 'UNPROCESSABLE', message: 'Report content is invalid', details: ['x'] },
      }),
    );
    expect(outcome).toEqual({ kind: 'terminal', last_error: 'Report content is invalid' });
  });

  it('is terminal with a fallback message for 4xx non-JSON bodies', async () => {
    const outcome = await classifyFailure(emptyRes(400));
    expect(outcome).toEqual({ kind: 'terminal', last_error: 'Rejected by server (400)' });
  });

  it('treats 409 as terminal', async () => {
    const outcome = await classifyFailure(
      jsonRes(409, { error: { code: 'CONFLICT', message: 'Report ID already exists' } }),
    );
    expect(outcome).toEqual({ kind: 'terminal', last_error: 'Report ID already exists' });
  });
});

describe('networkErrorOutcome', () => {
  it('wraps an Error message as retryable', () => {
    expect(networkErrorOutcome(new Error('fetch failed'))).toEqual({
      kind: 'retry',
      last_error: 'Network error: fetch failed',
    });
  });

  it('stringifies non-Error throws', () => {
    expect(networkErrorOutcome('boom')).toEqual({
      kind: 'retry',
      last_error: 'Network error: boom',
    });
  });
});

describe('timeoutSignal', () => {
  it('aborts after the timeout and cancels cleanly', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { signal, cancel } = timeoutSignal(10_000);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(signal.aborted).toBe(true);
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never aborts when cancelled before the timeout', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { signal, cancel } = timeoutSignal(10_000);
      cancel();
      vi.advanceTimersByTime(60_000);
      expect(signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
