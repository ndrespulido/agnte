import { getDeferredJobs, type DeferredJobs } from '@/shared/infra/deferred-jobs';
import type { WakeUps } from '../domain/ports';

/** The route a wake-up calls. It takes no body: a wake-up is only a hint. */
export const TICK_PATH = '/internal/notifications/tick';

/**
 * Wake-ups as scheduled deferred jobs (§1.3) — Cloud Tasks in production.
 *
 * Deduplicated by the second it is asked for. Several callers legitimately ask
 * for the same moment — the request that created a reminder, the tick before
 * it, the daily sweep — and without a key each would be delivered, each tick
 * would schedule its own successor, and the callbacks per reminder would only
 * ever grow. Keyed on the time rather than on a reminder because that is what
 * a wake-up *is*: two reminders due in the same second need one tick, not two.
 */
export class DeferredJobWakeUps implements WakeUps {
  readonly description: string;

  constructor(private readonly jobs: DeferredJobs) {
    this.description = `wake-ups via ${jobs.description}`;
  }

  async at(when: Date): Promise<void> {
    const second = Math.floor(when.getTime() / 1000);
    await this.jobs.enqueue({
      path: TICK_PATH,
      body: {},
      notBefore: new Date(second * 1000),
      dedupeKey: `reminder-tick-${second}`,
    });
  }
}

/**
 * No scheduler configured: nothing wakes the dispatcher by itself.
 *
 * The local-development answer, and the same one the retention sweep gives
 * (§7.1): there is no scheduler on a development machine, and the tick route
 * is there to be called by hand. Deliberately not an in-process timer. A timer
 * would fire the dispatcher in the middle of whichever test or request
 * happened to be running, against whatever was in the database at that
 * moment — a kind of flake that is very expensive to find.
 */
export class NoWakeUps implements WakeUps {
  readonly description = 'no wake-ups (call the tick route by hand)';

  async at(): Promise<void> {
    // Intentionally nothing. See the class comment.
  }
}

export function getWakeUps(): WakeUps {
  const jobs = getDeferredJobs();
  return jobs ? new DeferredJobWakeUps(jobs) : new NoWakeUps();
}
