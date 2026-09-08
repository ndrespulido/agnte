'use client';

import { useState } from 'react';
import { register, signIn } from './session';

/**
 * Sign in, or start registering.
 *
 * Registration deliberately ends at "check your email" rather than signing the
 * person in: the account does not exist until the link is clicked
 * (architecture.md §4), so anything else here would be a lie about what just
 * happened.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'sign-in' | 'register'>('sign-in');
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
      } else {
        await register(email, password);
        setSent(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth">
        <h1>Check your email</h1>
        <p className="lede">
          There is a link waiting at {email}. The account exists once you click it.
        </p>
      </div>
    );
  }

  return (
    <div className="auth">
      <h1>Agnte</h1>
      <p className="lede">A timeline for your life.</p>

      <form onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>

        <label className="field">
          <span>Password</span>
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

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <button
        type="button"
        className="quiet"
        onClick={() => {
          setMode(mode === 'sign-in' ? 'register' : 'sign-in');
          setError(null);
        }}
      >
        {mode === 'sign-in' ? 'Create an account' : 'I already have an account'}
      </button>
    </div>
  );
}
