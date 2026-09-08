import { describe, expect, it } from 'vitest';
import {
  MAX_LOCATION_LENGTH,
  MAX_PROPERTIES,
  MAX_PROPERTY_VALUE_LENGTH,
  MAX_RATING,
  MAX_XP_LENGTH,
  MIN_RATING,
  parseLocation,
  parsePlacement,
  parseProperties,
  parseRating,
  placementOf,
} from '@/modules/verse';
import { applyChanges, createVerse } from '@/modules/verse/domain/verse';
import { VerseErrorCode } from '@/modules/verse';
import { fixedClock, unwrap } from '@/shared/kernel';

const AT = new Date('2026-01-01T00:00:00.000Z');

const base = (overrides: Record<string, unknown> = {}) =>
  unwrap(
    createVerse({
      ownerId: 'u1',
      tagIds: ['t1'],
      clock: fixedClock(AT),
      ...overrides,
    }),
  );

describe('createVerse', () => {
  it('accepts a minimal verse: one tag and nothing else', () => {
    // CLAUDE.md calls this a design rule, not an edge case. If this test ever
    // needs more fields to pass, a required field crept in.
    const verse = base();

    expect(verse.tagIds).toEqual(['t1']);
    expect(verse.xp).toBe(null);
    expect(verse.rating).toBe(null);
    expect(verse.location).toBe(null);
    expect(verse.eventStart).toBe(null);
    expect(verse.deepTimeYears).toBe(null);
    expect(verse.properties).toEqual({});
    expect(verse.mediaIds).toEqual([]);
  });

  it('refuses a verse with no tags', () => {
    const result = createVerse({ ownerId: 'u1', tagIds: [], clock: fixedClock(AT) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe(VerseErrorCode.NoTags);
  });

  it("leaves visibility null so it inherits, rather than freezing today's answer", () => {
    // Resolving at write time would leave a verse public after its tag was made
    // private — the row would carry a decision the tag has since revised.
    expect(base().visibility).toBe(null);
  });

  it('starts at version 0 with equal timestamps', () => {
    const verse = base();
    expect(verse.version).toBe(0);
    expect(verse.createdAt).toEqual(verse.updatedAt);
  });

  it('honours a client-generated id', () => {
    // Offline-created rows arrive with their final id (architecture.md §2).
    const verse = base({ id: '0195e2c0-0000-7000-8000-000000000001' });
    expect(verse.id).toBe('0195e2c0-0000-7000-8000-000000000001');
  });

  it('deduplicates tags while keeping the order they were added in', () => {
    const verse = base({ tagIds: ['b', 'a', 'b', 'c'] });
    expect(verse.tagIds).toEqual(['b', 'a', 'c']);
  });

  it('freezes properties so a caller cannot mutate a verse it read', () => {
    const verse = base({ properties: { airline: 'IB' } });
    expect(() => {
      (verse.properties as Record<string, string>).airline = 'BA';
    }).toThrow();
  });
});

describe('parsePlacement', () => {
  const start = new Date('2026-03-01T10:00:00Z');
  const end = new Date('2026-03-05T10:00:00Z');

  it('is "none" when nothing is given', () => {
    expect(unwrap(parsePlacement({}))).toEqual({ kind: 'none' });
  });

  it('is a moment with only a start', () => {
    expect(unwrap(parsePlacement({ eventStart: start }))).toEqual({
      kind: 'moment',
      at: start,
    });
  });

  it('is a range with both', () => {
    expect(unwrap(parsePlacement({ eventStart: start, eventEnd: end }))).toEqual({
      kind: 'range',
      start,
      end,
    });
  });

  it('accepts a zero-length range', () => {
    expect(parsePlacement({ eventStart: start, eventEnd: start }).ok).toBe(true);
  });

  it('refuses an end before its start', () => {
    const result = parsePlacement({ eventStart: end, eventEnd: start });
    expect(!result.ok && result.error.code).toBe(VerseErrorCode.EventRangeInverted);
  });

  it('refuses an end with no start rather than silently making it a moment', () => {
    // Treating it as a moment would move the date the user typed into a field
    // they never filled in.
    const result = parsePlacement({ eventEnd: end });
    expect(result.ok).toBe(false);
  });

  it('refuses deep time alongside a calendar date', () => {
    const result = parsePlacement({ eventStart: start, deepTimeYears: -66e6 });
    expect(!result.ok && result.error.code).toBe(VerseErrorCode.TimeConflict);
  });

  it('refuses deep time alongside an end date alone', () => {
    // The mutual exclusion has to cover eventEnd too, not just eventStart.
    const result = parsePlacement({ eventEnd: end, deepTimeYears: -66e6 });
    expect(!result.ok && result.error.code).toBe(VerseErrorCode.TimeConflict);
  });

  it('accepts deep time on its own', () => {
    expect(unwrap(parsePlacement({ deepTimeYears: -66e6 }))).toEqual({
      kind: 'deep-time',
      years: -66e6,
    });
  });

  it('accepts an event freely in the future', () => {
    const flight = new Date('2031-07-01T06:00:00Z');
    expect(parsePlacement({ eventStart: flight }).ok).toBe(true);
  });
});

describe('placementOf', () => {
  it('round-trips every placement kind', () => {
    const at = new Date('2026-03-01T10:00:00Z');
    const end = new Date('2026-03-02T10:00:00Z');

    expect(placementOf(base())).toEqual({ kind: 'none' });
    expect(placementOf(base({ placement: { kind: 'moment', at } }))).toEqual({
      kind: 'moment',
      at,
    });
    expect(placementOf(base({ placement: { kind: 'range', start: at, end } }))).toEqual({
      kind: 'range',
      start: at,
      end,
    });
    expect(
      placementOf(base({ placement: { kind: 'deep-time', years: -13.8e9 } })),
    ).toEqual({
      kind: 'deep-time',
      years: -13.8e9,
    });
  });
});

describe('parseRating', () => {
  it('accepts both ends of the scale', () => {
    expect(parseRating(MIN_RATING).ok).toBe(true);
    expect(parseRating(MAX_RATING).ok).toBe(true);
  });

  it('accepts a fractional rating', () => {
    expect(parseRating(7.5).ok).toBe(true);
  });

  it.each([-1, 11, Number.NaN, Number.POSITIVE_INFINITY])('refuses %p', (value) => {
    expect(parseRating(value).ok).toBe(false);
  });
});

describe('parseXp', () => {
  it('counts code points, not UTF-16 units', async () => {
    const { parseXp } = await import('@/modules/verse/domain/verse');
    // Each of these is two UTF-16 units. Counting units would reject a note at
    // half the characters the user can actually see.
    const emoji = '🎬'.repeat(MAX_XP_LENGTH);
    expect(parseXp(emoji).ok).toBe(true);
    expect(parseXp(emoji + '🎬').ok).toBe(false);
  });
});

describe('parseLocation', () => {
  it('trims', () => {
    expect(unwrap(parseLocation('  Barcelona  '))).toBe('Barcelona');
  });

  it('refuses an empty or whitespace-only location', () => {
    expect(parseLocation('').ok).toBe(false);
    expect(parseLocation('   ').ok).toBe(false);
  });

  it('refuses one past the cap', () => {
    expect(parseLocation('a'.repeat(MAX_LOCATION_LENGTH + 1)).ok).toBe(false);
  });
});

describe('parseProperties', () => {
  it('normalises keys the way tag names are normalised', () => {
    expect(unwrap(parseProperties({ 'Flight Number': 'IB6250' }))).toEqual({
      'flight-number': 'IB6250',
    });
  });

  it('keeps values verbatim', () => {
    // The value is the user's data. Trimming or casing it would lose meaning
    // they put there deliberately.
    expect(unwrap(parseProperties({ seat: '  12A  ' }))).toEqual({ seat: '  12A  ' });
  });

  it('stringifies numbers and booleans rather than refusing them', () => {
    expect(unwrap(parseProperties({ year: 1998, seen: true }))).toEqual({
      year: '1998',
      seen: 'true',
    });
  });

  it('drops null and undefined instead of storing "null"', () => {
    expect(unwrap(parseProperties({ seat: null, row: undefined }))).toEqual({});
  });

  it('refuses objects and arrays', () => {
    // JSON-encoding one would put a blob of braces into the search index.
    expect(parseProperties({ legs: [1, 2] }).ok).toBe(false);
    expect(parseProperties({ crew: { pilot: 'x' } }).ok).toBe(false);
  });

  it.each(['', '   ', 'has space!', '-leading', 'emoji🎬'])(
    'refuses the key %j',
    (key) => {
      expect(parseProperties({ [key]: 'v' }).ok).toBe(false);
    },
  );

  it('refuses more than the cap', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_PROPERTIES + 1 }, (_, i) => [`k${i}`, 'v']),
    );
    expect(parseProperties(many).ok).toBe(false);
  });

  it('refuses a value past the cap', () => {
    expect(parseProperties({ note: 'a'.repeat(MAX_PROPERTY_VALUE_LENGTH + 1) }).ok).toBe(
      false,
    );
  });
});

