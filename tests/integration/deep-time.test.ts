import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { PrismaDeepTimeRepository } from '@/modules/insights/infrastructure/prisma-deep-time-repository';
import { decodeCursor, encodeCursor } from '@/modules/insights/domain/cursor';

/**
 * The catalogue is seeded by migration, not by these tests.
 *
 * That is the point of it being reference data: every environment has the same
 * thirty-two events, so a test can assert on real content rather than on
 * fixtures it planted a line earlier. It also means these tests fail if a
 * later migration corrupts the seed, which is the failure most worth catching.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const events = new PrismaDeepTimeRepository();

// Just past the newest entry (the Moon landing, -31), so "everything".
const NOW = 0;

describe.skipIf(!DATABASE_URL)('the deep-time catalogue', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'local';
    resetConfigForTests();
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  it('is seeded, and runs from the Big Bang to living memory', async () => {
    const page = await events.before(NOW, 50, null);

    expect(page.events.length).toBeGreaterThanOrEqual(30);
    expect(page.events.at(0)?.slug).toBe('moon-landing');
    expect(page.events.at(-1)?.slug).toBe('big-bang');
    expect(page.events.at(-1)?.timelineYears).toBe(-13_800_000_000);
  });

  it('walks backwards, nearest first', async () => {
    const page = await events.before(NOW, 5, null);

    const years = page.events.map((e) => e.timelineYears);
    expect(years).toEqual([...years].sort((a, b) => b - a));
    // Newest first means the least negative first.
    expect(years[0]).toBeGreaterThan(years[years.length - 1]!);
  });

  it('pages without repeating or skipping across a shared year', async () => {
    /*
     * The first stars and the Milky Way are both -13.6e9. A cursor on position
     * alone would either show one twice or lose one entirely at a page
     * boundary that lands between them — which is the whole reason the cursor
     * carries an id.
     */
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page++) {
      const result = await events.before(NOW, 3, cursor);
      seen.push(...result.events.map((e) => e.slug));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(new Set(seen).size).toBe(seen.length);

    const everything = await events.before(NOW, 50, null);
    expect(seen.sort()).toEqual(everything.events.map((e) => e.slug).sort());
  });

  it('ends at the Big Bang rather than paging forever', async () => {
    const page = await events.before(NOW, 50, null);
    expect(page.nextCursor).toBe(null);
  });

  it('returns nothing before the beginning', async () => {
    const page = await events.before(-14_000_000_000, 10, null);
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBe(null);
  });

  it('cuts at the position asked for', async () => {
    // Just after the asteroid, so it and everything older is excluded.
    const page = await events.before(-66_000_001, 3, null);

    expect(page.events.map((e) => e.slug)).not.toContain('chicxulub');
    expect(page.events.every((e) => e.timelineYears < -66_000_001)).toBe(true);
  });

  it('starts the page over rather than throwing on a corrupt cursor', async () => {
    // A caller mid-scroll is better served by a repeated page than a crash;
    // the route validates separately and can answer 400 before reaching here.
    const page = await events.before(NOW, 3, 'not-a-cursor');
    expect(page.events).toHaveLength(3);
  });
});

describe('the catalogue cursor', () => {
  it('round-trips a position and an id', () => {
    const encoded = encodeCursor({ years: -13_600_000_000, id: 'abc' });
    const decoded = decodeCursor(encoded);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.years).toBe(-13_600_000_000);
      expect(decoded.value.id).toBe('abc');
    }
  });

  it('refuses something that is not one', () => {
    expect(decodeCursor('').ok).toBe(false);
    expect(decodeCursor(encodeCursor({ years: NaN, id: 'x' })).ok).toBe(false);
  });
});
