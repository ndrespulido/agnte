'use client';

/**
 * The browser's session: an access token and a refresh token, in localStorage.
 *
 * ---------------------------------------------------------------------------
 * The trade, stated once so nobody has to rediscover it.
 *
 * localStorage is readable by any script running on the page, so a single XSS
 * hands an attacker a 30-day refresh token. An httpOnly cookie would not be
 * readable that way. This is a deliberate choice for the web client: the API is
 * bearer-token based because a native app is planned (architecture.md §4), and
 * keeping one session mechanism means the two clients cannot drift apart.
 *
 * What follows from choosing it: the app's defence against session theft is
 * *not having XSS*. That makes a strict Content-Security-Policy and never
 * rendering untrusted HTML load-bearing rather than nice to have. Revisit if
 * this app ever renders another user's content — shared tags already point that
 * way.
 * ---------------------------------------------------------------------------
 */

const ACCESS_KEY = 'agnte.access';
const REFRESH_KEY = 'agnte.refresh';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Every read is guarded. localStorage throws rather than returning null in a
 * Safari private window and in a browser configured to block site data, and an
 * app that crashes on load in private browsing is worse than one that asks for
 * a sign-in.
 */
function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Nothing useful to do: the session simply will not survive a reload.
  }
}

/**
 * The session as an external store React can subscribe to.
 *
 * Reading localStorage in an effect and calling setState is the obvious
 * approach and the wrong one: it renders a signed-in user the sign-in screen
 * for one frame, which reads as having been logged out. `useSyncExternalStore`
 * is the shape React provides for exactly this — a value that lives outside
 * React and changes without React's knowledge.
 *
 * Subscribing also gets cross-tab behaviour for nothing: the `storage` event
 * fires in *other* tabs, so signing out in one signs out the rest.
 */
export type SessionState = 'signed-in' | 'signed-out' | 'unknown';

const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export const getSessionSnapshot = (): SessionState =>
  read(ACCESS_KEY) && read(REFRESH_KEY) ? 'signed-in' : 'signed-out';

/**
 * The server cannot know. Returning 'unknown' — rather than guessing
 * 'signed-out' — is what lets the shell render nothing until the browser
 * answers, instead of flashing a sign-in form at someone who is signed in.
 */
export const getServerSessionSnapshot = (): SessionState => 'unknown';

export const loadTokens = (): Tokens | null => {
  const accessToken = read(ACCESS_KEY);
  const refreshToken = read(REFRESH_KEY);
  return accessToken && refreshToken ? { accessToken, refreshToken } : null;
};

export const saveTokens = (tokens: Tokens): void => {
  write(ACCESS_KEY, tokens.accessToken);
  write(REFRESH_KEY, tokens.refreshToken);
  notify();
};

export const clearTokens = (): void => {
  write(ACCESS_KEY, null);
  write(REFRESH_KEY, null);
  notify();
};

export class NotSignedIn extends Error {
  constructor() {
    super('Not signed in.');
    this.name = 'NotSignedIn';
  }
}

/**
 * One refresh at a time.
 *
 * A timeline page and a tag list can both hit a 401 in the same tick. Two
 * concurrent refreshes both rotate the token, and the second one to land
 * invalidates the first — which the server correctly reads as token reuse and
 * revokes the whole family, signing the user out for doing nothing wrong.
 * Sharing one in-flight promise is what prevents that.
 */
let refreshing: Promise<Tokens | null> | null = null;

async function refresh(): Promise<Tokens | null> {
  const current = loadTokens();
  if (!current) return null;

  refreshing ??= (async () => {
    try {
      const response = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });

      if (!response.ok) {
        clearTokens();
        return null;
      }

      const next = (await response.json()) as Tokens;
      saveTokens(next);
      return next;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * A fetch that carries the access token and retries once after refreshing it.
 *
 * The retry is deliberately once. An access token lasts fifteen minutes, so a
 * 401 immediately after a successful refresh is not a timing problem — it means
 * the session is genuinely gone, and retrying in a loop would turn that into a
 * hang instead of a sign-in prompt.
 */
export async function authedFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const tokens = loadTokens();
  if (!tokens) throw new NotSignedIn();

  const send = (accessToken: string) =>
    fetch(input, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${accessToken}`,
      },
    });

  const first = await send(tokens.accessToken);
  if (first.status !== 401) return first;

  const next = await refresh();
  if (!next) throw new NotSignedIn();

  return send(next.accessToken);
}

export async function signIn(email: string, password: string): Promise<void> {
  const response = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? 'Could not sign in.');
  }

  saveTokens((await response.json()) as Tokens);
}

export async function register(email: string, password: string): Promise<void> {
  const response = await fetch('/v1/auth/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The server replays a retry rather than sending a second verification
      // email; a mobile network retrying underneath the browser is exactly the
      // case this exists for (architecture.md §6).
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ email, password }),
  });

  if (response.status === 202) return;

  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  throw new Error(body?.error?.message ?? 'Could not register.');
}

/**
 * Finishes a Google sign-in, if this load is the redirect back from one.
 *
 * The callback sends the browser to `/#code=…` carrying a single-use handoff
 * code rather than the tokens themselves (see the identity module's
 * `domain/oauth-handoff.ts`). This trades it for a real session.
 *
 * The fragment is cleared with `replaceState` before the exchange even
 * happens, so a spent code does not sit in the address bar or in a history
 * entry — and so a reload cannot try to spend it again and show an error for
 * a sign-in that actually worked.
 *
 * Returns true when it consumed a code, so the caller knows this load was an
 * OAuth return and not an ordinary one.
 */
export async function completeGoogleSignIn(): Promise<boolean> {
  const hash = globalThis.location?.hash ?? '';
  const code = new URLSearchParams(hash.replace(/^#/, '')).get('code');
  if (!code) return false;

  globalThis.history?.replaceState(null, '', globalThis.location.pathname);

  const response = await fetch('/v1/auth/google/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? 'Could not finish signing in with Google.');
  }

  saveTokens((await response.json()) as Tokens);
  return true;
}

export async function signOut(): Promise<void> {
  const tokens = loadTokens();
  clearTokens();
  if (!tokens) return;

  // Best effort: the local tokens are already gone, so a failure here leaves a
  // refresh token valid on the server but unreachable from this browser. Told
  // to sign out, the user's expectation is met either way.
  await fetch('/v1/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  }).catch(() => undefined);
}
