import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mutableClock } from '@/shared/kernel/clock';
import { getDatabase } from '@/shared/infra/database';
import {
  RATE_LIMITS,
  bucketFor,
  consume,
  pruneRateLimits,
} from '@/shared/infra/rate-limit';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('rate limiting against real Postgres', () => {
  beforeEach(async () => {
    await getDatabase()!.$executeRaw`TRUNCATE platform.rate_limit_window`;
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const at = (iso: string) => mutableClock(new Date(iso));

  it('allows up to the limit and refuses the next', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    const limit = RATE_LIMITS['auth.login'].limit;

    for (let i = 1; i <= limit; i += 1) {
      const decision = await consume('auth.login', { ip: '1.2.3.4' }, clock);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(limit - i);
    }

    const refused = await consume('auth.login', { ip: '1.2.3.4' }, clock);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it('counts different subjects separately', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 5; i += 1) await consume('auth.login', { ip: '1.1.1.1' }, clock);

    const other = await consume('auth.login', { ip: '2.2.2.2' }, clock);
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(4);
  });

  it('resets when the window rolls over', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 6; i += 1) await consume('auth.login', { ip: '1.2.3.4' }, clock);
    expect((await consume('auth.login', { ip: '1.2.3.4' }, clock)).allowed).toBe(false);

    clock.advance(RATE_LIMITS['auth.login'].windowMs);
    const afterReset = await consume('auth.login', { ip: '1.2.3.4' }, clock);
    expect(afterReset.allowed).toBe(true);
  });

  it('keeps counting while blocked, so hammering does not earn a fresh allowance', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 20; i += 1) await consume('auth.login', { ip: '1.2.3.4' }, clock);

    // Most of the window has passed, but not all of it.
    clock.advance(RATE_LIMITS['auth.login'].windowMs - 1000);
    expect((await consume('auth.login', { ip: '1.2.3.4' }, clock)).allowed).toBe(false);
  });

  /**
   * The reason the counter is maintained in one statement. Twenty concurrent
   * attempts against a limit of five must yield exactly five allowances — a
   * read-then-write would let several of them read the same count.
   */
  it('is atomic under concurrency', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => consume('auth.login', { ip: '9.9.9.9' }, clock)),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(
      RATE_LIMITS['auth.login'].limit,
    );
  });

  it('reports when the window resets', async () => {
    const clock = at('2026-01-01T00:07:30.000Z');
    const decision = await consume('auth.login', { ip: '1.2.3.4' }, clock);
    // 15-minute windows are floored, so this one started at 00:00.
    expect(decision.resetAt.toISOString()).toBe('2026-01-01T00:15:00.000Z');
    expect(decision.retryAfterSeconds).toBe(450);
  });

  it('prunes windows that can no longer be current', async () => {
    const clock = at('2026-01-01T00:00:00.000Z');
    await consume('auth.login', { ip: '1.2.3.4' }, clock);

    clock.advance(RATE_LIMITS['privacy.export'].windowMs + 60_000);
    expect(await pruneRateLimits(clock)).toBeGreaterThan(0);

    const rows = await getDatabase()!.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM platform.rate_limit_window`;
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('bucketFor', () => {
  it('is stable regardless of the order parts are given', () => {
    expect(bucketFor('auth.login', { ip: '1.1.1.1', email: 'a@b.c' })).toBe(
      bucketFor('auth.login', { email: 'a@b.c', ip: '1.1.1.1' }),
    );
  });

  it('distinguishes different subjects', () => {
    expect(bucketFor('auth.login', { ip: '1.1.1.1' })).not.toBe(
      bucketFor('auth.login', { ip: '2.2.2.2' }),
    );
  });

  it('ignores empty parts rather than creating a distinct bucket for them', () => {
    expect(bucketFor('auth.login', { ip: '1.1.1.1', email: '' })).toBe(
      bucketFor('auth.login', { ip: '1.1.1.1' }),
    );
  });
});

describe('the §8.6 table', () => {
  it.each([
    ['auth.login', 5, 15 * 60_000],
    ['auth.register', 3, 60 * 60_000],
    ['auth.forgot-password', 3, 60 * 60_000],
    ['media.upload-url', 100, 60 * 60_000],
    ['privacy.export', 1, 24 * 60 * 60_000],
    ['authenticated', 1000, 60 * 60_000],
  ] as const)('%s is %i per %i ms', (name, limit, windowMs) => {
    expect(RATE_LIMITS[name]).toEqual({ limit, windowMs });
  });
});
