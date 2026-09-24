'use client';

import { useEffect, useRef, useState } from 'react';
import {
  downloadExport,
  eraseAccount,
  fetchExportStatus,
  importDocument,
  requestExport,
  ExportTooSoon,
  type ErasureView,
  type ExportStatusView,
  type ImportSummaryView,
} from './api';
import { failureMessage, useStrings } from './locale';

/**
 * Your data: take a copy, read one back, or leave (§8.5, §8.7).
 *
 * These three have worked over the API since Phase 8 and Phase 9 and had no way
 * in from the app. For export and import that was an inconvenience. For erasure
 * it was closer to a defect: the right to erasure is a right a *person* holds,
 * and a right you can only exercise with `curl` and a bearer token is not one
 * most people have.
 *
 * All three live in one sheet because they are one thought — "what happens to
 * what I have written" — and splitting them across a menu would make the
 * dangerous one easier to reach by accident, not harder.
 */

/** Matches `ERASURE_GRACE_MS` in the identity module. Stated, not imported: a
 *  client component cannot reach a module without pulling the server into the
 *  browser bundle. If that constant moves, this sentence has to move with it. */
const GRACE_DAYS = 30;

/** "1 tag", "2 tags". Small, but "1 tags" reads as a machine talking. */

export function YourData({
  onClose,
  onErased,
}: {
  onClose: () => void;
  onErased: () => void;
}) {
  const s = useStrings();
  const [exported, setExported] = useState<ExportStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [imported, setImported] = useState<ImportSummaryView | null>(null);
  const [importing, setImporting] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [erased, setErased] = useState<ErasureView | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchExportStatus()
      .then((status) => {
        if (!cancelled) setExported(status);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : '');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function ask() {
    setError(null);
    setNotice(null);
    try {
      const requested = await requestExport();
      setExported({
        id: requested.id,
        status: 'pending',
        requestedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
      });
      // The server says so when nothing will ever build it; repeating it here
      // is the difference between waiting and waiting for nothing.
      setNotice(requested.warning ?? s.yourData.building);
    } catch (cause) {
      setError(
        cause instanceof ExportTooSoon || cause instanceof Error ? cause.message : '',
      );
    }
  }

  /**
   * Hands the file to the browser rather than linking to it.
   *
   * The download endpoint authenticates — §8.5's deliberate deviation from a
   * signed URL — and an `<a href>` sends no Authorization header, so the link
   * would 401. Fetching it and handing over a blob is what a bearer-token API
   * costs on the web.
   */
  async function save() {
    setError(null);
    try {
      const { blob, filename } = await downloadExport();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '');
    }
  }

  async function read(file: File) {
    setError(null);
    setImported(null);
    setImporting(true);

    try {
      // Parsed here so a file that is not JSON at all is said plainly, rather
      // than being sent up to come back as a 400 about a body.
      const text = await file.text();
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        setError(s.yourData.notJson);
        return;
      }

      setImported(await importDocument(document));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '');
    } finally {
      setImporting(false);
      // Cleared so choosing the same file again still fires a change event —
      // the natural thing to do after fixing what was rejected.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function erase() {
    setError(null);
    try {
      setErased(await eraseAccount());
    } catch (cause) {
      setConfirmingDelete(false);
      setError(cause instanceof Error ? cause.message : '');
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={s.yourData.heading}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="sheet-title">{s.yourData.heading}</h2>

        {error !== null ? (
          <p className="notice" role="alert">
            {/* One banner for every failure on this sheet — reading the
                status, asking for a copy, importing, deleting — so the
                fallback is the most general of them. The specific ones are
                the server's, which arrive with their own words. */}
            {failureMessage(error, s.yourData.couldNotRead)}
          </p>
        ) : null}

        {/* ------------------------------------------------------------- */}
        <section className="data-section">
          <h3>{s.yourData.copyHeading}</h3>
          <p className="data-note">
            Every verse, tag and reminder as one JSON file. Photos are linked rather than
            included, and those links expire — so act on it within a day rather than
            filing it away.
          </p>

          {loading ? (
            <p className="data-note">{s.yourData.checking}</p>
          ) : exported === null ? (
            <p className="data-note">{s.yourData.noneYet}</p>
          ) : (
            <p className="data-note">
              {s.yourData.lastAsked(new Date(exported.requestedAt).toLocaleString())}
              <strong>{exported.status}</strong>
              {exported.error ? `: ${exported.error}` : ''}
            </p>
          )}

          {notice ? <p className="data-note">{notice}</p> : null}

          <div className="data-actions">
            <button type="button" className="quiet" onClick={() => void ask()}>
              {s.yourData.askForACopy}
            </button>
            {exported?.status === 'ready' ? (
              <button type="button" className="quiet" onClick={() => void save()}>
                {s.yourData.download}
              </button>
            ) : null}
          </div>
        </section>

        {/* ------------------------------------------------------------- */}
        <section className="data-section">
          <h3>{s.yourData.importHeading}</h3>
          <p className="data-note">{s.yourData.importNote}</p>

          {/* The same styled picker the add sheet uses, for the same reason:
              the browser's default control is the one element on the screen
              that does not look like the rest of the app. */}
          <label className="file-picker">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              disabled={importing}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void read(file);
              }}
            />
            {s.yourData.chooseAFile}
          </label>

          {importing ? <p className="data-note">{s.yourData.readingIt}</p> : null}

          {imported ? (
            <div className="import-summary">
              <p className="data-note">
                {s.yourData.importedSummary(
                  s.count.tags(imported.tags),
                  s.count.verses(imported.verses),
                )}{' '}
                {imported.skipped > 0
                  ? s.yourData.alreadyHere(
                      s.count.rows(imported.skipped),
                      imported.skipped,
                    )
                  : null}
              </p>
              <p className="data-note">{imported.note}</p>

              {imported.rejected.length > 0 ? (
                <>
                  {/* Listed rather than counted. A refused row is the one thing
                      the person can actually act on, and "3 rejected" tells
                      them nothing about which three or why. */}
                  <p className="data-note">{s.yourData.refused}</p>
                  <ul className="rejected">
                    {imported.rejected.map((row, index) => (
                      <li key={`${row.what}-${index}`}>
                        <strong>{row.what}</strong> — {row.why}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* ------------------------------------------------------------- */}
        <section className="data-section danger">
          <h3>{s.yourData.deleteHeading}</h3>

          {erased ? (
            /*
             * What actually happened, in the order it happened.
             *
             * `modulesFailed` is shown rather than swallowed: a module that
             * could not purge is precisely the fact someone exercising this
             * right most needs, and "we have started" over a silent failure is
             * the worst available answer.
             */
            <>
              <p className="data-note">
                {s.yourData.erasedDone} (
                {s.yourData.erasedPurged(s.count.parts(erased.modulesPurged))}
                {erased.modulesFailed > 0
                  ? s.yourData.erasedFailed(erased.modulesFailed)
                  : ''}
                ). {s.yourData.erasedRecordRemoved(GRACE_DAYS)}
              </p>
              <div className="data-actions">
                <button type="button" className="quiet" onClick={onErased}>
                  {s.menu.signOut}
                </button>
              </div>
            </>
          ) : confirmingDelete ? (
            <>
              <p className="data-note">
                <strong>{s.yourData.deleteWarning(GRACE_DAYS)}</strong>
                {s.yourData.deleteNoUndo(GRACE_DAYS)}
              </p>
              <p className="data-note">{s.yourData.deleteKeepFirst}</p>
              <div className="data-actions">
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void erase()}
                >
                  {s.yourData.deleteEverything}
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {s.yourData.keepMyAccount}
                </button>
              </div>
            </>
          ) : (
            <div className="data-actions">
              <button
                type="button"
                className="quiet"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete this account
              </button>
            </div>
          )}
        </section>

        <div className="sheet-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
