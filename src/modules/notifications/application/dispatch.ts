import { parseRecurrence, nextOccurrence } from '../domain/recurrence';
import { nextAudibleAfter } from '../domain/quiet-hours';
import type {
  DispatchOutcome,
  NotificationDelivery,
  NotificationRepository,
  PreferenceRepository,
  ScheduledNotification,
  WakeUps,
} from '../domain/ports';

/**
 * The tick (§8.4).
 *
 * Cloud Scheduler calls `/internal/notifications/tick` every five minutes; this
 * is what it runs. Claims due reminders, sends them, and advances or retires
 * each one.
 */

/**
 * How many reminders one tick will handle.
 *
 * Bounded because the tick runs inside a request and Cloud Run will kill the
 * container when it returns (§1.3) — an unbounded batch is a batch that gets
 * cut in half. Anything left over is still due on the next tick five minutes
 * later, so the only cost of a small number is latency on a backlog that should
 * never exist.
 */
export const MAX_PER_TICK = 50;

/**
 * How many times a reminder is retried before it is given up on.
 *
 * A reminder that cannot be delivered is usually undeliverable for a reason
 * that will not change — a push subscription the browser revoked, an email
 * address that no longer accepts mail. Retrying forever turns one broken
 * reminder into a permanent line of noise in the logs, and the row itself is
 * the record, so `failed` keeps the evidence.
 */
export const MAX_ATTEMPTS = 5;

export interface DispatchDeps {
  readonly notifications: NotificationRepository;
  readonly preferences: PreferenceRepository;
  readonly delivery: NotificationDelivery;
  readonly wakeUps: WakeUps;
}

export interface TickResult {
  readonly claimed: number;
  readonly sent: number;
  readonly deferred: number;
  readonly failed: number;
  readonly rescheduled: number;
  /** When the next tick was asked for, or null when nothing is due in the horizon. */
  readonly nextWakeUp: Date | null;
}

/**
 * How far ahead a wake-up is asked for.
 *
 * Two days, against a sweep that runs daily: anything due later than this is
 * left for a future sweep's tick to schedule, and the overlap means one missed
 * sweep still leaves every reminder covered. Far inside the thirty days the
 * queue accepts, on purpose — a wake-up parked for weeks is a wake-up that
 * outlives edits to the reminder it was for.
 */
export const WAKE_HORIZON_MS = 48 * 60 * 60 * 1000;

/**
 * Asked for slightly after the reminder is due, never exactly on it.
 *
 * The queue's clock and this service's clock are two clocks. A wake-up that
 * arrives a few milliseconds early finds nothing due, claims nothing, and — if
 * it also asked for the same second again — is deduplicated into silence,
 * stranding the reminder until the daily sweep. Two seconds late is invisible
 * to a person and removes the race.
 */
export const WAKE_MARGIN_MS = 2_000;

/**
 * Asks for a wake-up at `fireAt`, if it is close enough to ask for.
 *
 * Exported because two callers need the identical rule: the tick, for whatever
 * comes next, and the request that creates a reminder — which may be due
 * sooner than anything the last tick knew about.
 */
export async function requestWakeUp(
  fireAt: Date,
  now: Date,
  wakeUps: WakeUps,
): Promise<Date | null> {
  if (fireAt.getTime() - now.getTime() > WAKE_HORIZON_MS) return null;

  // Never in the past: an overdue reminder is "as soon as possible", and a
  // backlog must not turn into a tight loop of immediate callbacks.
  const when = new Date(Math.max(fireAt.getTime(), now.getTime()) + WAKE_MARGIN_MS);
  await wakeUps.at(when);
  return when;
}

/**
 * Works one batch of due reminders.
 *
 * Each row is settled independently and failures are contained: one reminder
 * whose delivery throws must not strand the other forty-nine that were claimed
 * alongside it, because they are all locked until this call returns.
 */
