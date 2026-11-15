import { describe, expect, it } from 'vitest';
import { en, es, fr, parseComposer, zh, type Strings } from '@agnte/core';

/**
 * The composer's grammar (§12.3).
 *
 * The first three cases are the examples the feature was asked for with, word
 * for word. The rest are the traps: colons that are not keys, dates that can
 * be read two ways, and the rule that nothing typed is ever dropped.
 */
process.env.TZ = 'UTC';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const parse = (text: string, strings: Strings = en) =>
  parseComposer(text, { strings, now: NOW });

describe('the examples it was asked for with', () => {
  it('reads a trip', () => {
    expect(
      parse(
        'Trip to Recife from: 5 January 2027 to: 24/02/27 where:Recife Airport rating:5 .travel',
      ),
    ).toEqual({
      xp: 'Trip to Recife',
      tags: ['travel'],
      properties: {},
      eventStart: '2027-01-05T00:00:00.000Z',
      eventEnd: '2027-02-24T00:00:00.000Z',
      eventPrecision: 'date',
      location: 'Recife Airport',
      rating: 5,
      visibility: null,
      unread: [],
    });
  });

  it('reads free properties', () => {
    expect(parse('seat: 4A airplane:A720').properties).toEqual({
      seat: '4A',
      airplane: 'A720',
    });
  });

  it('reads a meal, accents and all', () => {
    const meal = parse(
      'entrée: croquetas of meat plat: rice with setas dessert: ice cream with brownie rating:5',
    );
    expect(meal.properties).toEqual({
      entrée: 'croquetas of meat',
      plat: 'rice with setas',
      dessert: 'ice cream with brownie',
    });
    expect(meal.rating).toBe(5);
    expect(meal.xp).toBe(null);
  });
});

describe('what is and is not a key', () => {
  it('leaves a time alone', () => {
    expect(parse('Lunch at 10:30 with Marta')).toMatchObject({
      xp: 'Lunch at 10:30 with Marta',
      properties: {},
    });
  });

  it('leaves a link alone', () => {
    const link = parse('Read https://example.com/a:b later .reading');
    expect(link.xp).toBe('Read https://example.com/a:b later');
    expect(link.properties).toEqual({});
    expect(link.tags).toEqual(['reading']);
  });

  it('keeps a link inside a value', () => {
    expect(parse('ticket: https://example.com/t/1').properties).toEqual({
      ticket: 'https://example.com/t/1',
    });
  });

  /**
   * The honest limit of a deterministic grammar: `Note: call mom` *is* a key
   * and a value by the rule, and there is no way to know it was meant as a
   * sentence. It becomes a property rather than vanishing, and the card shows
   * it — which is the reason the card exists.
   */
  it('takes a leading "Note:" as a property, visibly', () => {
    expect(parse('Note: call mom')).toMatchObject({
      xp: null,
      properties: { note: 'call mom' },
    });
  });

  it('ignores a key with nothing after it', () => {
    expect(parse('Dinner seat:').properties).toEqual({});
  });

  it('accepts a full-width colon, which is what a Chinese keyboard types', () => {
    expect(parse('座位：4A').properties).toEqual({ 座位: '4A' });
  });

  it('treats a composed and a combining accent as one key', () => {
    expect(Object.keys(parse('entrée: soup').properties)).toEqual(['entrée']);
  });
});

describe('tags', () => {
  it('takes them anywhere, once each, lowercased', () => {
    expect(parse('.Travel Trip .barcelona-trip seat: 4A .travel').tags).toEqual([
      'travel',
      'barcelona-trip',
    ]);
  });

  it('ends a value at a tag', () => {
    expect(parse('where: Recife .travel and more').location).toBe('Recife');
  });

  it('does not mistake a decimal for a tag', () => {
    expect(parse('Paid .5 of it').tags).toEqual([]);
  });
});

describe('dates', () => {
  it.each([
    ['2027-01-05', '2027-01-05'],
    ['5 January 2027', '2027-01-05'],
    ['January 5, 2027', '2027-01-05'],
    ['5 Jan 2027', '2027-01-05'],
    ['5th of January 2027', '2027-01-05'],
    ['24/02/27', '2027-02-24'],
    ['24.02.2027', '2027-02-24'],
    ['5 January', '2026-01-05'],
    ['today', '2026-11-15'],
    ['Tomorrow', '2026-11-16'],
    ['yesterday', '2026-11-14'],
  ])('reads "%s"', (typed, expected) => {
    expect(parse(`when: ${typed}`).eventStart).toBe(`${expected}T00:00:00.000Z`);
  });

  it('reads an ambiguous date day-first', () => {
    expect(parse('when: 05/01/27').eventStart).toBe('2027-01-05T00:00:00.000Z');
  });

  it('takes the only reading that is a real date, whatever the order', () => {
    // No month 24: this can only be February the 24th.
    expect(parse('when: 02/24/27').eventStart).toBe('2027-02-24T00:00:00.000Z');
  });

  it('makes a moment of a date with a time', () => {
    expect(parse('when: 5 January 2027 17:30')).toMatchObject({
      eventStart: '2027-01-05T17:30:00.000Z',
      eventPrecision: 'minute',
    });
  });

  it('keeps a range to one precision, decided by both ends', () => {
    // A time on one end only: three days, not a day and a moment.
    expect(parse('from: 5 January 2027 to: 7 January 2027 18:00')).toMatchObject({
      eventStart: '2027-01-05T00:00:00.000Z',
      eventEnd: '2027-01-07T00:00:00.000Z',
      eventPrecision: 'date',
    });
    expect(parse('from: 5/1/27 09:00 to: 5/1/27 18:00')).toMatchObject({
      eventStart: '2027-01-05T09:00:00.000Z',
      eventEnd: '2027-01-05T18:00:00.000Z',
      eventPrecision: 'minute',
    });
  });

  it('puts an end typed without a year after its start', () => {
    expect(parse('from: 20 December 2027 to: 5 January').eventEnd).toBe(
      '2028-01-05T00:00:00.000Z',
    );
    expect(parse('from: 5 January 2027 to: 9 January').eventEnd).toBe(
      '2027-01-09T00:00:00.000Z',
    );
    // A year that was typed is never moved, even when it makes no sense.
    expect(parse('from: 5 January 2027 to: 1 January 2026').eventEnd).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    // "today" as an end is today.
    expect(parse('from: 20 December 2027 to: today').eventEnd).toBe(
      '2026-11-15T00:00:00.000Z',
    );
  });

  it('treats an end with no start as the date', () => {
    expect(parse('to: 5 January 2027')).toMatchObject({
      eventStart: '2027-01-05T00:00:00.000Z',
      eventEnd: null,
    });
  });

  it('does not roll an impossible date into the next month', () => {
    const impossible = parse('when: 31/02/27');
    expect(impossible.eventStart).toBe(null);
    expect(impossible.unread).toEqual([{ key: 'when', value: '31/02/27' }]);
  });
});

