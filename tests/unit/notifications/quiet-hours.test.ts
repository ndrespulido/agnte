import { describe, expect, it } from 'vitest';
import {
  isQuiet,
  localMinuteOf,
  nextAudibleAfter,
  parseQuietHours,
  type QuietHours,
} from '@/modules/notifications/domain/quiet-hours';

const quiet = (over: Partial<QuietHours> = {}): QuietHours => ({
  // 22:00–07:00 local: the ordinary case, and the one that wraps midnight.
  startMinute: 22 * 60,
  endMinute: 7 * 60,
  timeZone: 'Europe/Madrid',
  ...over,
});

const at = (iso: string) => new Date(iso);

describe('parseQuietHours', () => {
  it('accepts a window and a real zone', () => {
    const result = parseQuietHours({
      startMinute: 1320,
      endMinute: 420,
      timeZone: 'Europe/Madrid',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses minutes outside a day', () => {
    expect(parseQuietHours({ startMinute: -1, endMinute: 420, timeZone: 'UTC' }).ok).toBe(
      false,
    );
    expect(parseQuietHours({ startMinute: 0, endMinute: 1440, timeZone: 'UTC' }).ok).toBe(
      false,
    );
    expect(
      parseQuietHours({ startMinute: 1.5, endMinute: 420, timeZone: 'UTC' }).ok,
    ).toBe(false);
  });

  /**
   * Equal bounds read as "no quiet hours" or "quiet all day" depending on which
   * way you squint, and one of those silences every reminder forever. Refused
   * rather than resolved, because a reminder system cannot hold that ambiguity.
   */
  it('refuses a window whose ends are the same minute', () => {
    expect(
      parseQuietHours({ startMinute: 480, endMinute: 480, timeZone: 'UTC' }).ok,
    ).toBe(false);
  });

  it('refuses a zone the runtime does not know', () => {
    expect(
      parseQuietHours({ startMinute: 0, endMinute: 420, timeZone: 'Mars/Olympus' }).ok,
    ).toBe(false);
  });
});

/**
 * The reason quiet hours are stored as local minutes plus a zone rather than as
 * a UTC window. Madrid is UTC+1 in winter and UTC+2 in summer; a window pinned
 * to UTC would drift an hour twice a year, which for a medication reminder
 * means an hour early or an hour late for six months at a time.
 */
describe('localMinuteOf across a DST boundary', () => {
  it('reads the same wall-clock time either side of the change', () => {
    // 21:30 UTC is 22:30 Madrid in winter and 23:30 in summer.
    expect(localMinuteOf(at('2027-01-15T21:30:00Z'), 'Europe/Madrid')).toBe(22 * 60 + 30);
    expect(localMinuteOf(at('2027-07-15T21:30:00Z'), 'Europe/Madrid')).toBe(23 * 60 + 30);
  });

  it('treats midnight as zero', () => {
    expect(localMinuteOf(at('2027-01-15T23:00:00Z'), 'Europe/Madrid')).toBe(0);
  });
});

describe('isQuiet', () => {
  it('covers a window that wraps past midnight', () => {
    const window = quiet();
    // 23:00 Madrid, winter.
    expect(isQuiet(window, at('2027-01-15T22:00:00Z'))).toBe(true);
    // 03:00 Madrid — still the same night, on the far side of midnight.
    expect(isQuiet(window, at('2027-01-16T02:00:00Z'))).toBe(true);
    // 09:00 Madrid, wide awake.
    expect(isQuiet(window, at('2027-01-16T08:00:00Z'))).toBe(false);
  });

  it('covers a window that does not wrap', () => {
    const window = quiet({ startMinute: 60, endMinute: 5 * 60 });
    expect(isQuiet(window, at('2027-01-15T02:00:00Z'))).toBe(true); // 03:00 local
    expect(isQuiet(window, at('2027-01-15T21:00:00Z'))).toBe(false); // 22:00 local
  });

  it('is exclusive at the end so a reminder at the boundary goes out', () => {
    const window = quiet();
    // 07:00 Madrid exactly — the window has ended.
    expect(isQuiet(window, at('2027-01-15T06:00:00Z'))).toBe(false);
    // 06:59 is still quiet.
    expect(isQuiet(window, at('2027-01-15T05:59:00Z'))).toBe(true);
  });

  /** The failure §8.4 names outright: a 03:00 medication reminder. */
  it('catches the 03:00 case', () => {
    expect(isQuiet(quiet(), at('2027-01-16T02:00:00Z'))).toBe(true);
  });
});

describe('nextAudibleAfter', () => {
  it('leaves an audible instant alone', () => {
    const noon = at('2027-01-15T11:00:00Z');
    expect(nextAudibleAfter(quiet(), noon).toISOString()).toBe(noon.toISOString());
  });

  it('defers a night-time reminder to the end of the window', () => {
    // 03:00 Madrid → 07:00 Madrid, which is 06:00 UTC in winter.
    const deferred = nextAudibleAfter(quiet(), at('2027-01-16T02:00:00Z'));
    expect(deferred.toISOString()).toBe('2027-01-16T06:00:00.000Z');
  });

  it('defers to local 07:00 in summer too, which is a different UTC hour', () => {
    // The whole point of storing a zone: 07:00 Madrid is 05:00 UTC in July.
    const deferred = nextAudibleAfter(quiet(), at('2027-07-16T01:00:00Z'));
    expect(deferred.toISOString()).toBe('2027-07-16T05:00:00.000Z');
  });

  it('defers rather than cancels', () => {
    // A reminder that fell in the night is still wanted in the morning.
    const deferred = nextAudibleAfter(quiet(), at('2027-01-16T02:00:00Z'));
    expect(deferred.getTime()).toBeGreaterThan(at('2027-01-16T02:00:00Z').getTime());
    expect(isQuiet(quiet(), deferred)).toBe(false);
  });
});
