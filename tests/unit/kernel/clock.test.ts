import { describe, expect, it } from 'vitest';
import { fixedClock, mutableClock, systemClock } from '@/shared/kernel/clock';

describe('systemClock', () => {
  it('reports roughly now', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});

describe('fixedClock', () => {
  const at = new Date('2026-01-01T00:00:00.000Z');

  it('always reports the same instant', () => {
    const clock = fixedClock(at);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.now().getTime()).toBe(at.getTime());
  });

  it('returns a copy, so a caller mutating the Date cannot move the clock', () => {
    const clock = fixedClock(at);
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe('mutableClock', () => {
  it('advances by the given milliseconds', () => {
    const clock = mutableClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.advance(24 * 60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('supports the expiry check a token needs', () => {
    const clock = mutableClock(new Date('2026-01-01T00:00:00.000Z'));
    const expiresAt = new Date(clock.now().getTime() + 60 * 60 * 1000);

    clock.advance(59 * 60 * 1000);
    expect(clock.now() < expiresAt).toBe(true);

    clock.advance(2 * 60 * 1000);
    expect(clock.now() < expiresAt).toBe(false);
  });

  it('can jump to an instant', () => {
    const clock = mutableClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.set(new Date('2027-06-15T12:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2027-06-15T12:00:00.000Z');
  });
});
