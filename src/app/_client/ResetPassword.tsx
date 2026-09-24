'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { resetPassword } from './session';
import { useStrings } from './locale';

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
  const s = useStrings();
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
     * Runs once — the dependency list is empty and the ref above guards it —
     * so it cannot cascade.
     *
     * This used to carry an eslint-disable for react-hooks/set-state-in-effect.
     * It no longer needs one: the rule fires on a setState whose argument is a
     * freshly built object (which can never bail out of a re-render), and a
     * string is not that. The directive became an unused-directive warning,
     * which is why it is gone rather than kept for safety.
     */
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
      setError(cause instanceof Error ? cause.message : s.common.somethingWentWrong);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="auth">
        <h1>{s.password.changed}</h1>
        <p className="lede">{s.password.signedOutEverywhere}</p>
        <Link className="google-sign-in" href="/">
          {s.password.goToSignIn}
        </Link>
      </div>
    );
  }

  // Someone who opened the page directly, or whose link lost its token on the
  // way through a mail client that rewrites URLs.
  if (token === null) {
    return (
      <div className="auth">
        <h1>{s.password.noResetLink}</h1>
        <p className="lede">{s.password.needsTheLink}</p>
        <Link className="google-sign-in" href="/">
          {s.password.backToSignIn}
        </Link>
      </div>
    );
  }

  return (
    <div className="auth">
      <h1>{s.password.setNew}</h1>

      <form onSubmit={submit}>
        <label className="field">
          <span>{s.password.next}</span>
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
          {busy ? s.common.working : s.password.setPassword}
        </button>
      </form>
    </div>
  );
}
