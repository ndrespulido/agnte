import { describe, expect, it } from 'vitest';
import {
  deepTimeLabel,
  fromDateAndTime,
  splitTagNames,
  headerLabel,
  placementOf,
  sectionKey,
  timeLabel,
  timelinePosition,
  toDateInput,
  toTimeInput,
} from '@agnte/core';
import { en, es, fr, zh } from '@agnte/core';

/*
 * Pinned, because a moment is now read in the reader's zone (§2.1) and these
 * cases state their expectations in UTC. What changes under another zone is
 * its own file: `event-precision-zones.test.ts`.
 */
process.env.TZ = 'UTC';

const NOW = new Date('2026-09-08T12:00:00.000Z');

const verse = (over: Partial<Parameters<typeof placementOf>[0]> = {}) =>
  placementOf({
    eventStart: null,
    deepTimeYears: null,
    createdAt: '2026-09-08T12:00:00.000Z',
    ...over,
  });

describe('placementOf', () => {
  it('prefers deep time, since the two are exclusive', () => {
    const p = verse({ eventStart: '2026-01-01T00:00:00.000Z', deepTimeYears: -66e6 });
    expect(p).toEqual({ kind: 'deep-time', years: -66e6 });
  });

  it('is undated when a verse has neither', () => {
    // The minimal verse — media, a tag, a location — still has to render.
    expect(verse().kind).toBe('undated');
  });
});

describe('headerLabel', () => {
  it('says Today, Tomorrow and Yesterday rather than making you count', () => {
    expect(headerLabel(verse({ eventStart: '2026-09-08T09:00:00Z' }), NOW, en)).toBe(
      'Today',
    );
    expect(headerLabel(verse({ eventStart: '2026-09-09T09:00:00Z' }), NOW, en)).toBe(
      'Tomorrow',
    );
    expect(headerLabel(verse({ eventStart: '2026-09-07T09:00:00Z' }), NOW, en)).toBe(
      'Yesterday',
    );
  });

  it('counts calendar days, not 24-hour blocks', () => {
    // 23:00 today and 01:00 tomorrow are two hours apart and two different
    // days. A duration-based check calls the second one "Today".
    const late = new Date('2026-09-08T23:00:00.000Z');
    expect(headerLabel(verse({ eventStart: '2026-09-09T01:00:00Z' }), late, en)).toBe(
      'Tomorrow',
    );
  });

  it('omits the year within this year and includes it outside', () => {
    expect(headerLabel(verse({ eventStart: '2026-03-01T00:00:00Z' }), NOW, en)).toBe(
      'Sunday 1 March',
    );
    expect(headerLabel(verse({ eventStart: '2024-03-01T00:00:00Z' }), NOW, en)).toBe(
      'Friday 1 March 2024',
    );
  });

  it('labels an undated verse plainly', () => {
    expect(headerLabel(verse(), NOW, en)).toBe('No date');
  });
});

describe('deepTimeLabel', () => {
  it.each([
    [-13.8e9, '13.8 billion years ago'],
    [-4.5e9, '4.5 billion years ago'],
    [-66e6, '66 million years ago'],
    [-300_000, '300 thousand years ago'],
    [-2_000, '2 thousand years ago'],
    [-57, '57 years ago'],
    [1e9, 'in 1 billion years'],
  ])('reads %p as %j', (years, expected) => {
    expect(deepTimeLabel(years, en)).toBe(expected);
  });

  it('drops a trailing .0 rather than implying precision', () => {
    // -13.8e9 is three significant figures of real knowledge. "13.0 billion"
    // would claim one more than anybody has.
    expect(deepTimeLabel(-1e9, en)).toBe('1 billion years ago');
    expect(deepTimeLabel(-1e6, en)).toBe('1 million years ago');
  });
});

/**
 * The formatters in a language that is not English.
 *
 * Not a translation spot-check — that is what the tables are for. These pin
 * the three places where localising a date is *rearranging* rather than
 * substituting, which is the part a `{day} {date} {month}` template would get
 * silently wrong in every language it was not written for.
 */
