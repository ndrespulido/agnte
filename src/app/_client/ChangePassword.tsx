'use client';

import { useEffect, useState } from 'react';
import { changePassword } from './session';

/**
 * Changing the password of the account already signed in.
 *
 * Says up front that it signs every device out, this one included, because
 * that is what the server does (see `changePassword`'s use case for why it
 * cannot spare the caller) and finding out afterwards feels like a bug rather
 * than a policy.
 *
 * On success the tokens are already gone — `changePassword` in session.ts
 * clears them — so this does not close itself. The shell's session store
 * notices and swaps the whole screen for the sign-in one, which is the honest
 * end of the flow.
 */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await changePassword(current, next);
      // No success state: clearing the tokens above already told the shell,
      // and it is replacing this screen as this resolves.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change it.');
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Change your password"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="detail-date">Change your password</h2>

        <p className="notice">
          Every device is signed out, including this one. You will sign in again with the
          new password.
        </p>

        <form onSubmit={submit}>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <label className="field">
            <span>New password</span>
            <input
              type="password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              autoComplete="new-password"
              // Matches MIN_PASSWORD_LENGTH; the server is the authority and
              // this only saves a round trip.
              minLength={12}
              required
            />
          </label>

          {error ? (
            <p className="notice error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="sheet-actions">
            <button type="button" className="quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
