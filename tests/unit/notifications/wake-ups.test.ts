import { describe, expect, it } from 'vitest';
import type { DeferredJob, DeferredJobs } from '@/shared/infra/deferred-jobs';
import {
  DeferredJobWakeUps,
  NoWakeUps,
  TICK_PATH,
} from '@/modules/notifications/infrastructure/wake-ups';

/**
 * A wake-up is a hint: "run a tick at this moment". It names no reminder and
 * carries no payload, which is what makes duplicates and late arrivals safe.
 */
describe('DeferredJobWakeUps', () => {
  const recording = () => {
    const sent: DeferredJob[] = [];
    const jobs: DeferredJobs = {
      description: 'fake',
      enqueue: async (job) => void sent.push(job),
    };
    return { sent, wakeUps: new DeferredJobWakeUps(jobs) };
  };

  it('asks for the tick route, with nothing in the body', async () => {
    const { sent, wakeUps } = recording();
    await wakeUps.at(new Date('2026-09-15T17:00:02Z'));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: TICK_PATH, body: {} });
    expect(sent[0]?.notBefore).toEqual(new Date('2026-09-15T17:00:02Z'));
  });

  /**
   * Keyed on the second, not on a reminder. Two reminders due in the same
   * second need one tick; and the creating request, the previous tick and the
   * daily sweep all asking for the same moment must collapse into one callback
   * — otherwise each would run, each would schedule a successor, and the
   * callbacks per reminder would only ever grow.
   */
  it('gives the same key to every request for the same second', async () => {
    const { sent, wakeUps } = recording();
    await wakeUps.at(new Date('2026-09-15T17:00:02.100Z'));
    await wakeUps.at(new Date('2026-09-15T17:00:02.900Z'));
    await wakeUps.at(new Date('2026-09-15T17:00:03.000Z'));

    expect(sent[0]?.dedupeKey).toBe(sent[1]?.dedupeKey);
    expect(sent[2]?.dedupeKey).not.toBe(sent[0]?.dedupeKey);
    // It becomes a task name, which allows only these characters.
    expect(sent[0]?.dedupeKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('NoWakeUps', () => {
  /**
   * Deliberately not a timer. A timer would run the dispatcher in the middle
   * of whatever test or request was in flight; with no scheduler configured
   * the tick route is called by hand, like the retention sweep (§7.1).
   */
  it('does nothing, and says so', async () => {
    const none = new NoWakeUps();
    await expect(none.at()).resolves.toBeUndefined();
    expect(none.description).toContain('by hand');
  });
});
