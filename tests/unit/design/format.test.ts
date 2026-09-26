import { describe, expect, it } from 'vitest';
import {
  deepTimeLabel,
  fromDateTimeInput,
  splitTagNames,
  headerLabel,
  placementOf,
  sectionKey,
  timeLabel,
  toDateTimeInput,
} from '@/app/_client/format';
import { en, es, fr, zh } from '@/shared/i18n';

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

  it('shows nothing at midnight, which means "no time given"', () => {
    // A date-only entry arrives as midnight. Printing "00:00" would invent a
    // precision the user did not supply.
    expect(timeLabel(verse({ eventStart: '2026-03-01T00:00:00Z' }))).toBe(null);
  });

  it('has nothing to say about deep time', () => {
    expect(timeLabel(verse({ deepTimeYears: -66e6 }))).toBe(null);
  });
});

/**
 * The pair the edit sheet writes dates through.
 *
 * The round trip is the property that matters: what the sheet shows for a
 * stored instant must be the instant it sends back when nothing was typed.
 * Both halves work in UTC on purpose — see the doc comment on
 * `toDateTimeInput` for the cost of that, and why matching the display layer
 * beats being independently right.
 */
describe('the datetime-local pair', () => {
  it('round-trips an instant unchanged', () => {
    const iso = '2026-03-01T14:30:00.000Z';
    expect(fromDateTimeInput(toDateTimeInput(iso))).toBe(iso);
  });

  it('reads and writes in UTC, not the browser zone', () => {
    // The whole point: were this local, a machine in Madrid would render
    // 16:30 here and the timeline (which reads UTC parts) would then disagree
    // with the field the person just typed into.
    expect(toDateTimeInput('2026-03-01T14:30:00.000Z')).toBe('2026-03-01T14:30');
    expect(fromDateTimeInput('2026-03-01T14:30')).toBe('2026-03-01T14:30:00.000Z');
  });

  it('treats empty as no date in both directions', () => {
    // Not the same as "leave it alone": the sheet sends this null explicitly
    // so that clearing a date actually clears it.
    expect(toDateTimeInput(null)).toBe('');
    expect(fromDateTimeInput('')).toBe(null);
    expect(fromDateTimeInput('   ')).toBe(null);
  });

  it('answers empty rather than throwing on something unparseable', () => {
    expect(toDateTimeInput('not a date')).toBe('');
    expect(fromDateTimeInput('not a date')).toBe(null);
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
