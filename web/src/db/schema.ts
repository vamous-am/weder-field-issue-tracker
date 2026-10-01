import Dexie, { type EntityTable } from 'dexie';
import type { LocalReport, LocalHistoryEvent, OutboxOp } from './types';

export class AppDb extends Dexie {
  reports!: EntityTable<LocalReport, 'id'>;
  reportHistory!: EntityTable<LocalHistoryEvent, 'id'>;
  outbox!: EntityTable<OutboxOp, 'seq'>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      reports: 'id, reporter_id, status, sync_state, updated_at',
      reportHistory: 'id, report_id, uploaded, timestamp',
      // [report_id+type] is defense-in-depth against double-submit;
      // the status guard inside the transaction is the primary check.
      outbox: '++seq, [report_id+type], report_id, type',
    });
  }
}

/** Production singleton — imported by UI code. */
export const db = new AppDb('weder-field-issue-tracker');
