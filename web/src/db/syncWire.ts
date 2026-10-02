import type { LocalReport, LocalHistoryEvent } from '../db/types';
import type { ClientEvent } from '@shared/events';
import { CLIENT_UPLOADABLE_ACTIONS } from '@shared/types';
import type { Identity } from '../identity';

/** Type guard: only client-uploadable actions may go on the wire. */
export type UploadableEvent = LocalHistoryEvent & { action: ClientEvent['action'] };

function isUploadable(e: LocalHistoryEvent): e is UploadableEvent {
  return (CLIENT_UPLOADABLE_ACTIONS as readonly string[]).includes(e.action);
}

// ---------------------------------------------------------------------------
// Error-body shape — mirrors server/src/errors.ts (nested ApiError body)
// ---------------------------------------------------------------------------

export interface ServerErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: string[];
  };
}

/**
 * M6 sends create ops only. Other op types are M7 work; a stale op row in the
 * outbox would otherwise silently never leave `pending`, so the engine throws
 * instead (see syncEngine.ts).
 */
export type SendableOpType = 'create';

// ---------------------------------------------------------------------------
// Retry backoff: base 2 s, doubling, capped at 60 s, ±20% jitter (M6 table)
// ---------------------------------------------------------------------------

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

/**
 * Delay before the next retry for a report with `attempts` past attempts.
 * attempts=0 → 2 s (after the 1st retryable failure), then 4 s, 8 s …
 * Jitter multiplies by (1 − 0.2 … 1 + 0.2): rand∈[0,1) → 0.8…1.2.
 * Seeded by `rand` so tests are deterministic.
 */
export function nextDelay(attempts: number, rand: () => number): number {
  const raw = Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
  const jitter = 1 + 0.4 * (rand() - 0.5);
  // Cap the jittered result so the promised 60 s ceiling holds even at +20%.
  return Math.min(Math.round(raw * jitter), MAX_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Wire identity: the report's own reporter_id, always field_worker (M6 table).
// Never the currently selected UI identity.
// ---------------------------------------------------------------------------

export function wireHeaders(report: Pick<LocalReport, 'reporter_id'>): Identity {
  return { user_id: report.reporter_id, role: 'field_worker' };
}

// ---------------------------------------------------------------------------
// Request body, built at SEND time from the stored record (Option B)
// ---------------------------------------------------------------------------

/**
 * Fields from LocalReport that are client-only and must never go on the wire
 * (server-side shape: ReportContent + id/status/timestamps + coordinator
 * fields). reportHistory rows (not picked in the first place) never sent.
 */
const CLIENT_ONLY_FIELDS = new Set([
  'sync_state',
  'attempts',
  'last_error',
  'version',
  'received_at',
  'assigned_to',
  'resolution_notes',
  'updated_at',
  'status',
]);

/**
 * Map a stored event row to the ClientEvent wire shape. timestamp matches
 * ClientEvent.timestamp by name (M5 decision), old/new values are nullable.
 */
export function toWireEvent(e: UploadableEvent): ClientEvent {
  return {
    id: e.id,
    action: e.action,
    timestamp: e.timestamp,
    old_value: e.old_value,
    new_value: e.new_value,
  };
}

/**
 * Build the POST /api/reports body from the stored report and the event rows
 * still marked `uploaded: false`. The server validates content via
 * validateReport, requires status absent/'submitted', and stamps
 * reporter_id/received_at/version itself — so those never travel.
 *
 * `status: 'submitted'` is sent explicitly (the server accepts it) so the
 * payload is self-describing; the server would default it anyway.
 */
export function buildCreateBody(
  report: LocalReport,
  events: LocalHistoryEvent[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: report.id,
    status: 'submitted',
    created_at: report.created_at,
  };
  for (const [key, value] of Object.entries(report)) {
    if (CLIENT_ONLY_FIELDS.has(key)) continue;
    body[key] = value;
  }
  // Two chained filters: TS only narrows element types via a bare predicate.
  const unuploaded = events.filter((e) => !e.uploaded).filter(isUploadable);
  if (unuploaded.length > 0) {
    body.events = unuploaded.map(toWireEvent);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

export type Outcome =
  | { kind: 'success'; report: Record<string, unknown>; events: Record<string, unknown>[] }
  | { kind: 'retry'; last_error: string }
  | { kind: 'terminal'; last_error: string };

/** RETRYABLE_STATUS / TERMINAL_STATUS per the M6 decision table. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/** Read the nested error body defensively; never trust the wire shape. */
function extractServerMessage(parsed: unknown, fallback: string): string {
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'error' in parsed &&
    (parsed as ServerErrorBody).error !== null &&
    typeof (parsed as ServerErrorBody).error === 'object'
  ) {
    const err = (parsed as ServerErrorBody).error!;
    if (typeof err.message === 'string' && err.message.trim() !== '') return err.message;
  }
  return fallback;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text(); // defensive: res.json() throws before we can see the body
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parse a 2xx response. Undefined data (empty/non-JSON body) is retryable:
 * the server may have saved the report, but without the echo we cannot store
 * version/received_at or mark events uploaded. The replay returns 200.
 */
export async function parseSuccessResponse(res: Response): Promise<Outcome> {
  const data = await parseBody(res);
  if (data === null || typeof data !== 'object' || (data as Record<string, unknown>).report === undefined) {
    return { kind: 'retry', last_error: 'Unreadable response from server' };
  }
  const body = data as { report: Record<string, unknown>; events?: Record<string, unknown>[] };
  // The success transaction needs the server-assigned version + received_at.
  // A 2xx without them cannot be completed locally — retry (replay returns 200).
  if (
    typeof body.report.version !== 'number' ||
    typeof body.report.received_at !== 'string'
  ) {
    return { kind: 'retry', last_error: 'Unreadable response from server' };
  }
  return {
    kind: 'success',
    report: body.report,
    events: Array.isArray(body.events) ? body.events : [],
  };
}

/**
 * Classify a non-2xx response. 5xx and 429 (plus the other retryable 4xx
 * status codes) are retryable with a generic fallback message for
 * empty/non-JSON bodies (Vite's dev proxy answers this way when Express is
 * down). Other 4xx are terminal, keeping the server's own message.
 */
export async function classifyFailure(res: Response): Promise<Outcome> {
  const status = res.status;

  if (status >= 500 || RETRYABLE_STATUS.has(status)) {
    const parsed = await parseBody(res);
    const serverMessage =
      status >= 500 ? 'Server unreachable' : 'Server overloaded';
    return {
      kind: 'retry',
      last_error: extractServerMessage(parsed, `${serverMessage} (${status})`),
    };
  }

  const parsed = await parseBody(res);
  return {
    kind: 'terminal',
    last_error: extractServerMessage(parsed, `Rejected by server (${status})`),
  };
}

/** Thrown fetch, or an abort/timeout, is always retryable. */
export function networkErrorOutcome(err: unknown): Outcome {
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'retry', last_error: `Network error: ${message}` };
}

// ---------------------------------------------------------------------------
// Timeout wrapper — 10 s (M6 table). Injectable so tests never wait.
// ---------------------------------------------------------------------------

/** [signal, cancel] pair — the cancel must always run (attemptFinally). */
export function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}
