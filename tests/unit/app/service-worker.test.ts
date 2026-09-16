import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The service worker's routing, driven against the real file.
 *
 * `public/sw.js` is plain JavaScript because that is what a browser loads it
 * as; it is not part of the TypeScript build and cannot be imported. Rather
 * than restate its rules here — which would test the copy and not the worker —
 * the file is evaluated in a VM with the globals a worker has, and its own
 * functions are called.
 *
 * What is worth protecting: that writes are never touched, that only the
 * timeline is cached, that the moving anchor does not make every request a new
 * key, and that a failed response is never stored.
 */

interface Worker {
  strategyFor(url: string, method: string): string;
  cacheKeyFor(request: { url: string }): string;
  networkFirst(
    request: { url: string },
    cacheName: string,
    key: string,
  ): Promise<{ status: number; body: string }>;
  listeners: Map<string, (event: unknown) => void>;
  store: Map<string, Map<string, { status: number; body: string }>>;
}

const SOURCE = readFileSync('public/sw.js', 'utf8');

/** A cache good enough to answer the questions this file asks of it. */
function fakeCaches(store: Map<string, Map<string, { status: number; body: string }>>) {
  return {
    open: async (name: string) => {
      const entries = store.get(name) ?? new Map();
      store.set(name, entries);
      return {
        match: async (key: string) => entries.get(key),
        put: async (key: string, response: { status: number; body: string }) => {
          entries.set(key, response);
        },
      };
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };
}

function load(fetchImpl: (request: { url: string }) => Promise<unknown>): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const store = new Map<string, Map<string, { status: number; body: string }>>();

  const context: Record<string, unknown> = {
    caches: fakeCaches(store),
    fetch: fetchImpl,
    URL,
  };
  context.self = {
    location: { origin: 'https://agnte.test' },
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      listeners.set(name, handler);
    },
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };

  createContext(context);
  runInContext(SOURCE, context);

  return { ...(context as unknown as Worker), listeners, store };
}

/** A response that behaves the way the worker uses one: `ok` and `clone`. */
const response = (status: number, body = 'x') => ({
  status,
  body,
  ok: status >= 200 && status < 300,
  clone() {
    return { status, body };
  },
});

describe('strategyFor', () => {
  let sw: Worker;
  beforeEach(() => {
    sw = load(async () => response(200));
  });

  /**
   * The rule that keeps the two mechanisms apart. Writes belong to the outbox
   * (§8.1); a service worker replaying them as well would be a second queue
   * with its own idea of the order, and the ordering is what makes the outbox
   * correct.
   */
  it('never touches a write', () => {
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      expect(sw.strategyFor('https://agnte.test/v1/verses', method)).toBe('pass');

      // A path that *would* be cached on GET, so this exercises the method
      // guard itself rather than passing because /v1/ is left alone anyway.
      expect(sw.strategyFor('https://agnte.test/', method)).toBe('pass');
      expect(sw.strategyFor('https://agnte.test/v1/timeline', method)).toBe('pass');
    }
  });

  it("caches Next's content-hashed output aggressively", () => {
    expect(sw.strategyFor('https://agnte.test/_next/static/chunks/a.js', 'GET')).toBe(
      'static',
    );
  });

  it('caches the timeline, and only the timeline', () => {
    expect(sw.strategyFor('https://agnte.test/v1/timeline?direction=past', 'GET')).toBe(
      'data',
    );

    // §8.1 puts these online-only on purpose: a dashboard or a search answer
    // served from yesterday is a wrong answer rather than an old one.
    for (const path of ['/v1/search?q=a', '/v1/deep-time', '/v1/tags/x/dashboard']) {
      expect(sw.strategyFor(`https://agnte.test${path}`, 'GET')).toBe('pass');
    }
  });

  it('serves the document network-first so the app can update', () => {
    expect(sw.strategyFor('https://agnte.test/', 'GET')).toBe('shell');
    expect(sw.strategyFor('https://agnte.test/status', 'GET')).toBe('shell');
  });

  /** A worker that could serve itself from a cache could never be replaced. */
  it('never serves itself from a cache', () => {
    expect(sw.strategyFor('https://agnte.test/sw.js', 'GET')).toBe('pass');
  });

  it('leaves object storage alone', () => {
    expect(sw.strategyFor('https://media.example.com/thumb.jpg', 'GET')).toBe('pass');
  });
});

