import type { Clock } from '@/shared/kernel';

/**
 * A single-use code that hands a completed Google sign-in to the browser
 * (architecture.md §4).
 *
 * The problem it solves: Google redirects the *browser* to our callback, so
 * whatever that callback returns is a page the person is looking at, not a
 * value the app can read. Returning the token pair as JSON — which is what
 * this used to do — left a signed-in user staring at their own refresh token
 * and gave the client no way to pick it up.
 *
 * So the callback stores one of these and redirects to `/#code=…`. The client
 * reads the fragment and exchanges it for a session. A fragment is never sent
 * to a server, and what sits in it is worthless a second time and worthless
 * two minutes later — unlike the 30-day refresh token it stands in for.
 *
 * The same shape works for the planned native client, which cannot receive a
 * JSON body from a system browser either.
 */
export interface OAuthHandoff {
  readonly codeHash: string;
  readonly userId: string;
  /** True when the sign-in created the account rather than finding it. */
  readonly created: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Two minutes, against the password reset token's hour.
 *
 * A reset link has to survive a trip through an inbox and a person noticing
 * it. This one has to survive a redirect the browser is already following —
 * it is exchanged within a second of being minted, and anything longer is
 * only a window for a code lying in a history entry to still be worth
 * something.
 */
export const OAUTH_HANDOFF_TTL_MS = 2 * 60 * 1000;

export function issueOAuthHandoff(input: {
  codeHash: string;
  userId: string;
  created: boolean;
  clock: Clock;
}): OAuthHandoff {
  const now = input.clock.now();
  return {
    codeHash: input.codeHash,
    userId: input.userId,
    created: input.created,
    createdAt: now,
    expiresAt: new Date(now.getTime() + OAUTH_HANDOFF_TTL_MS),
  };
}
