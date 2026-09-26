import { describe, expect, it } from 'vitest';

/**
 * The reminder form's converters, under a zone that is not UTC.
 *
 * This container runs in UTC, so a browser check here cannot tell a correct
 * conversion from the UTC one it replaced — the bug would be invisible exactly
 * where it was introduced. Forcing the zone is the only way to see it.
 *
 * Madrid is UTC+2 in July and UTC+1 in January, so both directions of the DST
 * shift are covered by the two cases below.
 */
process.env.TZ = 'Europe/Madrid';

const { fromLocalDateTimeInput, toLocalDateTimeInput, localMomentLabel } =
  await import('@/app/_client/format');
const { en } = await import('@/shared/i18n');

describe('reminder times are local, not UTC', () => {
  it('reads a summer wall-clock time as the instant it really is', () => {
    // 17:00 in Madrid in July is 15:00Z. Under the UTC helpers this produced
    // 17:00Z — a reminder two hours late, every time.
    expect(fromLocalDateTimeInput('2026-07-15T17:00')).toBe('2026-07-15T15:00:00.000Z');
  });

  it('reads a winter wall-clock time as the instant it really is', () => {
    expect(fromLocalDateTimeInput('2026-01-15T17:00')).toBe('2026-01-15T16:00:00.000Z');
  });

  it('round-trips an instant back to the same wall-clock time', () => {
    expect(toLocalDateTimeInput('2026-07-15T15:00:00.000Z')).toBe('2026-07-15T17:00');
    expect(toLocalDateTimeInput('2026-01-15T16:00:00.000Z')).toBe('2026-01-15T17:00');
  });

  it('shows the moment in the reader zone', () => {
    expect(localMomentLabel('2026-07-15T15:00:00.000Z', en)).toBe('15 July 2026, 17:00');
  });

  it('answers empty for nothing rather than inventing a date', () => {
    expect(toLocalDateTimeInput(null)).toBe('');
    expect(fromLocalDateTimeInput('')).toBeNull();
    expect(fromLocalDateTimeInput('not a date')).toBeNull();
  });
});
