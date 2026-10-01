import type { AppDb } from './schema';
import { createRepository } from './repository';
import type { Identity } from '../identity';
import type { ReportContent } from '@shared/types';
import { newId } from './newId';

type DraftFields = Partial<ReportContent>;

/**
 * Serialized draft autosaver.
 *
 * ID allocation: the ID is generated synchronously on the first change, then
 * held in a ref. The first item enqueued on the write chain is createDraft;
 * subsequent calls enqueue updateDraft. Without this, a fast second keystroke
 * would try to create twice.
 *
 * Serialization: writes run through a single promise chain. A failed write
 * does not block later writes (chain = chain.then(write, write)).
 *
 * Debounce: 300 ms. flush() bypasses it and is called on blur, visibilitychange
 * and pagehide.
 *
 * Durability claim: edits are persisted within ~300 ms. Pending writes are
 * flushed on blur and page hide. A crash before then can lose the last
 * keystrokes.
 *
 * Built as a plain class so it can be tested with fake timers without React.
 */
export class Autosaver {
  private reportId: string | null;
  private identity: Identity;
  private repo: ReturnType<typeof createRepository>;
  private pending: DraftFields | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private _saveError: string | null = null;

  readonly DEBOUNCE_MS: number;

  constructor(
    db: AppDb,
    identity: Identity,
    /** Pass an existing ID when reopening a draft; null for a new one. */
    existingId: string | null = null,
    debounceMs = 300,
  ) {
    this.identity = identity;
    this.reportId = existingId;
    this.repo = createRepository(db);
    this.DEBOUNCE_MS = debounceMs;
  }

  get id(): string | null {
    return this.reportId;
  }

  get saveError(): string | null {
    return this._saveError;
  }

  /** Call on every field change. Coalesces rapid edits into one write. */
  onChange(fields: DraftFields): void {
    this.pending = { ...this.pending, ...fields };
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._commit(), this.DEBOUNCE_MS);
  }

  /** Flush any pending write immediately (blur, visibilitychange, pagehide). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._commit();
  }

  private _commit(): void {
    if (this.pending === null) return;
    const fields = this.pending;
    this.pending = null;

    if (this.reportId === null) {
      // First edit: allocate ID now, create the record.
      this.reportId = newId();
      const id = this.reportId;
      const identity = this.identity;
      const write = () =>
        this.repo.createDraft(identity, id, fields).then(
          () => { this._saveError = null; },
          (err: unknown) => { this._saveError = err instanceof Error ? err.message : String(err); },
        );
      this.chain = this.chain.then(write, write);
    } else {
      const id = this.reportId;
      const identity = this.identity;
      const write = () =>
        this.repo.updateDraft(identity, id, fields).then(
          () => { this._saveError = null; },
          (err: unknown) => { this._saveError = err instanceof Error ? err.message : String(err); },
        );
      this.chain = this.chain.then(write, write);
    }
  }

  /** Resolves once all enqueued writes have settled. Useful in tests. */
  drain(): Promise<void> {
    return this.chain;
  }
}
