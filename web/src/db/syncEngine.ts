import type { AppDb } from './schema';
import type { LocalReport, LocalHistoryEvent, OutboxOp } from './types';
import { newId as defaultNewId } from './newId';
import {
  buildCreateBody,
  wireHeaders,
  classifyFailure,
  networkErrorOutcome,
  parseSuccessResponse,
  timeoutSignal,
  type Outcome,
} from './syncWire';

// ---------------------------------------------------------------------------
// Engine dependencies — all injectable for deterministic tests
// ---------------------------------------------------------------------------

export const REQUEST_TIMEOUT_MS = 10_000;
/** In-memory only: after a reload the startup pass retries immediately (M6). */
export const DEFAULT_RETRY_BASE_MS = 2_000;

export interface SyncEngineDeps {
  db: AppDb;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** ISO 8601 clock — injectable so event timestamps are deterministic. */
  now?: () => string;
  newId?: () => string;
  /** Backoff scheduling — injectable so tests fake timers without IDB breakage. */
  schedule?: (fn: () => void | Promise<void>, delayMs: number) => void;
  clear?: () => void;
  retryBaseMs?: number;
}

// ---------------------------------------------------------------------------
// Internal pass state
// ---------------------------------------------------------------------------

/** An outbox row as read from the table — seq (the primary key) is always set. */
type OutboxOpRow = OutboxOp & { seq: number };

type PassOutcome = 'ok' | 'retry' | 'done';

