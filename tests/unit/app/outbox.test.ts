import { describe, expect, it } from 'vitest';
import {
  inOrder,
  memoryStore,
  newEntry,
  type OutboxEntry,
  type OutboxOp,
} from '@/app/_client/outbox';
import { BACKOFF_MS, classify, drainOnce, type SendOutcome } from '@/app/_client/sync';

/**
 * The outbox queue, against an in-memory store.
 *
 * All of the behaviour worth protecting is here rather than in a browser: that
 * order is kept, that a conflict is never retried, that giving up is a state
 * and not a silence. A test that needed IndexedDB would be testing the browser.
 */

const createVerse = (verseId: string): OutboxOp => ({
  kind: 'create-verse',
  verseId,
  body: { tagIds: ['t1'], xp: 'written underground' },
  tags: [{ id: 't1', name: 'metro', label: '.metro' }],
});

const sends = (outcomes: SendOutcome[]) => async (): Promise<SendOutcome> =>
  outcomes.shift() ?? { kind: 'sent' };

describe('classify', () => {
  it('treats 2xx as sent', () => {
    expect(classify({ status: 200 }, '')).toMatchObject({ kind: 'sent' });
    expect(classify({ status: 201 }, '')).toMatchObject({ kind: 'sent' });
    expect(classify({ status: 204 }, '')).toMatchObject({ kind: 'sent' });
  });

  /**
   * The rule the whole queue rests on. A 422 sent again is a 422 again, and a
   * queue that retried it would spin forever *and* hold up every good write
   * behind it, because the queue is strictly ordered.
   */
  it('blocks a request the server will refuse every time', () => {
    for (const status of [400, 404, 413, 422]) {
      expect(classify({ status }, 'no')).toMatchObject({ kind: 'blocked' });
    }
  });

  it('retries the failures that are about the moment, not the request', () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(classify({ status }, 'later')).toMatchObject({ kind: 'retry' });
    }
  });

  /** A conflict is a 4xx but deserves its own words: the row moved underneath. */
  it('blocks a conflict, and says what happened', () => {
    const outcome = classify({ status: 409 }, 'ignored');
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') {
      expect(outcome.error).toContain('changed somewhere else');
    }
  });

  /**
   * Not `retry`: a signed-out browser would otherwise spend the entry's
   * attempts on a problem that has nothing to do with the write, and the write
   * would be blocked by the time someone signed back in.
   */
  it('pauses rather than failing when there is no session', () => {
    expect(classify({ status: 401 }, '')).toMatchObject({ kind: 'paused' });
    expect(classify({ status: 403 }, '')).toMatchObject({ kind: 'paused' });
  });
});

describe('drainOnce', () => {
  it('sends everything it can and empties the queue', async () => {
    const store = memoryStore();
    await store.put(newEntry(createVerse('a'), 1));
    await store.put(newEntry(createVerse('b'), 2));

    const report = await drainOnce(store, sends([]), 10);

    expect(report).toMatchObject({ sent: 2, pausedAt: null });
    expect(await store.all()).toHaveLength(0);
  });

  /**
   * The ordering guarantee, stated as a test because it is the one that is
   * expensive to discover: a verse's edit is queued behind its creation, so a
   * queue that skipped a stuck entry would PATCH a row that does not exist.
   */
  it('stops at the first entry it cannot send rather than skipping it', async () => {
    const store = memoryStore();
    const first = newEntry(createVerse('a'), 1);
    const second = newEntry(createVerse('b'), 2);
    await store.put(first);
    await store.put(second);

    const sent: string[] = [];
    const report = await drainOnce(
      store,
      async (entry) => {
        if (entry.id === first.id) return { kind: 'retry', error: 'offline' };
        sent.push(entry.id);
        return { kind: 'sent' };
      },
      10,
    );

    expect(sent).toEqual([]);
    expect(report).toMatchObject({ sent: 0, retrying: 1 });
    expect(await store.all()).toHaveLength(2);
  });

  it('backs off further on each attempt', async () => {
    const store = memoryStore();
    const entry = newEntry(createVerse('a'), 0);
    await store.put(entry);

    const waits: number[] = [];
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt += 1) {
      const now = 1_000_000 + attempt;
      await drainOnce(store, sends([{ kind: 'retry', error: 'offline' }]), now);
      const stored = (await store.all())[0] as OutboxEntry;
      waits.push(stored.nextAttemptAt - now);
      // Put it back within reach so the next pass actually attempts it.
      await store.put({ ...stored, nextAttemptAt: 0 });
    }

    expect(waits).toEqual([...BACKOFF_MS]);
  });

  /**
   * Out of patience is a state, not a silence. A queue that retried forever
   * would look identical to one that was working, which is the failure §8.1
   * calls out by name.
   */
  it('blocks an entry once the backoff is spent', async () => {
    const store = memoryStore();
    await store.put({
      ...newEntry(createVerse('a'), 0),
      attempts: BACKOFF_MS.length,
    });

    await drainOnce(store, sends([{ kind: 'retry', error: 'still offline' }]), 10);

    const stored = (await store.all())[0] as OutboxEntry;
    expect(stored.state).toBe('blocked');
    expect(stored.lastError).toBe('still offline');
  });

  it('never attempts a blocked entry again on its own', async () => {
    const store = memoryStore();
    await store.put({ ...newEntry(createVerse('a'), 0), state: 'blocked' });

    let attempts = 0;
    await drainOnce(
      store,
      async () => {
        attempts += 1;
        return { kind: 'sent' };
      },
      10,
    );

    expect(attempts).toBe(0);
  });

  it('respects a backoff that has not elapsed', async () => {
    const store = memoryStore();
    await store.put({ ...newEntry(createVerse('a'), 0), nextAttemptAt: 5_000 });

    let attempts = 0;
    const report = await drainOnce(
      store,
      async () => {
        attempts += 1;
        return { kind: 'sent' };
      },
      4_999,
    );

    expect(attempts).toBe(0);
    expect(report.pausedAt).not.toBeNull();
  });

  /** Paused is free: no attempt spent, nothing changed, try again later. */
  it('leaves an entry untouched when there is no session', async () => {
    const store = memoryStore();
    const entry = newEntry(createVerse('a'), 0);
    await store.put(entry);

    await drainOnce(store, sends([{ kind: 'paused' }]), 10);

    expect((await store.all())[0]).toEqual(entry);
  });
});

describe('inOrder', () => {
  /**
   * The ids are UUIDv7, so they sort by the millisecond they were minted. That
   * is the whole ordering mechanism — there is no sequence column to keep in
   * step, and it survives a reload because it is in the id itself.
   */
  it('puts entries back in the order they were queued', () => {
    const first = newEntry(createVerse('a'), 1_700_000_000_000);
    const second = newEntry(createVerse('b'), 1_700_000_001_000);
    const third = newEntry(createVerse('c'), 1_700_000_002_000);

    const shuffled = [third, first, second];
    expect(inOrder(shuffled).map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it('does not mutate what it is given', () => {
    const entries = [newEntry(createVerse('b'), 2), newEntry(createVerse('a'), 1)];
    const before = entries.map((entry) => entry.id);
    inOrder(entries);
    expect(entries.map((entry) => entry.id)).toEqual(before);
  });
});
