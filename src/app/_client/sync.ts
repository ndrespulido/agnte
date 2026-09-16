'use client';

import { NotSignedIn, authedFetch } from './session';
import {
  defaultStore,
  inOrder,
  memoryStore,
  newEntry,
  type OutboxEntry,
  type OutboxOp,
  type OutboxStore,
} from './outbox';

/**
 * Draining the outbox (§8.1): replay in order, back off, give up honestly.
 *
 * The decisions live in `classify` and `drainOnce`, both of which take what they
 * need rather than reaching for globals, so the interesting behaviour — a
 * conflict is not retried, a blocked entry does not let the one behind it jump
 * the queue — is testable without a browser.
 */

/** Waits between attempts. Past the end of this the entry is blocked. */
export const BACKOFF_MS = [1_000, 4_000, 15_000, 60_000] as const;

export type SendOutcome =
  /** It landed. Also the answer for a duplicate the server recognised. */
  | { kind: 'sent' }
  /** Worth trying again later: the network, or the server having a moment. */
  | { kind: 'retry'; error: string }
  /** No number of retries will change this. A person has to look. */
  | { kind: 'blocked'; error: string }
  /**
   * Nothing is wrong with the entry; this browser just cannot send right now
   * because nobody is signed in. Deliberately not `retry`: burning attempts
   * while signed out would block a queue for a reason that has nothing to do
   * with the writes in it.
   */
  | { kind: 'paused' };

/**
 * What a response means for the entry that produced it.
 *
 * The rule worth stating: a 4xx that is not 408, 409 or 429 is the server
 * saying the request itself is wrong, and sending it again produces the same
 * answer. Retrying those is how a queue turns one bad write into an infinite
 * loop that also holds up every good write behind it.
 */
export function classify(response: { status: number }, message: string): SendOutcome {
  const { status } = response;

  if (status >= 200 && status < 300) return { kind: 'sent' };

  // A conflict is the one failure the reader can act on, and the one no retry
  // can fix: the row moved under this write.
  if (status === 409) {
    return {
      kind: 'blocked',
      error: 'That verse changed somewhere else. Open it to see the current version.',
    };
  }

  if (status === 401 || status === 403) return { kind: 'paused' };

  if (status === 408 || status === 429 || status >= 500) {
    return { kind: 'retry', error: message };
  }

  if (status >= 400) return { kind: 'blocked', error: message };

  return { kind: 'retry', error: message };
}

async function messageOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  return body?.error?.message ?? `The server answered ${response.status}.`;
}

/** Puts one entry on the wire. The only part of this file that needs a network. */
export async function sendEntry(entry: OutboxEntry): Promise<SendOutcome> {
  const idempotent = {
    'content-type': 'application/json',
    'idempotency-key': entry.idempotencyKey,
  };

  try {
    const response = await request(entry.op, idempotent);
    return classify(response, await messageOf(response));
  } catch (cause) {
    if (cause instanceof NotSignedIn) return { kind: 'paused' };
    // A thrown fetch is the offline case and every DNS/TLS/reset failure with
    // it. None of them say anything about whether the write is valid.
    return {
      kind: 'retry',
      error: cause instanceof Error ? cause.message : 'Could not reach the server.',
    };
  }
}

