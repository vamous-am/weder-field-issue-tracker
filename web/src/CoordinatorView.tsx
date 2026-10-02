import React, { useCallback, useEffect, useState } from 'react';
import { allowedTransitions } from '@shared/transitions';
import type { Identity } from './identity';
import type { Status } from '@shared/types';

// ── Wire types (mirrors server response shapes) ───────────────────────────────

interface ServerReport {
  id: string;
  reporter_id: string;
  status: Status;
  version: number;
  category: string;
  description: string;
  location: string | null;
  priority: string;
  reported_at: string;
  assigned_to: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
  received_at: string;
}

interface ServerEvent {
  id: string;
  report_id: string;
  action: string;
  old_value: string | null;
  new_value: string | null;
  actor_role: string;
  actor_id: string | null;
  timestamp: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiHeaders(identity: Identity): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Simulated-Role': identity.role,
    'X-Simulated-User': identity.user_id,
  };
}

async function fetchReports(identity: Identity): Promise<ServerReport[]> {
  const res = await fetch('/api/reports', { headers: apiHeaders(identity) });
  if (!res.ok) throw new Error(`Failed to load reports (${res.status})`);
  const data = (await res.json()) as { reports: ServerReport[] };
  return data.reports;
}

async function fetchDetail(
  identity: Identity,
  id: string,
): Promise<{ report: ServerReport; events: ServerEvent[] }> {
  const res = await fetch(`/api/reports/${id}`, { headers: apiHeaders(identity) });
  if (!res.ok) throw new Error(`Failed to load report (${res.status})`);
  return res.json() as Promise<{ report: ServerReport; events: ServerEvent[] }>;
}

