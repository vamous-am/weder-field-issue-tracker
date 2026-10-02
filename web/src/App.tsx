import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ROLES } from '@shared/types';
import { getIdentity, setIdentity } from './identity';
import { createRepository } from './db/repository';
import { db } from './db/schema';
import { createSyncEngine } from './db/syncEngine';
import { ReportForm } from './ReportForm';
import type { Identity } from './identity';
import type { LocalReport } from './db/types';
import type { SyncEngine } from './db/syncEngine';

const WORKER_IDS = ['worker-1', 'worker-2'] as const;

const SYNC_BADGE: Record<NonNullable<LocalReport['sync_state']> | 'draft', string> = {
  draft: '✏️',
  pending: '⏳',
  syncing: '🔄',
  synced: '✅',
  failed: '❌',
};

export function App() {
  const [identity, setIdentityState] = useState<Identity>(getIdentity);
  const [reports, setReports] = useState<LocalReport[]>([]);
  const [view, setView] = useState<'list' | 'new' | { report: LocalReport }>('list');
  const [offline, setOffline] = useState(false);
  const engineRef = useRef<SyncEngine | null>(null);

  const repo = createRepository(db);

  const refreshList = useCallback(async (id: Identity) => {
    setReports(await repo.listReports(id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Boot: create engine, recover stale syncing rows, run first pass, wire online.
  useEffect(() => {
    const engine = createSyncEngine({ db });
    engineRef.current = engine;
    void engine.start().then(() => refreshList(getIdentity()));

    const onOnline = () => { setOffline(false); void engine.syncOnce().then(() => refreshList(getIdentity())); };
    const onOffline = () => setOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      engine.stop();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refreshList(identity);
  }, [identity, refreshList]);

  function switchIdentity(userId: string) {
    const next: Identity = { user_id: userId, role: 'field_worker' };
    setIdentity(next);
    setIdentityState(next);
    setView('list');
  }

  function syncBadge(r: LocalReport): string {
    if (r.status === 'draft') return SYNC_BADGE.draft;
    return SYNC_BADGE[r.sync_state ?? 'pending'] ?? '';
  }

  function handleSyncNow() {
    const engine = engineRef.current;
    if (!engine) return;
    void engine.syncOnce().then(() => refreshList(identity));
  }

  function handleRetry(reportId: string) {
    const engine = engineRef.current;
    if (!engine) return;
    void engine.retry(reportId).then(() => refreshList(identity));
  }

  return (
    <div style={styles.page}>
      {/* Offline hint banner — navigator.onLine is UI-only, never gates sends */}
      {offline && (
        <div style={styles.offlineBanner} role="status">
          You appear to be offline. Reports will sync when the connection returns.
        </div>
      )}

      {/* Identity toggle */}
      <header style={styles.header}>
        <span style={styles.appName}>Weder Field Tracker</span>
        <div style={styles.identityBar}>
          {WORKER_IDS.map((uid) => (
            <button
              key={uid}
              style={{
                ...styles.identityBtn,
                ...(identity.user_id === uid ? styles.identityBtnActive : {}),
              }}
              onClick={() => switchIdentity(uid)}
              aria-pressed={identity.user_id === uid}
            >
              {uid}
            </button>
          ))}
        </div>
      </header>

      {view === 'list' && (
        <main style={styles.main}>
          <div style={styles.topRow}>
            <button style={styles.newBtn} onClick={() => setView('new')}>
              + New report
            </button>
            <button style={styles.syncBtn} onClick={handleSyncNow} aria-label="Sync now">
              ↻ Sync now
            </button>
          </div>

          {reports.length === 0 && (
            <p style={styles.empty}>No reports yet for {identity.user_id}.</p>
          )}

          <ul style={styles.list}>
            {reports.map((r) => (
              <li
                key={r.id}
                style={styles.listItem}
                onClick={() => setView({ report: r })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setView({ report: r })}
                aria-label={`Report ${r.id.slice(0, 8)}, status ${r.status}`}
              >
                <span style={styles.listId}>#{r.id.slice(0, 8)}</span>
                <span style={styles.listCategory}>{r.category}</span>
                <span style={styles.listStatus}>{r.status}</span>
                <span title={r.sync_state ?? 'draft'}>{syncBadge(r)}</span>
                {r.sync_state === 'failed' && (
                  <button
                    style={styles.retryBtn}
                    onClick={(e) => { e.stopPropagation(); handleRetry(r.id); }}
                    title={r.last_error ?? 'Sync failed'}
                    aria-label={`Retry sync for report ${r.id.slice(0, 8)}`}
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        </main>
      )}

      {view === 'new' && (
        <main style={styles.main}>
          <button style={styles.backBtn} onClick={() => { setView('list'); refreshList(identity); }}>
            ← Back
          </button>
          <ReportForm
            identity={identity}
            onSubmitted={() => {
              setView('list');
              refreshList(identity);
              void engineRef.current?.syncOnce().then(() => refreshList(identity));
            }}
          />
        </main>
      )}

      {typeof view === 'object' && (
        <main style={styles.main}>
          <button style={styles.backBtn} onClick={() => { setView('list'); refreshList(identity); }}>
            ← Back
          </button>
          <ReportForm
            identity={identity}
            existing={view.report}
            onSubmitted={() => {
              setView('list');
              refreshList(identity);
              void engineRef.current?.syncOnce().then(() => refreshList(identity));
            }}
          />
        </main>
      )}
    </div>
  );
}

const styles = {
  page: { fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: '#f8fafc' },
  offlineBanner: {
    background: '#fef3c7',
    color: '#92400e',
    textAlign: 'center' as const,
    padding: '8px 16px',
    fontSize: 13,
    borderBottom: '1px solid #fde68a',
  },
  header: {
    display: 'flex' as const,
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    background: '#1e40af',
    color: '#fff',
  },
  appName: { fontWeight: 700, fontSize: 16 },
  identityBar: { display: 'flex', gap: 8 },
  identityBtn: {
    padding: '4px 10px',
    borderRadius: 4,
    border: '1px solid rgba(255,255,255,0.4)',
    background: 'transparent',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
  },
  identityBtnActive: { background: 'rgba(255,255,255,0.2)', fontWeight: 700 },
  main: { padding: 16, maxWidth: 520, margin: '0 auto' },
  topRow: { display: 'flex', gap: 8, marginBottom: 16 },
  newBtn: {
    flex: 1,
    padding: '12px 0',
    fontSize: 16,
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
  syncBtn: {
    padding: '12px 16px',
    fontSize: 14,
    background: '#f1f5f9',
    color: '#1e40af',
    border: '1px solid #cbd5e1',
    borderRadius: 8,
    cursor: 'pointer',
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 0 12px',
  },
  empty: { color: '#64748b', textAlign: 'center' as const, marginTop: 40 },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' as const, gap: 8 },
  listItem: {
    display: 'flex' as const,
    alignItems: 'center',
    gap: 10,
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: '10px 14px',
    cursor: 'pointer',
  },
  listId: { fontFamily: 'monospace', fontSize: 12, color: '#94a3b8', minWidth: 72 },
  listCategory: { flex: 1, fontSize: 14 },
  listStatus: {
    fontSize: 12,
    background: '#f1f5f9',
    borderRadius: 4,
    padding: '2px 6px',
    color: '#475569',
  },
  retryBtn: {
    fontSize: 11,
    padding: '2px 8px',
    background: '#fee2e2',
    color: '#b91c1c',
    border: '1px solid #fca5a5',
    borderRadius: 4,
    cursor: 'pointer',
  },
} as const;

// Suppress unused import warning
void ROLES;