function request(op: OutboxOp, headers: Record<string, string>): Promise<Response> {
  switch (op.kind) {
    case 'create-tag':
      return authedFetch('/v1/tags', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: op.tagId, name: op.name }),
      });
    case 'create-verse':
      return authedFetch('/v1/verses', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...op.body, id: op.verseId }),
      });
    case 'update-verse':
      return authedFetch(`/v1/verses/${op.verseId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(op.body),
      });
    case 'delete-verse':
      return authedFetch(
        `/v1/verses/${op.verseId}?expectedVersion=${op.expectedVersion}`,
        { method: 'DELETE', headers },
      );
  }
}

export interface DrainReport {
  readonly sent: number;
  readonly retrying: number;
  /** Set when the queue stopped early, so the caller knows to come back. */
  readonly pausedAt: string | null;
}

/**
 * One pass over the queue, strictly in order.
 *
 * It stops at the first entry it cannot send rather than skipping past it. That
 * is not conservatism — a verse's edit is queued behind its creation, and a
 * delete behind both, so sending them out of order means writing an edit to a
 * row that does not exist yet. The cost is that one blocked entry holds up the
 * ones behind it, which is why blocking is reserved for failures a person
 * genuinely has to resolve.
 */
export async function drainOnce(
  store: OutboxStore,
  send: (entry: OutboxEntry) => Promise<SendOutcome>,
  now: number = Date.now(),
): Promise<DrainReport> {
  let sent = 0;
  let retrying = 0;

  for (const entry of inOrder(await store.all())) {
    if (entry.state === 'blocked') return { sent, retrying, pausedAt: entry.id };
    if (entry.nextAttemptAt > now) return { sent, retrying, pausedAt: entry.id };

    const outcome = await send(entry);

    if (outcome.kind === 'sent') {
      await store.remove(entry.id);
      sent += 1;
      continue;
    }

    if (outcome.kind === 'paused') return { sent, retrying, pausedAt: entry.id };

    const attempts = entry.attempts + 1;
    const wait = BACKOFF_MS[entry.attempts];

    // Out of patience is its own kind of blocked: the write is not obviously
    // wrong, but it has failed enough times that silently retrying forever
    // would be pretending.
    const blocked = outcome.kind === 'blocked' || wait === undefined;

    await store.put({
      ...entry,
      attempts,
      lastError: outcome.error,
      state: blocked ? 'blocked' : 'queued',
      nextAttemptAt: blocked ? entry.nextAttemptAt : now + wait,
    });

    if (!blocked) retrying += 1;
    return { sent, retrying, pausedAt: entry.id };
  }

  return { sent, retrying, pausedAt: null };
}

/* -------------------------------------------------------------------------
 * The live queue: one store, one drain at a time, and a subscription the UI
 * reads. Everything below is wiring; the behaviour is above.
 * ---------------------------------------------------------------------- */

let store: OutboxStore = defaultStore();
let entries: OutboxEntry[] = [];
let draining: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();
const EMPTY: OutboxEntry[] = [];

const notify = (): void => {
  for (const listener of listeners) listener();
};

async function refresh(): Promise<void> {
  try {
    entries = inOrder(await store.all());
  } catch {
    // A store that cannot be read is a store that cannot be trusted to hold
    // anything either. Falling back keeps this session's writes working;
    // saying so keeps it from looking like they vanished.
    console.warn('[outbox] the local database is unavailable; queueing in memory');
    entries = [];
  }
  notify();
}

/** The queue as React reads it. */
export function subscribeToOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const outboxSnapshot = (): OutboxEntry[] => entries;

/** Nothing is queued on the server: the outbox is this browser's, by definition. */
export const serverOutboxSnapshot = (): OutboxEntry[] => EMPTY;

/**
 * Sends what it can, then schedules itself for whatever is waiting.
 *
 * Single-flight: `online` firing while a drain is in progress must not start a
 * second one, or two passes send the same entry twice — harmless thanks to the
 * idempotency key, but it would double every request on a flaky connection,
 * which is exactly when that is most expensive.
 */
export function drain(): Promise<void> {
  draining ??= (async () => {
    try {
      // One pass is enough: `drainOnce` keeps going while entries send and
      // stops at the first that cannot, so there is nothing left for a second
      // pass to pick up that a later wake-up will not.
      await drainOnce(store, sendEntry);
      await refresh();
      scheduleNext();
    } finally {
      draining = null;
    }
  })();

  return draining;
}

/** Wakes up when the soonest waiting entry is due, and not before. */
function scheduleNext(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;

  const waiting = entries.filter((entry) => entry.state === 'queued');
  if (waiting.length === 0) return;

  const soonest = Math.min(...waiting.map((entry) => entry.nextAttemptAt));
  const wait = Math.max(0, soonest - Date.now());
  timer = setTimeout(() => void drain(), wait);
}

/** Queues a write and starts sending it. Resolves once it is *stored*, not sent. */
export async function enqueue(op: OutboxOp): Promise<OutboxEntry> {
  const entry = newEntry(op);
  try {
    await store.put(entry);
  } catch {
    // Nowhere to keep it is not a reason to lose it: fall back to memory and
    // carry on, at the cost of not surviving a reload. Whatever the old store
    // held is not copied over — a store that refuses a write is not one to
    // trust a read to either.
    store = memoryStore();
    await store.put(entry);
  }
  await refresh();
  void drain();
  return entry;
}

/** Forgets a blocked entry. The one way out of a write that will never land. */
export async function discard(id: string): Promise<void> {
  await store.remove(id);
  await refresh();
}

/** Puts a blocked entry back in the queue, at the front of its own turn. */
export async function retryNow(id: string): Promise<void> {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return;

  await store.put({
    ...entry,
    state: 'queued',
    attempts: 0,
    lastError: null,
    nextAttemptAt: Date.now(),
  });
  await refresh();
  void drain();
}

let started = false;

/**
 * Reads what a previous session left behind and starts sending it.
 *
 * Called from the shell once the browser is known to be signed in. The
 * `online` listener is the reconnect trigger §8.1 asks for; `visibilitychange`
 * is there because a phone that was asleep does not always fire `online` on
 * waking, and a queue that only drains on an event nobody sent is a queue that
 * never drains.
 */
export function startSync(): void {
  if (started) return;
  started = true;

  void refresh().then(() => drain());

  window.addEventListener('online', () => void drain());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void drain();
  });
}

/** Test seam: a fresh queue against a store the test controls. */
export function resetSyncForTests(next: OutboxStore): void {
  store = next;
  entries = [];
  started = false;
  draining = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  listeners.clear();
}