async function patchStatus(
  identity: Identity,
  id: string,
  to: Status,
  expectedVersion: number,
  resolution_notes: string,
): Promise<ServerReport> {
  const res = await fetch(`/api/reports/${id}/status`, {
    method: 'PATCH',
    headers: apiHeaders(identity),
    body: JSON.stringify({ to, expectedVersion, resolution_notes }),
  });
  if (!res.ok) {
    let msg = `Server error (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) msg = body.error.message;
    } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  const data = (await res.json()) as { report: ServerReport };
  return data.report;
}

// ── Status badge colours ──────────────────────────────────────────────────────

const STATUS_COLOR: Record<Status, string> = {
  draft: '#94a3b8',
  submitted: '#2563eb',
  assigned: '#7c3aed',
  in_progress: '#d97706',
  resolved: '#16a34a',
  rejected: '#dc2626',
};

// ── Notes required ────────────────────────────────────────────────────────────

function notesRequired(to: Status): boolean {
  return to === 'rejected' || to === 'resolved';
}

// ── Sub-component: ReportDetail ───────────────────────────────────────────────

interface DetailProps {
  identity: Identity;
  reportId: string;
  onBack: () => void;
  onUpdated: () => void;
}

function ReportDetail({ identity, reportId, onBack, onUpdated }: DetailProps) {
  const [report, setReport] = useState<ServerReport | null>(null);
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionTo, setActionTo] = useState<Status | null>(null);
  const [notes, setNotes] = useState('');
  const [actioning, setActioning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDetail(identity, reportId);
      setReport(data.report);
      setEvents(data.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [identity, reportId]);

  useEffect(() => { void load(); }, [load]);

  async function handleAction() {
    if (!report || !actionTo) return;
    setActioning(true);
    setActionError(null);
    try {
      await patchStatus(identity, report.id, actionTo, report.version, notes.trim());
      onUpdated();
      setActionTo(null);
      setNotes('');
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActioning(false);
    }
  }

  if (loading) return <p style={detailStyles.loading}>Loading…</p>;
  if (error || !report) return (
    <div>
      <button style={detailStyles.back} onClick={onBack}>← Back</button>
      <p style={detailStyles.error}>{error ?? 'Report not found'}</p>
    </div>
  );

  const allowed = allowedTransitions(report.status, 'coordinator');

  return (
    <div>
      <button style={detailStyles.back} onClick={onBack}>← Back</button>

      <section style={detailStyles.card}>
        <h2 style={detailStyles.heading}>
          Report <code style={detailStyles.code}>#{report.id.slice(0, 8)}</code>
          <span
            style={{ ...detailStyles.badge, background: STATUS_COLOR[report.status] }}
            aria-label={`Status: ${report.status}`}
          >
            {report.status}
          </span>
        </h2>

        <dl style={detailStyles.dl}>
          <dt>Reporter</dt><dd>{report.reporter_id}</dd>
          <dt>Category</dt><dd>{report.category}</dd>
          <dt>Priority</dt><dd>{report.priority}</dd>
          <dt>Location</dt><dd>{report.location ?? '—'}</dd>
          <dt>Description</dt><dd style={detailStyles.desc}>{report.description}</dd>
          <dt>Reported at</dt><dd>{new Date(report.reported_at).toLocaleString()}</dd>
          {report.assigned_to && <><dt>Assigned to</dt><dd>{report.assigned_to}</dd></>}
          {report.resolution_notes && (
            <><dt>Notes</dt><dd style={detailStyles.notes}>{report.resolution_notes}</dd></>
          )}
          <dt>Version</dt><dd>{report.version}</dd>
        </dl>
      </section>

      {/* Status actions */}
      {allowed.length > 0 && (
        <section style={detailStyles.card} aria-label="Status actions">
          <h3 style={detailStyles.subheading}>Update status</h3>
          <div style={detailStyles.actionRow}>
            {allowed.map((to) => (
              <button
                key={to}
                style={{
                  ...detailStyles.actionBtn,
                  background: actionTo === to ? STATUS_COLOR[to] : '#f1f5f9',
                  color: actionTo === to ? '#fff' : '#1e293b',
                  border: `1px solid ${STATUS_COLOR[to]}`,
                }}
                onClick={() => { setActionTo(actionTo === to ? null : to); setNotes(''); setActionError(null); }}
                aria-pressed={actionTo === to}
              >
                → {to}
              </button>
            ))}
          </div>

          {actionTo && (
            <div style={detailStyles.notesBlock}>
              <label style={detailStyles.label}>
                Resolution notes{notesRequired(actionTo) ? ' *' : ' (optional)'}
                <textarea
                  style={detailStyles.textarea}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  aria-required={notesRequired(actionTo)}
                  placeholder={notesRequired(actionTo) ? 'Required' : 'Optional'}
                />
              </label>
              {actionError && <p style={detailStyles.error}>{actionError}</p>}
              <button
                style={detailStyles.confirmBtn}
                onClick={() => void handleAction()}
                disabled={actioning || (notesRequired(actionTo) && notes.trim() === '')}
              >
                {actioning ? 'Saving…' : `Confirm: → ${actionTo}`}
              </button>
            </div>
          )}
        </section>
      )}

      {/* History timeline */}
      <section style={detailStyles.card} aria-label="History timeline">
        <h3 style={detailStyles.subheading}>History</h3>
        {events.length === 0 && <p style={detailStyles.empty}>No events yet.</p>}
        <ol style={detailStyles.timeline}>
          {events.map((ev) => (
            <li key={ev.id} style={detailStyles.timelineItem}>
              <span style={detailStyles.timelineAction}>{ev.action}</span>
              <span style={detailStyles.timelineTs}>
                {new Date(ev.timestamp).toLocaleString()}
              </span>
              {ev.actor_id && (
                <span style={detailStyles.timelineActor}>{ev.actor_role}/{ev.actor_id}</span>
              )}
              {ev.new_value && (
                <span style={detailStyles.timelineVal}>{ev.new_value}</span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

// ── Main component: CoordinatorView ──────────────────────────────────────────

interface Props {
  identity: Identity;
}

export function CoordinatorView({ identity }: Props) {
  const [reports, setReports] = useState<ServerReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchReports(identity);
      // newest updated_at first
      rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      setReports(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [identity]);

  useEffect(() => { void load(); }, [load]);

  if (selected) {
    return (
      <main style={styles.main}>
        <ReportDetail
          identity={identity}
          reportId={selected}
          onBack={() => setSelected(null)}
          onUpdated={() => void load()}
        />
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <div style={styles.topRow}>
        <h2 style={styles.heading}>All reports</h2>
        <button style={styles.refreshBtn} onClick={() => void load()} aria-label="Refresh reports">
          ↻ Refresh
        </button>
      </div>

      {loading && <p style={styles.empty}>Loading…</p>}
      {error && <p style={styles.errorText}>{error}</p>}

      {!loading && !error && reports.length === 0 && (
        <p style={styles.empty}>No reports on the server yet.</p>
      )}

      <ul style={styles.list}>
        {reports.map((r) => (
          <li
            key={r.id}
            style={styles.listItem}
            onClick={() => setSelected(r.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setSelected(r.id)}
            aria-label={`Report ${r.id.slice(0, 8)}, status ${r.status}, reporter ${r.reporter_id}`}
          >
            <span style={styles.listId}>#{r.id.slice(0, 8)}</span>
            <span style={styles.listReporter}>{r.reporter_id}</span>
            <span style={styles.listCategory}>{r.category}</span>
            <span
              style={{
                ...styles.listStatus,
                background: `${STATUS_COLOR[r.status]}22`,
                color: STATUS_COLOR[r.status],
              }}
            >
              {r.status}
            </span>
            <span style={styles.listPriority}>{r.priority}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  main: { padding: 16, maxWidth: 680, margin: '0 auto' },
  topRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  heading: { margin: 0, fontSize: 18, fontWeight: 700 },
  refreshBtn: {
    padding: '8px 14px', fontSize: 14,
    background: '#f1f5f9', color: '#1e40af',
    border: '1px solid #cbd5e1', borderRadius: 8, cursor: 'pointer',
  },
  empty: { color: '#64748b', textAlign: 'center' as const, marginTop: 40 },
  errorText: { color: '#dc2626', textAlign: 'center' as const },
  list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' as const, gap: 8 },
  listItem: {
    display: 'flex' as const, alignItems: 'center', gap: 10,
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
    padding: '10px 14px', cursor: 'pointer',
  },
  listId: { fontFamily: 'monospace', fontSize: 12, color: '#94a3b8', minWidth: 72 },
  listReporter: { fontSize: 12, color: '#64748b', minWidth: 70 },
  listCategory: { flex: 1, fontSize: 14 },
  listStatus: {
    fontSize: 12, borderRadius: 4, padding: '2px 6px', fontWeight: 600,
  },
  listPriority: { fontSize: 12, color: '#64748b' },
} as const;

const detailStyles = {
  back: {
    background: 'none', border: 'none', color: '#2563eb',
    cursor: 'pointer', fontSize: 14, padding: '0 0 12px',
  },
  loading: { color: '#64748b', textAlign: 'center' as const },
  error: { color: '#dc2626', fontSize: 14 },
  card: {
    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
    padding: 16, marginBottom: 16,
  },
  heading: { margin: '0 0 12px', fontSize: 18, display: 'flex', alignItems: 'center', gap: 10 },
  code: { fontFamily: 'monospace', fontSize: 14 },
  badge: {
    display: 'inline-block', padding: '2px 8px', borderRadius: 4,
    color: '#fff', fontSize: 12, fontWeight: 700,
  },
  subheading: { margin: '0 0 10px', fontSize: 15 },
  dl: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: '4px 12px', fontSize: 14, margin: 0 } as React.CSSProperties,
  desc: { whiteSpace: 'pre-wrap' as const },
  notes: { color: '#dc2626', whiteSpace: 'pre-wrap' as const },
  actionRow: { display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 10 },
  actionBtn: {
    padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
  },
  notesBlock: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 14, fontWeight: 600 },
  textarea: { fontSize: 14, padding: '8px', borderRadius: 6, border: '1px solid #ccc', resize: 'vertical' as const },
  confirmBtn: {
    padding: '8px 16px', fontSize: 14, borderRadius: 6,
    background: '#2563eb', color: '#fff', border: 'none', cursor: 'pointer',
  },
  timeline: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' as const, gap: 8 },
  timelineItem: {
    display: 'grid', gridTemplateColumns: '120px 160px 1fr', gap: 8,
    fontSize: 13, alignItems: 'start',
    borderLeft: '2px solid #e2e8f0', paddingLeft: 10,
  } as React.CSSProperties,
  timelineAction: { fontWeight: 700, color: '#1e293b' },
  timelineTs: { color: '#64748b', fontSize: 12 },
  timelineActor: { color: '#7c3aed', fontSize: 12 },
  timelineVal: { color: '#475569', fontSize: 12, gridColumn: '1 / -1', paddingLeft: 0 },
  empty: { color: '#64748b', fontSize: 14 },
} as const;