describe('nothing typed is dropped', () => {
  it('keeps an unread field as a property and says so', () => {
    const odd = parse('Dinner rating: lots from: sometime soon');
    expect(odd.rating).toBe(null);
    expect(odd.eventStart).toBe(null);
    expect(odd.properties).toEqual({ rating: 'lots', from: 'sometime soon' });
    expect(odd.unread).toEqual([
      { key: 'rating', value: 'lots' },
      { key: 'from', value: 'sometime soon' },
    ]);
  });

  it.each([
    ['5', 5],
    ['7.5', 7.5],
    ['7,5', 7.5],
    ['8/10', 8],
    ['0', 0],
    ['10', 10],
  ])('reads rating "%s"', (typed, expected) => {
    expect(parse(`rating: ${typed}`).rating).toBe(expected);
  });

  it('refuses a rating outside 0 to 10', () => {
    expect(parse('rating: 11').rating).toBe(null);
    expect(parse('rating: 11').unread).toHaveLength(1);
  });
});

/**
 * Visibility fails closed (CLAUDE.md). A word that is not exactly one of the
 * three leaves it unset — which the server resolves restrictively — and is
 * never matched to the nearest one.
 */
describe('visibility', () => {
  it('reads the three words', () => {
    expect(parse('visibility: public').visibility).toBe('public');
    expect(parse('visibility: Private').visibility).toBe('private');
    expect(parse('visibilidad: compartido', es).visibility).toBe('shared');
  });

  it.each(['publik', 'pub', 'public!', 'everyone', 'not private', 'public private'])(
    'never guesses from "%s"',
    (typed) => {
      const result = parse(`visibility: ${typed}`);
      expect(result.visibility).toBe(null);
      expect(result.unread).toEqual([{ key: 'visibility', value: typed }]);
    },
  );

  it('is unset when nothing was said', () => {
    expect(parse('Dinner .restaurant').visibility).toBe(null);
  });
});

describe('in other languages', () => {
  it('reads Spanish keys and dates', () => {
    expect(
      parse(
        'Viaje a Recife desde: 5 de enero de 2027 hasta: 24/02/27 donde: Recife nota: 8',
        es,
      ),
    ).toMatchObject({
      xp: 'Viaje a Recife',
      eventStart: '2027-01-05T00:00:00.000Z',
      eventEnd: '2027-02-24T00:00:00.000Z',
      location: 'Recife',
      rating: 8,
      properties: {},
    });
  });

  it('reads French keys and dates', () => {
    expect(parse('Dîner du: 1er mars 2027 où: Lyon note: 7,5', fr)).toMatchObject({
      xp: 'Dîner',
      eventStart: '2027-03-01T00:00:00.000Z',
      location: 'Lyon',
      rating: 7.5,
    });
  });

  it('reads Chinese keys and dates', () => {
    expect(
      parse('去累西腓 从：2027年1月5日 到：2月24日 地点：机场 评分：9', zh),
    ).toMatchObject({
      xp: '去累西腓',
      eventStart: '2027-01-05T00:00:00.000Z',
      // No year on the end: it follows its start rather than preceding it.
      eventEnd: '2027-02-24T00:00:00.000Z',
      location: '机场',
      rating: 9,
    });
  });

  it('keeps English keys working everywhere', () => {
    expect(parse('Cena rating: 6 when: tomorrow', es)).toMatchObject({
      rating: 6,
      eventStart: '2026-11-16T00:00:00.000Z',
    });
  });

  it('reads the same word differently under a different language', () => {
    // `nota` is the rating in Spanish and an ordinary property in English —
    // the reason the literal text is stored and never re-parsed (§12.3).
    expect(parse('nota: 8', es).rating).toBe(8);
    expect(parse('nota: 8', en)).toMatchObject({
      rating: null,
      properties: { nota: '8' },
    });
  });

  it('does not let one language reserve the same word for two fields', () => {
    for (const table of [en, es, fr, zh]) {
      const words = Object.values(table.composer.keys).flat();
      expect(new Set(words).size).toBe(words.length);
    }
  });
});