describe('applyChanges', () => {
  it('bumps the version and moves updatedAt, leaving createdAt alone', () => {
    const verse = base();
    const clock = fixedClock(new Date('2026-02-01T00:00:00Z'));
    const changed = unwrap(applyChanges(verse, { xp: 'good' }, clock));

    expect(changed.version).toBe(verse.version + 1);
    expect(changed.createdAt).toEqual(verse.createdAt);
    expect(changed.updatedAt.getTime()).toBeGreaterThan(verse.updatedAt.getTime());
  });

  it('does not mutate the verse it was given', () => {
    const verse = base({ xp: 'before' });
    unwrap(applyChanges(verse, { xp: 'after' }, fixedClock(AT)));
    expect(verse.xp).toBe('before');
  });

  it('distinguishes "leave alone" from "clear"', () => {
    const verse = base({ rating: 8, xp: 'note' });

    const untouched = unwrap(applyChanges(verse, { xp: 'other' }, fixedClock(AT)));
    expect(untouched.rating).toBe(8);

    const cleared = unwrap(applyChanges(verse, { rating: null }, fixedClock(AT)));
    expect(cleared.rating).toBe(null);
  });

  it('refuses to leave a verse with no tags', () => {
    const result = applyChanges(base(), { tagIds: [] }, fixedClock(AT));
    expect(!result.ok && result.error.code).toBe(VerseErrorCode.NoTags);
  });

  it('swaps a calendar placement for deep time cleanly', () => {
    const verse = base({
      placement: { kind: 'moment', at: new Date('2026-03-01T00:00:00Z') },
    });
    const changed = unwrap(
      applyChanges(
        verse,
        { placement: { kind: 'deep-time', years: -66e6 } },
        fixedClock(AT),
      ),
    );

    // The old fields must be cleared, not merely shadowed: a row carrying both
    // would violate the exclusion the moment anything read it directly.
    expect(changed.eventStart).toBe(null);
    expect(changed.eventEnd).toBe(null);
    expect(changed.deepTimeYears).toBe(-66e6);
  });
});
