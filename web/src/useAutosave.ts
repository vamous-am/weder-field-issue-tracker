import { useEffect, useRef, useState } from 'react';
import { Autosaver } from './db/autosaver';
import { db } from './db/schema';
import type { Identity } from './identity';
import type { ReportContent } from '@shared/types';

/**
 * Thin React hook around Autosaver.
 *
 * Generates (or re-uses) the report ID on first field change.
 * Flushes on blur (via the form's onBlur), visibilitychange, and pagehide.
 *
 * Date handling: datetime-local values are interpreted in the device's
 * timezone. Convert with new Date(value).toISOString() before storing;
 * an invalid value produces NaN and is stored as null so validateReport
 * catches it at submit time rather than crashing here.
 */
export function useAutosave(identity: Identity, existingId: string | null = null) {
  const saverRef = useRef<Autosaver | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(existingId);

  // Create autosaver once per identity/existingId pair.
  useEffect(() => {
    const saver = new Autosaver(db, identity, existingId);
    saverRef.current = saver;
    return () => {
      saver.flush();
    };
  }, [identity.user_id, existingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush on visibility hide and page unload.
  useEffect(() => {
    function flush() {
      if (document.visibilityState === 'hidden') saverRef.current?.flush();
    }
    function flushAlways() {
      saverRef.current?.flush();
    }
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flushAlways);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flushAlways);
    };
  }, []);

  function onChange(fields: Partial<ReportContent>) {
    const saver = saverRef.current;
    if (!saver) return;
    saver.onChange(fields);
    if (saver.id && saver.id !== reportId) setReportId(saver.id);
    setSaveError(saver.saveError);
  }

  function flush() {
    saverRef.current?.flush();
  }

  return { reportId, saveError, onChange, flush };
}