export async function tick(now: Date, deps: DispatchDeps): Promise<TickResult> {
  const due = await deps.notifications.claimDue(now, MAX_PER_TICK);

  let sent = 0;
  let deferred = 0;
  let failed = 0;
  let rescheduled = 0;

  for (const notification of due) {
    const outcome = await handleOne(notification, now, deps);
    await deps.notifications.settle(outcome);

    if (outcome.status === 'failed') failed += 1;
    else if (outcome.occurrences > notification.occurrences) {
      sent += 1;
      if (outcome.nextFireAt) rescheduled += 1;
    } else if (outcome.nextFireAt && outcome.attempts === notification.attempts) {
      // Not sent and not a failed attempt: quiet hours moved it.
      deferred += 1;
    }
  }

  /*
   * Leave a wake-up behind for whatever is due next.
   *
   * One question to the table after the loop, rather than a wake-up per
   * outcome: it covers a recurrence's next occurrence, a quiet-hours deferral,
   * a retry's backoff and a backlog larger than this tick's limit in the same
   * line, and it covers reminders this tick never touched. Each tick
   * guarantees the next one, which is what lets the chain run with no cron.
   */
  const next = await deps.notifications.earliestPendingFireAt();
  const nextWakeUp = next ? await requestWakeUp(next, now, deps.wakeUps) : null;

  return { claimed: due.length, sent, deferred, failed, rescheduled, nextWakeUp };
}

async function handleOne(
  notification: ScheduledNotification,
  now: Date,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  /*
   * Quiet hours are checked here, at dispatch, rather than when the reminder
   * was scheduled.
   *
   * Someone can change their quiet hours, or move country, between scheduling
   * a recurring reminder and any given occurrence of it — and a window
   * resolved months in advance would be resolved against rules that may since
   * have changed (quiet-hours.ts). The only instant whose local time is
   * knowable is this one.
   */
  const preference = await deps.preferences.find(notification.userId);
  if (preference?.quietHours) {
    const audible = nextAudibleAfter(preference.quietHours, now);
    if (audible.getTime() !== now.getTime()) {
      // Deferred, not sent and not failed: the occurrence has not happened, so
      // neither `occurrences` nor `attempts` moves. It simply comes back round.
      return {
        id: notification.id,
        nextFireAt: audible,
        occurrences: notification.occurrences,
        status: 'pending',
        attempts: notification.attempts,
        lastError: notification.lastError,
      };
    }
  }

  try {
    await deps.delivery.send({
      userId: notification.userId,
      title: notification.title,
      body: notification.body,
      verseId: notification.verseId,
    });
  } catch (cause) {
    const attempts = notification.attempts + 1;
    const message = cause instanceof Error ? cause.message : String(cause);

    if (attempts >= MAX_ATTEMPTS) {
      return {
        id: notification.id,
        nextFireAt: null,
        occurrences: notification.occurrences,
        status: 'failed',
        attempts,
        lastError: message,
      };
    }

    /*
     * Exponential backoff from *now*, not from the original fire time.
     *
     * Backing off from `fireAt` would put the retry in the past the moment a
     * reminder was already late, which turns a transient failure into a tight
     * loop across successive ticks — the opposite of backing off.
     */
    const backoffMs = Math.min(2 ** attempts, 64) * 60_000;
    return {
      id: notification.id,
      nextFireAt: new Date(now.getTime() + backoffMs),
      occurrences: notification.occurrences,
      status: 'pending',
      attempts,
      lastError: message,
    };
  }

  const occurrences = notification.occurrences + 1;

  // A one-off is done.
  if (!notification.recurrence) {
    return {
      id: notification.id,
      nextFireAt: null,
      occurrences,
      status: 'sent',
      attempts: notification.attempts,
      lastError: null,
    };
  }

  const rule = parseRecurrence(notification.recurrence);
  if (!rule.ok) {
    /*
     * A rule that no longer parses.
     *
     * Only reachable if the supported subset is *narrowed* after a rule was
     * stored, which is a migration hazard rather than a user error. Retired as
     * `failed` with the parser's own message rather than retried, because no
     * number of attempts will make an unparseable rule parse, and the row
     * keeps the evidence for whoever narrowed it.
     */
    return {
      id: notification.id,
      nextFireAt: null,
      occurrences,
      status: 'failed',
      attempts: notification.attempts,
      lastError: rule.error.message,
    };
  }

  const next = nextOccurrence(rule.value, notification.startAt, now, occurrences);

  return {
    id: notification.id,
    nextFireAt: next,
    occurrences,
    // A recurring reminder with nothing left to fire is spent, not broken.
    status: next ? 'pending' : 'sent',
    attempts: notification.attempts,
    lastError: null,
  };
}
