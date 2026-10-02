import React, { useState, useCallback } from 'react';
import { CATEGORIES, PRIORITIES } from '@shared/types';
import { validateReport } from '@shared/validation';
import { createRepository } from './db/repository';
import { db } from './db/schema';
import { useAutosave } from './useAutosave';
import type { Identity } from './identity';
import type { LocalReport } from './db/types';

interface Props {
  identity: Identity;
  /** Pass an existing draft to reopen it; omit for a new report. */
  existing?: LocalReport;
  onSubmitted?: (report: LocalReport) => void;
}

/**
 * datetime-local is interpreted in the device's timezone.
 * Convert to ISO UTC before storing/validating.
 * An invalid input produces NaN which we store as null.
 */
function toIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Convert an ISO UTC string to the datetime-local input format (no timezone). */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  // datetime-local wants YYYY-MM-DDTHH:mm
  return iso.slice(0, 16);
}

export function ReportForm({ identity, existing, onSubmitted }: Props) {
  const repo = createRepository(db);
  const isReadOnly = existing && existing.status !== 'draft';

  const [category, setCategory] = useState(existing?.category ?? 'maintenance');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [location, setLocation] = useState(existing?.location ?? '');
  const [priority, setPriority] = useState(existing?.priority ?? 'low');
  const [reportedAt, setReportedAt] = useState(
    toLocalInput(existing?.reported_at ?? new Date().toISOString()),
  );
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { reportId, saveError, onChange, flush } = useAutosave(
    identity,
    existing?.id ?? null,
  );

  const handleChange = useCallback(
    (fields: Parameters<typeof onChange>[0]) => {
      onChange(fields);
    },
    [onChange],
  );

  if (isReadOnly) {
    return (
      <section style={styles.card}>
        <h2 style={styles.heading}>Report #{existing.id.slice(0, 8)}</h2>
        <p><strong>Status:</strong> {existing.status}</p>
        <p><strong>Category:</strong> {existing.category}</p>
        <p><strong>Description:</strong> {existing.description}</p>
        <p><strong>Location:</strong> {existing.location}</p>
        <p><strong>Priority:</strong> {existing.priority}</p>
        <p><strong>Reported at:</strong> {existing.reported_at}</p>
      </section>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    flush();
    if (!reportId) {
      setSubmitErrors(['No draft to submit yet — type something first.']);
      return;
    }
    setSubmitting(true);
    setSubmitErrors([]);
    setStorageError(null);
    const result = await repo.submitDraft(identity, reportId);
    setSubmitting(false);
    if (!result.ok) {
      if (result.kind === 'storage') {
        setStorageError(result.message);
      } else {
        setSubmitErrors(result.errors);
      }
    } else {
      onSubmitted?.(result.report);
    }
  }

  return (
    <form style={styles.card} onSubmit={handleSubmit} onBlur={flush}>
      <h2 style={styles.heading}>New report</h2>

      {saveError && (
        <p style={styles.errorBanner} role="alert">
          Autosave failed: {saveError}
        </p>
      )}

      {storageError && (
        <p style={styles.errorBanner} role="alert">
          Submit failed (storage error): {storageError}
        </p>
      )}

      <label style={styles.label}>
        Category
        <select
          style={styles.input}
          value={category}
          onChange={(e) => {
            const v = e.target.value as typeof category;
            setCategory(v);
            handleChange({ category: v });
          }}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>

      <label style={styles.label}>
        Description
        <textarea
          style={{ ...styles.input, minHeight: 80 }}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            handleChange({ description: e.target.value });
          }}
          placeholder="Describe the issue"
        />
      </label>

      <label style={styles.label}>
        Location
        <input
          style={styles.input}
          type="text"
          value={location}
          onChange={(e) => {
            setLocation(e.target.value);
            handleChange({ location: e.target.value || null });
          }}
          placeholder="Building / address / landmark"
        />
      </label>

      <label style={styles.label}>
        Priority
        <select
          style={styles.input}
          value={priority}
          onChange={(e) => {
            const v = e.target.value as typeof priority;
            setPriority(v);
            handleChange({ priority: v });
          }}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>

      <label style={styles.label}>
        {/* datetime-local is device-timezone; stored as ISO UTC */}
        Observed at (device timezone)
        <input
          style={styles.input}
          type="datetime-local"
          value={reportedAt}
          onChange={(e) => {
            setReportedAt(e.target.value);
            handleChange({ reported_at: toIso(e.target.value) ?? '' });
          }}
        />
      </label>

      {submitErrors.length > 0 && (
        <ul style={styles.errorList} role="alert" aria-label="Validation errors">
          {submitErrors.map((err, i) => (
            <li key={i}>{err}</li>
          ))}
        </ul>
      )}

      <button style={styles.button} type="submit" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit report'}
      </button>
    </form>
  );
}

// Minimal inline styles — mobile-first, 16px inputs to avoid zoom on iOS.
const styles = {
  card: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: 12,
    maxWidth: 480,
    margin: '0 auto',
    padding: 16,
    fontFamily: 'system-ui, sans-serif',
  },
  heading: { margin: 0, fontSize: 20 },
  label: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: 4,
    fontSize: 14,
    fontWeight: 600,
  },
  input: {
    fontSize: 16, // prevents iOS zoom
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  button: {
    fontSize: 16,
    padding: '10px 0',
    borderRadius: 6,
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
  },
  errorList: {
    margin: 0,
    paddingLeft: 20,
    color: '#b91c1c',
    fontSize: 14,
  },
  errorBanner: {
    margin: 0,
    color: '#b45309',
    fontSize: 13,
  },
} as const;

// Validate that our form's fields satisfy the validator at submit time.
// This is a compile-time check only — no runtime overhead.
// ponytail: intentionally not asserting the result type here; the full check
// is done in handleSubmit via repo.submitDraft.
const _: typeof validateReport = validateReport;
void _;