interface EngineState {
  /** Single-flight guard; every write happens under try/finally. */
  running: boolean;
  /** A call arrived during a pass: run exactly one more pass afterwards. */
  rerun: boolean;
  /** Monotonic token — invalidates a scheduled backoff callback. */
  timerEpoch: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSyncEngine(deps: SyncEngineDeps) {
  const db = deps.db;
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const baseUrl = deps.baseUrl ?? '';
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? defaultNewId;
  const schedule =
    deps.schedule ??
    ((fn: () => void | Promise<void>, delayMs: number) => {
      setTimeout(fn, delayMs);
    });
  const clear = deps.clear ?? (() => {});
  const retryBaseMs = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  const state: EngineState = { running: false, rerun: false, timerEpoch: 0 };

  // -------------------------------------------------------------------------
  // Backoff timer — one timer per engine, epoch-tokened
  // -------------------------------------------------------------------------

  function scheduleRetry(delayMs: number): void {
    clear();
    const epoch = ++state.timerEpoch;
    schedule(() => {
      if (epoch !== state.timerEpoch) return; // cancelled by a later schedule
      return syncOnce();
    }, delayMs);
  }

  /** Cancels any scheduled backoff pass (Sync now / retry() call this first). */
  function cancelScheduledRetry(): void {
    clear();
    state.timerEpoch++;
  }

  // -------------------------------------------------------------------------
  // Outbox reading
  // -------------------------------------------------------------------------

  /**
   * Ops in seq order for reports whose sync_state is pending or syncing.
   * A syncing report at pass start is stale (single-flight means no pass owns
   * it) — passStartReset() fixes it before we get here.
   */
  async function getSendableOps(): Promise<OutboxOpRow[]> {
    const ops = await db.outbox.orderBy('seq').toArray();
    const sendable: OutboxOpRow[] = [];
    for (const op of ops) {
      const report = await db.reports.get(op.report_id);
      if (!report) continue; // orphaned op — nothing to send
      if (report.sync_state === 'pending' || report.sync_state === 'syncing') {
        sendable.push(op as OutboxOpRow);
      }
    }
    return sendable;
  }

  // -------------------------------------------------------------------------
  // recoverOnStart + pass-start reset
  // -------------------------------------------------------------------------

  /** Reset every syncing report to pending, atomically. The create is
   *  idempotent, so a retry after a mid-flight crash is safe. */
  async function resetSyncingToPending(): Promise<number> {
    return db.transaction('rw', db.reports, async () => {
      const stuck = await db.reports.where('sync_state').equals('syncing').toArray();
      for (const r of stuck) {
        await db.reports.put({ ...r, sync_state: 'pending' });
      }
      return stuck.length;
    });
  }

  async function recoverOnStart(): Promise<void> {
    await resetSyncingToPending();
  }

  // -------------------------------------------------------------------------
  // attempt — one HTTP try for one op
  // -------------------------------------------------------------------------

  async function attempt(op: OutboxOpRow, report: LocalReport): Promise<Outcome> {
    const events = (await db.reportHistory
      .where('report_id')
      .equals(op.report_id)
      .toArray()) as LocalHistoryEvent[];

    const { signal, cancel } = timeoutSignal(REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${baseUrl}/api/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Simulated-Role': wireHeaders(report).role,
          'X-Simulated-User': wireHeaders(report).user_id,
        },
        body: JSON.stringify(buildCreateBody(report, events)),
        signal,
      });
      if (res.ok) return await parseSuccessResponse(res);
      return await classifyFailure(res);
    } catch (err: unknown) {
      return networkErrorOutcome(err);
    } finally {
      cancel();
    }
  }

  // -------------------------------------------------------------------------
  // applyOutcome — one transaction per op (M6 table)
  // -------------------------------------------------------------------------

  /**
   * One transaction: op delete, report fields, echoed-event uploaded flags,
   * local synced event. For terminal failures: failed state + exactly one
   * sync_failed event.
   */
  async function applyOutcome(
    op: OutboxOpRow,
    outcome: Outcome,
    prevAttempts: number,
  ): Promise<void> {
    const ts = now();

    if (outcome.kind === 'success') {
      const localEvents = await db.reportHistory
        .where('report_id')
        .equals(op.report_id)
        .toArray();

      await db.transaction('rw', db.reports, db.reportHistory, db.outbox, async () => {
        const current = await db.reports.get(op.report_id);
        if (!current) return;

        await db.reports.put({
          ...current,
          sync_state: 'synced',
          version:
            typeof outcome.report.version === 'number' ? outcome.report.version : current.version,
          received_at:
            typeof outcome.report.received_at === 'string'
              ? outcome.report.received_at
              : current.received_at,
          attempts: 0,
          last_error: null,
        });

        // Success means the server has this report's full event history:
        // mark every local event uploaded (M6 table: "mark the echoed event
        // IDs uploaded" — the echo lists all stored events, and any local
        // event the echo missed would be re-sent forever).
        for (const ev of localEvents) {
          if (!ev.uploaded) {
            await db.reportHistory.put({ ...ev, uploaded: true });
          }
        }

        await db.outbox.delete(op.seq);

        await db.reportHistory.add({
          id: newId(),
          report_id: op.report_id,
          action: 'synced',
          old_value: null,
          new_value: JSON.stringify({ server_version: outcome.report.version ?? null }),
          actor_role: 'field_worker',
          actor_id: current.reporter_id,
          timestamp: ts,
          uploaded: false,
        });
      });
      return;
    }

    if (outcome.kind === 'retry') {
      // Keep the op. Transient failures are NOT history events (M6 table).
      await db.transaction('rw', db.reports, async () => {
        const current = await db.reports.get(op.report_id);
        if (!current) return;
        await db.reports.put({
          ...current,
          sync_state: 'pending',
          attempts: prevAttempts + 1,
          last_error: outcome.last_error,
        });
      });
      return;
    }

    // terminal — ONE sync_failed event; op is deleted so the next pass skips it
    await db.transaction('rw', db.reports, db.reportHistory, db.outbox, async () => {
      const current = await db.reports.get(op.report_id);
      if (!current) return;

      await db.outbox.delete(op.seq);
      await db.reports.put({
        ...current,
        sync_state: 'failed',
        attempts: prevAttempts + 1,
        last_error: outcome.last_error,
      });
      await db.reportHistory.add({
        id: newId(),
        report_id: op.report_id,
        action: 'sync_failed',
        old_value: null,
        new_value: JSON.stringify({ error: outcome.last_error }),
        actor_role: 'field_worker',
        actor_id: current.reporter_id,
        timestamp: ts,
        uploaded: false,
      });
    });
  }

  // -------------------------------------------------------------------------
  // sendOne — markSyncing, attempt, applyOutcome (all under try/finally)
  // -------------------------------------------------------------------------

  /**
   * markSyncing is the first transaction, so a crash after a successful send
   * but before applyOutcome leaves `syncing` — which the next pass start
   * resets to pending, and the idempotent replay completes it.
   */
  async function sendOne(op: OutboxOpRow): Promise<PassOutcome> {
    const report = await db.reports.get(op.report_id);
    if (!report) return 'done';

    const prevAttempts = report.attempts ?? 0;
    await db.reports.put({ ...report, sync_state: 'syncing' });

    let outcome: Outcome;
    try {
      outcome = await attempt(op, report);
    } catch (err: unknown) {
      // Never leave the report stuck: any unexpected throw is retryable.
      outcome = {
        kind: 'retry',
        last_error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    await applyOutcome(op, outcome, prevAttempts);
    return outcome.kind === 'retry' ? 'retry' : outcome.kind === 'success' ? 'ok' : 'done';
  }

  // -------------------------------------------------------------------------
  // syncOnce — single-flight pass over the sendable ops
  // -------------------------------------------------------------------------

  /**
   * Single-flight: a call during a pass sets rerun, so exactly one extra pass
   * runs afterwards. Pass-level try/finally clears `running` even if a throw
   * escapes — a deadlocked engine is worse than a double send.
   */
  async function syncOnce(): Promise<void> {
    if (state.running) {
      state.rerun = true;
      return;
    }
    state.running = true;
    try {
      // Reset stale syncing reports at the START of every pass (amendment:
      // single-flight means no live pass can own a syncing report here).
      await resetSyncingToPending();

      let passOutcome: PassOutcome = 'ok';
      for (const op of await getSendableOps()) {
        const result = await sendOne(op);
        if (result === 'retry') {
          passOutcome = 'retry';
          break; // stop the pass on the first retryable failure
        }
      }

      if (passOutcome === 'retry') {
        const worst = await getWorstAttempts();
        scheduleRetry(nextRetryDelay(worst));
      }
    } finally {
      state.running = false;
      if (state.rerun) {
        state.rerun = false;
        await syncOnce();
      }
    }
  }

  function getWorstAttempts(): Promise<number> {
    return db.reports
      .where('sync_state')
      .equals('pending')
      .toArray()
      .then((rows) => Math.max(0, ...rows.map((r) => r.attempts ?? 0)));
  }

  function nextRetryDelay(attempts: number): number {
    const raw = Math.min(retryBaseMs * 2 ** attempts, 60_000);
    const jitter = 1 + 0.4 * (Math.random() - 0.5);
    return Math.min(Math.round(raw * jitter), 60_000);
  }

  // -------------------------------------------------------------------------
  // retry — user action on a failed report
  // -------------------------------------------------------------------------

  /** Moves a failed report back to pending, re-queues its outbox op, then
   *  runs a pass. Resolves when that pass completes (or if one is running,
   *  the single-flight rerun flag handles it). */
  async function retry(reportId: string): Promise<void> {
    cancelScheduledRetry();
    const report = await db.reports.get(reportId);
    if (!report || report.sync_state !== 'failed') return;
    await db.transaction('rw', db.reports, db.outbox, async () => {
      await db.reports.put({ ...report, sync_state: 'pending' });
      await db.outbox.add({ type: 'create', report_id: reportId, created_at: now() });
    });
    return syncOnce();
  }

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------

  /** Boot sequence: recover stale syncing rows, then run the first pass. */
  async function start(): Promise<void> {
    await recoverOnStart();
    void syncOnce();
  }

  function stop(): void {
    cancelScheduledRetry();
    // No window listeners here — the triggers module owns those.
  }

  return {
    syncOnce,
    retry,
    recoverOnStart,
    resetSyncingToPending,
    start,
    stop,
    /** Test seam: whether a pass is currently in flight. */
    isRunning: () => state.running,
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
