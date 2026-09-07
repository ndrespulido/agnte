import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mutableClock } from '@/shared/kernel/clock';
import { getDatabase } from '@/shared/infra/database';
import {
  claim,
  complete,
  fingerprint,
  pruneIdempotencyKeys,
  release,
  scopeFor,
} from '@/shared/infra/idempotency';

const DATABASE_URL = process.env.DATABASE_URL;
const FP = fingerprint('POST', '/v1/auth/register', { email: 'a@b.c' });

describe.skipIf(!DATABASE_URL)('idempotency against real Postgres', () => {
  beforeEach(async () => {
    await getDatabase()!.$executeRaw`TRUNCATE platform.idempotency_key`;
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const at = (iso: string) => mutableClock(new Date(iso));

  it('lets the first request through', async () => {
    expect(await claim('user:1', 'k', FP)).toEqual({ kind: 'proceed' });
  });

  it('replays a completed response instead of doing the work twice', async () => {
    await claim('user:1', 'k', FP);
    await complete('user:1', 'k', 201, { id: 'abc' });

    expect(await claim('user:1', 'k', FP)).toEqual({
      kind: 'replay',
      status: 201,
      body: { id: 'abc' },
    });
  });

  it('reports in-progress while the first attempt is still running', async () => {
    await claim('user:1', 'k', FP);
    expect(await claim('user:1', 'k', FP)).toEqual({ kind: 'in-progress' });
  });

  /**
   * The case that makes this more than a cache. Answering a different request
   * with the first request's response would silently return the wrong result.
   */
  it('refuses the same key carrying a different request', async () => {
    await claim('user:1', 'k', FP);
    await complete('user:1', 'k', 201, { id: 'abc' });

    const different = fingerprint('POST', '/v1/auth/register', {
      email: 'someone@else.com',
    });
    expect(await claim('user:1', 'k', different)).toEqual({ kind: 'mismatch' });
  });

  it('scopes keys per caller, so one client cannot replay another', async () => {
    await claim('user:1', 'shared-key', FP);
    await complete('user:1', 'shared-key', 201, { id: 'first' });

    expect(await claim('user:2', 'shared-key', FP)).toEqual({ kind: 'proceed' });
  });

  it('releases a failed claim so the client is not locked out for 24 hours', async () => {
    await claim('user:1', 'k', FP);
    await release('user:1', 'k');
    expect(await claim('user:1', 'k', FP)).toEqual({ kind: 'proceed' });
  });

  it('does not release a completed claim', async () => {
    await claim('user:1', 'k', FP);
    await complete('user:1', 'k', 200, { ok: true });
    await release('user:1', 'k');
    expect(await claim('user:1', 'k', FP)).toMatchObject({ kind: 'replay' });
  });

  it('reclaims a key after it expires', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    await claim('user:1', 'k', FP, clock);
    await complete('user:1', 'k', 201, { id: 'old' }, clock);

    clock.advance(25 * 60 * 60 * 1000);
    expect(await claim('user:1', 'k', FP, clock)).toEqual({ kind: 'proceed' });
  });

  it('still replays just before expiry', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    await claim('user:1', 'k', FP, clock);
    await complete('user:1', 'k', 201, { id: 'old' }, clock);

    clock.advance(23 * 60 * 60 * 1000);
    expect(await claim('user:1', 'k', FP, clock)).toMatchObject({ kind: 'replay' });
  });

  /**
   * The failure this exists to prevent. Two concurrent attempts with the same
   * key must not both be told to proceed, or the write happens twice.
   */
  it('lets exactly one of many concurrent attempts proceed', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => claim('user:1', 'race', FP)),
    );
    expect(outcomes.filter((o) => o.kind === 'proceed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'in-progress')).toHaveLength(11);
  });

  it('replays a null body without turning it into an error', async () => {
    await claim('user:1', 'k', FP);
    await complete('user:1', 'k', 204, null);
    expect(await claim('user:1', 'k', FP)).toEqual({
      kind: 'replay',
      status: 204,
      body: null,
    });
  });

  it('prunes expired keys', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    await claim('user:1', 'k', FP, clock);
    await complete('user:1', 'k', 200, {}, clock);

    clock.advance(25 * 60 * 60 * 1000);
    expect(await pruneIdempotencyKeys(clock)).toBe(1);
  });
});

describe('fingerprint', () => {
  it('is stable for the same request', () => {
    expect(fingerprint('POST', '/v1/x', { a: 1 })).toBe(
      fingerprint('POST', '/v1/x', { a: 1 }),
    );
  });

  it('is case-insensitive on the method', () => {
    expect(fingerprint('post', '/v1/x', null)).toBe(fingerprint('POST', '/v1/x', null));
  });

  it.each([
    ['a different body', 'POST', '/v1/x', { a: 2 }],
    ['a different path', 'POST', '/v1/y', { a: 1 }],
    ['a different method', 'PUT', '/v1/x', { a: 1 }],
  ])('differs for %s', (_label, method, path, body) => {
    expect(fingerprint(method, path, body)).not.toBe(
      fingerprint('POST', '/v1/x', { a: 1 }),
    );
  });

  it('treats a missing body and an explicit null the same', () => {
    expect(fingerprint('POST', '/v1/x', undefined)).toBe(
      fingerprint('POST', '/v1/x', null),
    );
  });
});

describe('scopeFor', () => {
  it('scopes to the user when there is one', () => {
    expect(scopeFor('u1', '1.2.3.4')).toBe('user:u1');
  });

  it('falls back to the address for an anonymous caller', () => {
    expect(scopeFor(undefined, '1.2.3.4')).toBe('anon:1.2.3.4');
  });

  it('cannot be confused between a user and an address', () => {
    expect(scopeFor('1.2.3.4', 'x')).not.toBe(scopeFor(undefined, '1.2.3.4'));
  });
});