describe('dates outside English', () => {
  it('rearranges rather than translating word by word', () => {
    const march = verse({ eventStart: '2026-03-01T00:00:00Z' });

    // Spanish inserts a comma and "de", neither of which exists in English.
    expect(headerLabel(march, NOW, es)).toBe('domingo, 1 de marzo');
    // Chinese runs largest-unit-first and puts the weekday last.
    expect(headerLabel(march, NOW, zh)).toBe('3月1日 星期日');
  });

  it('keeps the relative days relative', () => {
    const today = verse({ eventStart: '2026-09-08T09:00:00Z' });
    expect(headerLabel(today, NOW, es)).toBe('Hoy');
    expect(headerLabel(today, NOW, zh)).toBe('今天');
  });

  /**
   * The one that cannot be done by substitution.
   *
   * Chinese groups large numbers in 万 (10^4) and 亿 (10^8), so 13.8 billion
   * years is 138亿年 — the *number* changes, not just the word after it. A
   * shared template would have printed "13.8 billion" in Chinese characters
   * and been wrong in a way nobody reading English would notice.
   */
  it('regroups large numbers the way the language counts them', () => {
    expect(deepTimeLabel(-13.8e9, zh)).toBe('138亿年前');
    expect(deepTimeLabel(-66e6, zh)).toBe('6600万年前');
    expect(deepTimeLabel(-300_000, zh)).toBe('30万年前');
    expect(deepTimeLabel(-2_000, zh)).toBe('2000年前');

    // Spanish: "billion" is a false friend — a billón is 10^12. The decimal
    // separator is a comma, which is the other thing a shared template would
    // have got wrong without anyone reading English noticing.
    expect(deepTimeLabel(-13.8e9, es)).toBe('hace 13,8 mil millones de años');
    expect(deepTimeLabel(66e6, es)).toBe('dentro de 66 millones de años');
    expect(deepTimeLabel(-1e6, es)).toBe('hace 1 millón de años');
  });

  /**
   * French agrees with Spanish on the comma and disagrees with English on
   * where the plural starts: "1 milliard" but "13,8 milliards". Both of these
   * were wrong on screen — "13.8 milliard d'années" is two mistakes in four
   * words — and neither was visible from the English table.
   */
  it('takes the plural from two in French, and a comma for the decimal', () => {
    expect(deepTimeLabel(-13.8e9, fr)).toBe("il y a 13,8 milliards d'années");
    expect(deepTimeLabel(-1e9, fr)).toBe("il y a 1 milliard d'années");
    expect(deepTimeLabel(-1e6, fr)).toBe("il y a 1 million d'années");
    expect(deepTimeLabel(-66e6, fr)).toBe("il y a 66 millions d'années");
  });
});

describe('sectionKey', () => {
  it('groups a day together', () => {
    const morning = verse({ eventStart: '2026-03-01T08:00:00Z' });
    const evening = verse({ eventStart: '2026-03-01T21:00:00Z' });
    expect(sectionKey(morning)).toBe(sectionKey(evening));
  });

  it('separates two days', () => {
    expect(sectionKey(verse({ eventStart: '2026-03-01T08:00:00Z' }))).not.toBe(
      sectionKey(verse({ eventStart: '2026-03-02T08:00:00Z' })),
    );
  });

  it('buckets deep time by magnitude, not by year', () => {
    // One section per year across 66 million years would be a scroll of empty
    // headings.
    const a = verse({ deepTimeYears: -66_000_000 });
    const b = verse({ deepTimeYears: -66_000_001 });
    expect(sectionKey(a)).toBe(sectionKey(b));

    const older = verse({ deepTimeYears: -13.8e9 });
    expect(sectionKey(older)).not.toBe(sectionKey(a));
  });
});

describe('timeLabel', () => {
  it('shows a time of day when there is one', () => {
    expect(timeLabel(verse({ eventStart: '2026-03-01T21:35:00Z' }))).toBe('21:35');
  });

  it('shows nothing for a day, which has no time to show', () => {
    expect(
      timeLabel(verse({ eventStart: '2026-03-01T00:00:00Z', eventPrecision: 'date' })),
    ).toBe(null);
  });

  /**
   * The case the old rule could not express. "Midnight means no time given"
   * was a guess made from the value; a new year's toast at 00:00 is a moment,
   * and now that the precision says so, it is shown as one.
   */
  it('shows midnight when midnight is what was meant', () => {
    expect(
      timeLabel(verse({ eventStart: '2027-01-01T00:00:00Z', eventPrecision: 'minute' })),
    ).toBe('00:00');
  });

  it('infers a day from midnight UTC when the precision is absent', () => {
    // A verse cached before the column existed. Inferring matches the
    // migration's backfill, so the cache and the server agree.
    expect(timeLabel(verse({ eventStart: '2026-03-01T00:00:00Z' }))).toBe(null);
    expect(
      timeLabel(verse({ eventStart: '2026-03-01T00:00:00Z', eventPrecision: null })),
    ).toBe(null);
  });

  it('has nothing to say about deep time', () => {
    expect(timeLabel(verse({ deepTimeYears: -66e6 }))).toBe(null);
  });
});

