'use client';

import { useState } from 'react';
import { forgotPassword, register, signIn } from './session';
import { useStrings } from './locale';

/**
 * Sign in, or start registering.
 *
 * Registration deliberately ends at "check your email" rather than signing the
 * person in: the account does not exist until the link is clicked
 * (architecture.md §4), so anything else here would be a lie about what just
 * happened.
 */
export function SignIn({
  onSignedIn,
  googleEnabled,
  notice,
}: {
  onSignedIn: () => void;
  /** False in every preview, where Google cannot register the redirect URI. */
  googleEnabled: boolean;
  /**
   * A message from something that happened before this screen: an OAuth
   * return that failed on the way back, or an email verification link that
   * was just redeemed.
   *
   * Carries its own tone because those two are not the same news, and the
   * single red line this used to render made "your account is ready" look
   * like a failure.
   */
  notice?: { text: string; tone: 'error' | 'success' } | null;
}) {
  const s = useStrings();
  const [mode, setMode] = useState<'sign-in' | 'register' | 'forgot'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      if (mode === 'sign-in') {
        await signIn(email, password);
        onSignedIn();
      } else if (mode === 'forgot') {
        await forgotPassword(email);
        setSent(true);
      } else {
        await register(email, password);
        setSent(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : s.common.somethingWentWrong);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth">
        <h1>{s.signIn.checkYourEmail}</h1>
        <p className="lede">
          {mode === 'forgot'
            ? s.signIn.resetLinkOnItsWay(email)
            : s.signIn.linkWaitingAt(email)}
        </p>
        {/*
          Said plainly rather than left to be discovered. A verification mail
          from a young sending domain lands in spam often enough that its
          absence reads as a broken app, and someone who does not find it
          simply gives up — which is the one outcome this screen cannot
          recover from.
        */}
        <p className="notice">{s.signIn.checkSpam}</p>
      </div>
    );
  }

  return (
    <div className="auth">
      <h1>{s.signIn.appName}</h1>
      <p className="lede">{s.signIn.tagline}</p>

      <form onSubmit={submit}>
        <label className="field">
          <span>{s.signIn.email}</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>

        {/* Nothing to ask for when the whole point is that they cannot
            remember it. `required` has to go with it, or the form refuses to
            submit over a field nobody can see. */}
        {mode === 'forgot' ? null : (
          <label className="field">
            <span>{s.signIn.password}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              // Matches MIN_PASSWORD_LENGTH. The server is the authority; this
              // only saves a round trip.
              minLength={12}
              required
            />
          </label>
        )}

        {(error ?? notice) ? (
          <p
            className={`notice ${error || notice?.tone === 'error' ? 'error' : 'success'}`}
            role={error || notice?.tone === 'error' ? 'alert' : 'status'}
          >
            {error ?? notice?.text}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={busy}>
          {busy
            ? s.common.working
            : mode === 'sign-in'
              ? s.signIn.signIn
              : mode === 'forgot'
                ? s.signIn.forgotPassword
                : s.signIn.createAccount}
        </button>
      </form>

      {/* A link rather than a fetch: the flow is a top-level navigation to
          Google and back, so it has to leave the page. Hidden entirely when
          Google is not configured — a button that answers 503 is worse than
          no button, and previews are permanently in that state. */}
      {googleEnabled ? (
        <>
          <p className="or">{s.signIn.or}</p>
          <a className="google-sign-in" href="/v1/auth/google">
            {s.signIn.continueWithGoogle}
          </a>
        </>
      ) : null}

      <button
        type="button"
        className="quiet"
        onClick={() => {
          setMode(mode === 'sign-in' ? 'register' : 'sign-in');
          setError(null);
        }}
      >
        {mode === 'sign-in' ? s.signIn.createAnAccount : s.signIn.haveAnAccount}
      </button>

      {/* Only from sign-in. Offering it while registering would be noise, and
          from the forgot screen itself it would be a link to where you are. */}
      {mode === 'sign-in' ? (
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setMode('forgot');
            setError(null);
          }}
        >
          {s.signIn.forgotMyPassword}
        </button>
      ) : null}
    </div>
  );
}
