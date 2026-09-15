import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  MAX_PER_TICK,
  tick,
  type DispatchDeps,
} from '@/modules/notifications/application/dispatch';
import type {
  DispatchOutcome,
  NotificationPreference,
  NotificationRepository,
  PreferenceRepository,
  ScheduledNotification,
} from '@/modules/notifications/domain/ports';

/**
 * The tick, against fakes.
 *
 * Fakes rather than mocks: what matters is what the dispatcher *decides* — how
 * a row is left after a send, a failure, or a night — and that is a value it
 * hands to `settle`. Asserting on that value is stabler than asserting on which
 * methods were called in what order.
 */

const at = (iso: string) => new Date(iso);
const NOW = at('2026-09-15T09:00:00Z');

const reminder = (over: Partial<ScheduledNotification> = {}): ScheduledNotification => ({
  id: 'n1',
  userId: 'u1',
  verseId: null,
  fireAt: NOW,
  startAt: NOW,
  occurrences: 0,
  recurrence: null,
  status: 'pending',
  title: 'Take the tablet',
  body: null,
  attempts: 0,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 0,
  ...over,
});

function harness(options: {
  due: ScheduledNotification[];
  quietHours?: NotificationPreference['quietHours'];
  send?: () => Promise<void>;
}) {
  const settled: DispatchOutcome[] = [];
  let claimedWith: { now: Date; limit: number } | null = null;
  let sends = 0;

  const notifications: NotificationRepository = {
    create: async () => undefined,
    findById: async () => null,
    listForUser: async () => [],
    claimDue: async (now, limit) => {
      claimedWith = { now, limit };
      return options.due;
    },
    settle: async (outcome) => {
      settled.push(outcome);
    },
    deleteForUser: async () => 0,
  };

  const preferences: PreferenceRepository = {
    find: async (userId) => ({
      userId,
      quietHours: options.quietHours ?? null,
      version: 0,
    }),
    upsert: async () => undefined,
    deleteForUser: async () => 0,
  };

  const deps: DispatchDeps = {
    notifications,
    preferences,
    delivery: {
      description: 'fake',
      send: async () => {
        sends += 1;
        if (options.send) await options.send();
      },
    },
  };

  return {
    deps,
    settled,
    sends: () => sends,
    claimedWith: () => claimedWith,
  };
}

describe('tick', () => {
  it('claims a bounded batch', async () => {
    const h = harness({ due: [] });
    await tick(NOW, h.deps);
    expect(h.claimedWith()?.limit).toBe(MAX_PER_TICK);
  });

  it('sends a one-off and retires it', async () => {
    const h = harness({ due: [reminder()] });
    const result = await tick(NOW, h.deps);

    expect(h.sends()).toBe(1);
    expect(result).toMatchObject({ claimed: 1, sent: 1, rescheduled: 0 });
    expect(h.settled[0]).toMatchObject({
      status: 'sent',
      nextFireAt: null,
      occurrences: 1,
    });
  });

  it('advances a recurring reminder to its next occurrence', async () => {
    const h = harness({ due: [reminder({ recurrence: 'FREQ=DAILY' })] });
    const result = await tick(NOW, h.deps);

    expect(result).toMatchObject({ sent: 1, rescheduled: 1 });
    expect(h.settled[0]).toMatchObject({ status: 'pending', occurrences: 1 });
    expect(h.settled[0]?.nextFireAt?.toISOString()).toBe('2026-09-16T09:00:00.000Z');
  });

  it('retires a recurring reminder once its series runs out', async () => {
    const h = harness({
      due: [reminder({ recurrence: 'FREQ=DAILY;COUNT=1', occurrences: 0 })],
    });
    await tick(NOW, h.deps);

    // Sent, not failed: a series that is spent is finished, not broken.
    expect(h.settled[0]).toMatchObject({ status: 'sent', nextFireAt: null });
  });

  /**
   * The failure §8.4 names: never wake someone at 03:00. The reminder is moved,
   * not sent and not counted — the occurrence has not happened yet, so neither
   * `occurrences` nor `attempts` may move, or a daily reminder deferred one
   * night would quietly skip that day.
   */
  it('defers a reminder that falls inside quiet hours without consuming it', async () => {
    const h = harness({
      due: [reminder({ recurrence: 'FREQ=DAILY' })],
      quietHours: { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'Europe/Madrid' },
    });

    // 02:00 UTC is 03:00 in Madrid in January.
    const night = at('2027-01-16T02:00:00Z');
    const result = await tick(night, h.deps);

    expect(h.sends()).toBe(0);
    expect(result).toMatchObject({ sent: 0, deferred: 1 });
    expect(h.settled[0]).toMatchObject({
      status: 'pending',
      occurrences: 0,
      attempts: 0,
    });
    expect(h.settled[0]?.nextFireAt?.toISOString()).toBe('2027-01-16T06:00:00.000Z');
  });

  it('sends normally outside quiet hours', async () => {
    const h = harness({
      due: [reminder()],
      quietHours: { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'Europe/Madrid' },
    });
    await tick(at('2027-01-16T11:00:00Z'), h.deps);
    expect(h.sends()).toBe(1);
  });

  it('backs off from now rather than from the original fire time', async () => {
    const h = harness({
      due: [reminder({ fireAt: at('2026-09-01T09:00:00Z') })],
      send: async () => {
        throw new Error('push endpoint gone');
      },
    });

    // Two weeks late. Backing off from `fireAt` would schedule the retry in the
    // past, which across successive ticks is a tight loop, not a backoff.
    await tick(NOW, h.deps);

    expect(h.settled[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(h.settled[0]!.nextFireAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(h.settled[0]?.lastError).toBe('push endpoint gone');
  });

  it('gives up after the attempt limit and keeps the reason', async () => {
    const h = harness({
      due: [reminder({ attempts: MAX_ATTEMPTS - 1 })],
      send: async () => {
        throw new Error('subscription expired');
      },
    });
    await tick(NOW, h.deps);

    expect(h.settled[0]).toMatchObject({
      status: 'failed',
      nextFireAt: null,
      attempts: MAX_ATTEMPTS,
      lastError: 'subscription expired',
    });
  });

  /**
   * All claimed rows are locked until the tick returns, so one throwing
   * delivery must not strand the rest of the batch.
   */
  it('settles every claimed row even when one delivery throws', async () => {
    let calls = 0;
    const h = harness({
      due: [reminder({ id: 'a' }), reminder({ id: 'b' }), reminder({ id: 'c' })],
      send: async () => {
        calls += 1;
        if (calls === 2) throw new Error('transient');
      },
    });

    const result = await tick(NOW, h.deps);

    expect(result.claimed).toBe(3);
    expect(h.settled.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(h.settled[1]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(h.settled[2]).toMatchObject({ status: 'sent' });
  });

  /**
   * Only reachable by narrowing the supported RRULE subset after a rule was
   * stored — a migration hazard. Retired rather than retried, because no number
   * of attempts makes an unparseable rule parse.
   */
  it('retires a reminder whose rule no longer parses, after delivering it', async () => {
    const h = harness({ due: [reminder({ recurrence: 'FREQ=HOURLY' })] });
    await tick(NOW, h.deps);

    expect(h.sends()).toBe(1);
    expect(h.settled[0]).toMatchObject({ status: 'failed', nextFireAt: null });
    expect(h.settled[0]?.lastError).toContain('HOURLY');
  });
});
