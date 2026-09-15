'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { resetPassword } from './session';

/**
 * Setting a new password from a mailed link.
 *
 * The token comes from the query string rather than being typed, and is read
 * once on mount into state: it is a credential, and leaving it in the URL to
 * be re-read on every render invites it into a `Referer` header, a screenshot,
 * or a shared link. Stripping it from the address bar afterwards is the same
 * reasoning the OAuth return uses.
 *
 * Deliberately does not sign anyone in on success. The reset revoked every
 * session by design (see `resetPassword`'s use case), so the honest next step
 * is the sign-in screen with the password they just chose.
 */
export function ResetPassword() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /**
   * Guards against reading the query string twice.
   *
   * This effect strips the token from the URL, which makes it destructive:
   * React's Strict Mode double-invokes effects in development, and the second
   * run was reading the *already stripped* URL and overwriting a perfectly
   * good token with null — so every reset link showed "No reset link" in dev.
   * Found by opening the page in a browser; it would not have shown up in
   * production, where effects run once, which is exactly what makes it the
   * kind of bug worth a guard rather than an explanation.
   */
  const read = useRef(false);

  useEffect(() => {
    if (read.current) return;
    read.current = true;

    const found = new URLSearchParams(window.location.search).get('token');

    /*
     * A deliberate, scoped exception to react-hooks/set-state-in-effect.
     *
     * The rule guards against cascading renders, and this cannot cascade: the
     * dependency list is empty, so it runs exactly once. The alternatives are
     * both worse — a lazy `useState` initialiser would have to touch `window`
     * during server rendering, and gating on a "mounted" flag is the same
     * setState in an effect with an extra render on top.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(found);

    if (found) {
      // Out of the address bar, so a back button or a copied URL does not
      // carry a live credential.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;

    setBusy(true);
    setError(null);

    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="auth">
        <h1>Password changed</h1>
        <p className="lede">
          Every device was signed out, including this one. Sign in with the new password.
        </p>
        <Link className="google-sign-in" href="/">
          Go to sign in
        </Link>
      </div>
    );
  }

  // Someone who opened the page directly, or whose link lost its token on the
  // way through a mail client that rewrites URLs.
  if (token === null) {
    return (
      <div className="auth">
        <h1>No reset link</h1>
        <p className="lede">
          This page needs the link from the email. Ask for a fresh one if that link is old
          — they expire.
        </p>
        <Link className="google-sign-in" href="/">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="auth">
      <h1>Set a new password</h1>

      <form onSubmit={submit}>
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
        </label>

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Working…' : 'Set password'}
        </button>
      </form>
    </div>
  );
}