describe('cacheKeyFor', () => {
  /**
   * The bug this prevents, which is invisible until you are offline: the app
   * anchors the timeline on `new Date()` every time it opens, so keyed on the
   * URL as sent every request is a new key. The cache fills up and never
   * answers anything.
   */
  it('drops the anchor, which moves on every open', () => {
    const sw = load(async () => response(200));
    const first = sw.cacheKeyFor({
      url: 'https://agnte.test/v1/timeline?anchor=2026-09-16T10%3A00%3A00Z&direction=past&limit=20',
    });
    const second = sw.cacheKeyFor({
      url: 'https://agnte.test/v1/timeline?anchor=2026-09-16T18%3A30%3A00Z&direction=past&limit=20',
    });

    expect(first).toBe(second);
  });

  it('keeps everything that actually separates one page from another', () => {
    const sw = load(async () => response(200));
    const past = sw.cacheKeyFor({
      url: 'https://agnte.test/v1/timeline?anchor=A&direction=past',
    });
    const future = sw.cacheKeyFor({
      url: 'https://agnte.test/v1/timeline?anchor=A&direction=future',
    });
    const page2 = sw.cacheKeyFor({
      url: 'https://agnte.test/v1/timeline?anchor=A&direction=past&cursor=abc',
    });

    expect(new Set([past, future, page2]).size).toBe(3);
  });

  it('leaves other urls exactly as they are', () => {
    const sw = load(async () => response(200));
    const url = 'https://agnte.test/_next/static/chunks/a.js';
    expect(sw.cacheKeyFor({ url })).toBe(url);
  });
});

describe('networkFirst', () => {
  it('answers from the network and keeps a copy', async () => {
    const sw = load(async () => response(200, 'fresh'));
    const answer = await sw.networkFirst({ url: 'u' }, 'c', 'k');

    expect(answer.body).toBe('fresh');
    expect(sw.store.get('c')?.get('k')).toMatchObject({ body: 'fresh' });
  });

  it('falls back to the last copy when the network is gone', async () => {
    let online = true;
    const sw = load(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return response(200, 'fresh');
    });

    await sw.networkFirst({ url: 'u' }, 'c', 'k');
    online = false;
    expect((await sw.networkFirst({ url: 'u' }, 'c', 'k')).body).toBe('fresh');
  });

  /**
   * The failure worth naming. A cached 401 would be served for as long as the
   * entry lived, so an expired token would keep signing the person out with no
   * network involved — and no amount of reconnecting would fix it.
   */
  it('never stores a response that was not ok', async () => {
    const sw = load(async () => response(401, 'no'));
    await sw.networkFirst({ url: 'u' }, 'c', 'k');
    expect(sw.store.get('c')?.get('k')).toBeUndefined();
  });

  it('throws when there is neither a network nor a copy', async () => {
    const sw = load(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(sw.networkFirst({ url: 'u' }, 'c', 'k')).rejects.toThrow();
  });
});

describe('purge', () => {
  /**
   * Signing out has to take the caches with it: they hold pages of a timeline
   * in plaintext on disk, keyed only by URL.
   */
  it('deletes every cache when the app asks', async () => {
    const sw = load(async () => response(200));
    await sw.networkFirst({ url: 'u' }, 'agnte-data-v1', 'k');
    expect(sw.store.size).toBeGreaterThan(0);

    const waits: Promise<unknown>[] = [];
    sw.listeners.get('message')?.({
      data: 'agnte:purge',
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);

    expect(sw.store.size).toBe(0);
  });

  it('ignores a message that is not the purge', async () => {
    const sw = load(async () => response(200));
    await sw.networkFirst({ url: 'u' }, 'agnte-data-v1', 'k');

    const waits: Promise<unknown>[] = [];
    sw.listeners.get('message')?.({
      data: 'something-else',
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    });
    await Promise.all(waits);

    expect(sw.store.size).toBe(1);
  });
});
