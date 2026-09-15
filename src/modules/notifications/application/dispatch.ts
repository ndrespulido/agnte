import { parseRecurrence, nextOccurrence } from '../domain/recurrence';
import { nextAudibleAfter } from '../domain/quiet-hours';
import type {
  DispatchOutcome,
  NotificationDelivery,
  NotificationRepository,
  PreferenceRepository,
  ScheduledNotification,
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
}

export interface TickResult {
  readonly claimed: number;
  readonly sent: number;
  readonly deferred: number;
  readonly failed: number;
  readonly rescheduled: number;
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

  return { claimed: due.length, sent, deferred, failed, rescheduled };
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
