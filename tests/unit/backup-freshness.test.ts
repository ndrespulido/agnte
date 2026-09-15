import { describe, expect, it } from 'vitest';
import { BACKUP_STALE_AFTER_MS, timestampFromKey } from '@/shared/infra/backup-freshness';

/**
 * The key format is a contract between two programs that never import each
 * other: `infra/backup/backup.mjs` writes these names, and the health check
 * reads the age of a backup out of one without fetching the object.
 *
 * Two properties have to hold, and both are easy to break by "tidying" the
 * format later — which is why they are pinned here rather than left to the
 * comment that explains them.
 */
describe('timestampFromKey', () => {
  it('reads the instant out of a key the backup job writes', () => {
    // Exactly what backup.mjs produced for the 03:17 run on 2026-09-15.
    const at = timestampFromKey('backups/2026/09/agnte-2026-09-15T03-17-02-496Z.dump');
    expect(at?.toISOString()).toBe('2026-09-15T03:17:02.496Z');
  });

  it('ignores anything that is not one of ours', () => {
    expect(timestampFromKey('backups/2026/09/README.txt')).toBeNull();
    expect(timestampFromKey('backups/2026/09/agnte-not-a-date.dump')).toBeNull();
    expect(timestampFromKey('media/original/whatever.jpg')).toBeNull();
    // Right shape, impossible date: rejected rather than silently becoming NaN.
    expect(
      timestampFromKey('backups/2026/13/agnte-2026-13-45T99-99-99-999Z.dump'),
    ).toBeNull();
  });
});

/**
 * The property the whole freshness query rests on.
 *
 * `backupFreshness` asks "is there a key after the one the job would have
 * written at the cutoff" — a single bounded listing rather than a walk of every
 * backup ever taken. That only answers the right question if these names sort
 * lexicographically in time order, including across month and year boundaries,
 * which is why the path is zero-padded and most-significant-first.
 */
describe('key ordering', () => {
  const key = (iso: string) => {
    const at = new Date(iso);
    return `backups/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(
      2,
      '0',
    )}/agnte-${at.toISOString().replace(/[:.]/g, '-')}.dump`;
  };

  it('sorts in time order within a month', () => {
    expect(key('2026-09-15T03:17:00Z') < key('2026-09-16T03:17:00Z')).toBe(true);
  });

  it('sorts in time order across a month boundary', () => {
    // The case a non-padded month would break: "9" > "10" as strings.
    expect(key('2026-09-30T03:17:00Z') < key('2026-10-01T03:17:00Z')).toBe(true);
  });

  it('sorts in time order across a year boundary', () => {
    expect(key('2026-12-31T03:17:00Z') < key('2027-01-01T03:17:00Z')).toBe(true);
  });

  it('gives a cutoff that sorts before a backup taken after it', () => {
    const cutoff = new Date(Date.parse('2026-09-15T12:00:00Z') - BACKUP_STALE_AFTER_MS);
    expect(key(cutoff.toISOString()) < key('2026-09-15T03:17:00Z')).toBe(true);
    // ...and after one taken before it, which is what makes a stale backup
    // invisible to the StartAfter query rather than counted as fresh.
    expect(key(cutoff.toISOString()) < key('2026-09-10T03:17:00Z')).toBe(false);
  });
});

describe('the staleness window', () => {
  /**
   * The job runs daily at 03:17 UTC, so 24h is the expected gap. A limit at or
   * below that would go red on a normal night; far above it stops being a
   * signal. This pins the reasoning, not the taste.
   */
  it('allows a normal night and catches a missed one', () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(BACKUP_STALE_AFTER_MS).toBeGreaterThan(DAY);
    expect(BACKUP_STALE_AFTER_MS).toBeLessThan(2 * DAY);
  });
});