/**
 * The fields the edit sheet writes dates through: a date, and a time that may
 * be left empty.
 *
 * The round trip is the property that matters: what the sheet shows for a
 * stored verse must be what it sends back when nothing was typed — value *and*
 * precision. Zone behaviour is in `event-precision-zones.test.ts`.
 */
describe('the date and time fields', () => {
  it('reads an empty time as a day, stored at midnight UTC', () => {
    expect(fromDateAndTime('2026-03-01', '')).toEqual({
      iso: '2026-03-01T00:00:00.000Z',
      precision: 'date',
    });
  });

  it('reads a time as a moment', () => {
    expect(fromDateAndTime('2026-03-01', '14:30')).toEqual({
      iso: '2026-03-01T14:30:00.000Z',
      precision: 'minute',
    });
  });

  it('round-trips a day and a moment unchanged', () => {
    for (const [date, time] of [
      ['2026-03-01', ''],
      ['2026-03-01', '14:30'],
      // Midnight typed on purpose stays a moment, not a day.
      ['2026-03-01', '00:00'],
    ] as const) {
      const stored = fromDateAndTime(date, time)!;
      expect(toDateInput(stored.iso, stored.precision)).toBe(date);
      expect(toTimeInput(stored.iso, stored.precision)).toBe(time);
    }
  });

  it('treats empty as no date in both directions', () => {
    // Not the same as "leave it alone": the sheet sends this null explicitly
    // so that clearing a date actually clears it.
    expect(toDateInput(null, null)).toBe('');
    expect(toTimeInput(null, null)).toBe('');
    expect(fromDateAndTime('', '')).toBe(null);
    expect(fromDateAndTime('   ', '')).toBe(null);
  });

  it('will not put a time on a day that was not given', () => {
    // Inventing today would be a guess; the sheet refuses this with a message.
    expect(fromDateAndTime('', '14:30')).toBe(null);
  });

  it('answers empty rather than throwing on something unparseable', () => {
    expect(toDateInput('not a date', 'date')).toBe('');
    expect(toTimeInput('not a date', 'minute')).toBe('');
    expect(fromDateAndTime('not a date', '')).toBe(null);
    expect(fromDateAndTime('2026-02-31', '')).toBe(null);
    expect(fromDateAndTime('2026-03-01', 'noon')).toBe(null);
  });
});

describe('timelinePosition', () => {
  it('puts a day ahead of everything timed within it', () => {
    const day = timelinePosition({
      eventStart: '2026-03-01T00:00:00.000Z',
      eventPrecision: 'date',
      deepTimeYears: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const morning = timelinePosition({
      eventStart: '2026-03-01T00:01:00.000Z',
      eventPrecision: 'minute',
      deepTimeYears: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(day).toBeLessThan(morning);
  });
});

/**
 * The new-tag field takes several names at once. A comma is safe as the
 * separator because the verse domain's `parseTagName` rejects one inside a
 * name, so no tag can contain the character this splits on.
 */
describe('splitTagNames', () => {
  it('splits a comma-separated field and keeps what was typed', () => {
    expect(splitTagNames('.barcelona, .restaurant, .expenses')).toEqual([
      '.barcelona',
      '.restaurant',
      '.expenses',
    ]);
  });

  it('still handles the single-name case', () => {
    expect(splitTagNames('.movies')).toEqual(['.movies']);
  });

  it('drops empty pieces from stray or trailing commas', () => {
    // Typing a trailing comma is what happens when you are about to add
    // another and change your mind.
    expect(splitTagNames('.a,,  , .b,')).toEqual(['.a', '.b']);
  });

  it('treats the same name twice as once, however it is written', () => {
    // Normalised the way the domain does, so these are one tag — and creating
    // it twice in one save is an error the person did not make.
    expect(splitTagNames('.Trip, trip, ..TRIP')).toEqual(['.Trip']);
  });

  it('finds no name in a field of only dots and commas', () => {
    expect(splitTagNames('.,..,  ,')).toEqual([]);
    expect(splitTagNames('')).toEqual([]);
  });
});
