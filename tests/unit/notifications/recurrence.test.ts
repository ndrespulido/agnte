import { describe, expect, it } from 'vitest';
import {
  formatRecurrence,
  nextOccurrence,
  parseRecurrence,
  type Recurrence,
} from '@/modules/notifications/domain/recurrence';

const parsed = (rule: string): Recurrence => {
  const result = parseRecurrence(rule);
  if (!result.ok) throw new Error(`expected a valid rule: ${result.error.message}`);
  return result.value;
};

const at = (iso: string) => new Date(iso);
const iso = (date: Date | null) => date?.toISOString() ?? null;

describe('parseRecurrence', () => {
  it('reads the supported fields, with or without the RRULE prefix', () => {
    expect(parsed('FREQ=DAILY')).toMatchObject({ freq: 'DAILY', interval: 1 });
    expect(parsed('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH')).toMatchObject({
      freq: 'WEEKLY',
      interval: 2,
      byDay: ['MO', 'TH'],
    });
    expect(iso(parsed('FREQ=DAILY;UNTIL=20270101T090000Z').until)).toBe(
      '2027-01-01T09:00:00.000Z',
    );
    expect(parsed('FREQ=MONTHLY;COUNT=12').count).toBe(12);
  });

  /**
   * The rule that matters most in this file. A parser that ignored a field it
   * did not understand would fire a weekly reminder on the wrong day forever,
   * and nothing about the reminder would look wrong until someone missed a
   * dose.
   */
  it('refuses a field it does not implement rather than ignoring it', () => {
    const result = parseRecurrence('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('BYSETPOS');
  });

  it('refuses BYDAY on a frequency where it would not be honoured', () => {
    expect(parseRecurrence('FREQ=MONTHLY;BYDAY=MO').ok).toBe(false);
  });

  it('refuses rules that are malformed or contradictory', () => {
    expect(parseRecurrence('').ok).toBe(false);
    expect(parseRecurrence('FREQ=HOURLY').ok).toBe(false);
    expect(parseRecurrence('INTERVAL=2').ok).toBe(false);
    expect(parseRecurrence('FREQ=DAILY;INTERVAL=0').ok).toBe(false);
    expect(parseRecurrence('FREQ=DAILY;INTERVAL=-1').ok).toBe(false);
    expect(parseRecurrence('FREQ=WEEKLY;BYDAY=FUNDAY').ok).toBe(false);
    expect(parseRecurrence('FREQ=DAILY;UNTIL=nonsense').ok).toBe(false);
    // Both would fight over which one ends the series.
    expect(parseRecurrence('FREQ=DAILY;UNTIL=20270101T090000Z;COUNT=5').ok).toBe(false);
  });

  it('round-trips through the stored form', () => {
    for (const rule of [
      'FREQ=DAILY',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH',
      'FREQ=MONTHLY;COUNT=12',
      'FREQ=DAILY;UNTIL=20270101T090000Z',
    ]) {
      expect(formatRecurrence(parsed(rule))).toBe(rule);
    }
  });
});

describe('nextOccurrence', () => {
  const start = at('2026-09-15T09:00:00Z');

  it('steps daily, keeping the time of day', () => {
    const rule = parsed('FREQ=DAILY');
    expect(iso(nextOccurrence(rule, start, start, 1))).toBe('2026-09-16T09:00:00.000Z');
    expect(iso(nextOccurrence(rule, start, at('2026-09-20T12:00:00Z'), 1))).toBe(
      '2026-09-21T09:00:00.000Z',
    );
  });

  it('honours an interval', () => {
    const rule = parsed('FREQ=DAILY;INTERVAL=3');
    expect(iso(nextOccurrence(rule, start, start, 1))).toBe('2026-09-18T09:00:00.000Z');
  });

  it('walks the requested weekdays', () => {
    // 2026-09-15 is a Tuesday.
    const rule = parsed('FREQ=WEEKLY;BYDAY=TU,TH');
    const thursday = nextOccurrence(rule, start, start, 1);
    expect(iso(thursday)).toBe('2026-09-17T09:00:00.000Z');
    // ...and back round to the Tuesday of the following week.
    expect(iso(nextOccurrence(rule, start, thursday!, 2))).toBe(
      '2026-09-22T09:00:00.000Z',
    );
  });

  it('skips whole weeks when a weekly interval asks it to', () => {
    const rule = parsed('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU');
    expect(iso(nextOccurrence(rule, start, start, 1))).toBe('2026-09-29T09:00:00.000Z');
  });

  /**
   * The bug this exists to prevent: JavaScript's Date rolls 31 January + 1
   * month over into 3 March, so a monthly reminder set on the 31st would walk
   * forward through the calendar — the 31st becomes the 3rd becomes the 6th —
   * and nobody would notice until it had drifted a week.
   */
  it('clamps to the end of a shorter month instead of rolling over', () => {
    const rule = parsed('FREQ=MONTHLY');
    const jan31 = at('2027-01-31T09:00:00Z');

    const feb = nextOccurrence(rule, jan31, jan31, 1);
    expect(iso(feb)).toBe('2027-02-28T09:00:00.000Z');

    // And the anchor is not lost: March returns to the 31st rather than
    // staying stuck on the 28th.
    expect(iso(nextOccurrence(rule, jan31, feb!, 2))).toBe('2027-03-31T09:00:00.000Z');
  });

  it('handles a leap day', () => {
    const rule = parsed('FREQ=YEARLY');
    const leap = at('2028-02-29T09:00:00Z');
    expect(iso(nextOccurrence(rule, leap, leap, 1))).toBe('2029-02-28T09:00:00.000Z');
  });

  it('stops at UNTIL', () => {
    const rule = parsed('FREQ=DAILY;UNTIL=20260917T090000Z');
    expect(iso(nextOccurrence(rule, start, at('2026-09-16T09:00:00Z'), 2))).toBe(
      '2026-09-17T09:00:00.000Z',
    );
    // The occurrence after the last one is not "later", it is nothing.
    expect(nextOccurrence(rule, start, at('2026-09-17T09:00:00Z'), 3)).toBeNull();
  });

  it('stops once COUNT is spent', () => {
    const rule = parsed('FREQ=DAILY;COUNT=3');
    expect(nextOccurrence(rule, start, start, 2)).not.toBeNull();
    expect(nextOccurrence(rule, start, start, 3)).toBeNull();
  });

  it('never returns an occurrence at or before the instant asked about', () => {
    const rule = parsed('FREQ=DAILY');
    const after = at('2026-10-01T09:00:00.000Z');
    const next = nextOccurrence(rule, start, after, 1);
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });
});
