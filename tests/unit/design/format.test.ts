import { describe, expect, it } from 'vitest';
import {
  deepTimeLabel,
  headerLabel,
  placementOf,
  sectionKey,
  timeLabel,
} from '@/app/_client/format';

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
    expect(headerLabel(verse({ eventStart: '2026-09-08T09:00:00Z' }), NOW)).toBe('Today');
    expect(headerLabel(verse({ eventStart: '2026-09-09T09:00:00Z' }), NOW)).toBe(
      'Tomorrow',
    );
    expect(headerLabel(verse({ eventStart: '2026-09-07T09:00:00Z' }), NOW)).toBe(
      'Yesterday',
    );
  });

  it('counts calendar days, not 24-hour blocks', () => {
    // 23:00 today and 01:00 tomorrow are two hours apart and two different
    // days. A duration-based check calls the second one "Today".
    const late = new Date('2026-09-08T23:00:00.000Z');
    expect(headerLabel(verse({ eventStart: '2026-09-09T01:00:00Z' }), late)).toBe(
      'Tomorrow',
    );
  });

  it('omits the year within this year and includes it outside', () => {
    expect(headerLabel(verse({ eventStart: '2026-03-01T00:00:00Z' }), NOW)).toBe(
      'Sunday 1 March',
    );
    expect(headerLabel(verse({ eventStart: '2024-03-01T00:00:00Z' }), NOW)).toBe(
      'Friday 1 March 2024',
    );
  });

  it('labels an undated verse plainly', () => {
    expect(headerLabel(verse(), NOW)).toBe('No date');
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
    expect(deepTimeLabel(years)).toBe(expected);
  });

  it('drops a trailing .0 rather than implying precision', () => {
    // -13.8e9 is three significant figures of real knowledge. "13.0 billion"
    // would claim one more than anybody has.
    expect(deepTimeLabel(-1e9)).toBe('1 billion years ago');
    expect(deepTimeLabel(-1e6)).toBe('1 million years ago');
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
