import { afterAll, describe, expect, it } from 'vitest';
import {
  fromDateAndTime,
  headerLabel,
  placementOf,
  sectionKey,
  timeLabel,
  timelinePosition,
  toDateInput,
  toTimeInput,
  type EventPrecision,
} from '@/app/_client/format';
import { en } from '@/shared/i18n';

/**
 * A day and a moment, read from two sides of UTC (§2.1).
 *
 * This container runs in UTC, where the bug these pin is invisible: a day read
 * as an instant and an instant read as a day give the same answer when the
 * offset is zero. So the zone is forced, both ways, because the two directions
 * fail differently —
 *
 *   east (Madrid, +1/+2): a typed 17:00 was stored as 17:00Z, an hour or two
 *     late, and a reminder set for 17:00 showed on the timeline as 15:00;
 *   west (Recife, −3): a day stored at midnight UTC is 21:00 the evening
 *     before, so read as an instant it files under the wrong date.
 *
 * Recife rather than a round-number zone because it is where this timeline is
 * actually going to be read from.
 */
const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const ZONES = ['Europe/Madrid', 'America/Recife'] as const;

const verse = (eventStart: string, eventPrecision: EventPrecision) => ({
  eventStart,
  eventPrecision,
  deepTimeYears: null,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe.each(ZONES)('in %s', (zone) => {
  const here = <T>(run: () => T): T => {
    process.env.TZ = zone;
    return run();
  };

  it('keeps a day on its own date', () => {
    here(() => {
      const day = placementOf(verse('2026-07-16T00:00:00.000Z', 'date'));
      const now = new Date('2026-09-08T12:00:00.000Z');

      expect(headerLabel(day, now, en)).toBe('Thursday 16 July');
      expect(timeLabel(day)).toBe(null);
      expect(toDateInput('2026-07-16T00:00:00.000Z', 'date')).toBe('2026-07-16');
      expect(toTimeInput('2026-07-16T00:00:00.000Z', 'date')).toBe('');
    });
  });

  it('stores a day the same from anywhere', () => {
    here(() => {
      expect(fromDateAndTime('2026-07-16', '')).toEqual({
        iso: '2026-07-16T00:00:00.000Z',
        precision: 'date',
      });
    });
  });

  it('round-trips a typed time through the instant it really is', () => {
    here(() => {
      const stored = fromDateAndTime('2026-07-16', '17:00')!;

      expect(stored.precision).toBe('minute');
      expect(toDateInput(stored.iso, 'minute')).toBe('2026-07-16');
      expect(toTimeInput(stored.iso, 'minute')).toBe('17:00');
      expect(timeLabel(placementOf(verse(stored.iso, 'minute')))).toBe('17:00');
    });
  });

  it('files a day in the same section as that day’s timed verses, and ahead of them', () => {
    here(() => {
      const day = verse('2026-07-16T00:00:00.000Z', 'date');
      const firstMinute = verse(fromDateAndTime('2026-07-16', '00:01')!.iso, 'minute');
      const lastMinute = verse(fromDateAndTime('2026-07-16', '23:59')!.iso, 'minute');
      const nightBefore = verse(fromDateAndTime('2026-07-15', '23:59')!.iso, 'minute');

      expect(sectionKey(placementOf(day))).toBe(sectionKey(placementOf(firstMinute)));
      expect(sectionKey(placementOf(day))).toBe(sectionKey(placementOf(lastMinute)));
      expect(sectionKey(placementOf(day))).not.toBe(sectionKey(placementOf(nightBefore)));

      // Sorted by the stored instant, a day lands at 21:00 the evening before
      // in Recife — between `nightBefore` and nothing, splitting the 15th.
      expect(timelinePosition(day)).toBeGreaterThan(timelinePosition(nightBefore));
      expect(timelinePosition(day)).toBeLessThan(timelinePosition(firstMinute));
    });
  });
});

describe('the instants themselves', () => {
  it('reads 17:00 in Madrid in July as 15:00Z', () => {
    process.env.TZ = 'Europe/Madrid';
    expect(fromDateAndTime('2026-07-16', '17:00')?.iso).toBe('2026-07-16T15:00:00.000Z');
    // And in January, when the offset is one hour rather than two.
    expect(fromDateAndTime('2026-01-16', '17:00')?.iso).toBe('2026-01-16T16:00:00.000Z');
  });

  it('reads 17:00 in Recife as 20:00Z', () => {
    process.env.TZ = 'America/Recife';
    expect(fromDateAndTime('2026-07-16', '17:00')?.iso).toBe('2026-07-16T20:00:00.000Z');
  });

  /**
   * The reminder that started this. It is saved as an instant — 17:00 in
   * Madrid is 15:00Z — and the timeline read every verse's UTC parts, so it
   * sat on the timeline labelled 15:00.
   */
  it('shows a reminder at the hour it was set for', () => {
    process.env.TZ = 'Europe/Madrid';
    expect(timeLabel(placementOf(verse('2026-07-16T15:00:00.000Z', 'minute')))).toBe(
      '17:00',
    );
  });

  it('puts a late-evening moment on the reader’s date, not UTC’s', () => {
    // 22:30 on the 15th in Recife is 01:30Z on the 16th.
    process.env.TZ = 'America/Recife';
    const late = placementOf(verse('2026-07-16T01:30:00.000Z', 'minute'));
    expect(headerLabel(late, new Date('2026-09-08T12:00:00.000Z'), en)).toBe(
      'Wednesday 15 July',
    );
  });

  it('calls a day Today by the reader’s calendar', () => {
    // 22:00 on 15 July in Recife; UTC has already moved on to the 16th.
    process.env.TZ = 'America/Recife';
    const now = new Date('2026-07-16T01:00:00.000Z');

    expect(
      headerLabel(placementOf(verse('2026-07-15T00:00:00.000Z', 'date')), now, en),
    ).toBe('Today');
    expect(
      headerLabel(placementOf(verse('2026-07-16T00:00:00.000Z', 'date')), now, en),
    ).toBe('Tomorrow');
  });
});
