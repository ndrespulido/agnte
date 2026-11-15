import type { QuietHours } from './quiet-hours';

/**
 * What this module needs from the outside, as interfaces the domain owns.
 *
 * Hexagonal, like every other module here: nothing below imports Prisma, Next
 * or Resend, and the adapters in `infrastructure/` implement these.
 */

export type NotificationStatus = 'pending' | 'sent' | 'failed';

export interface ScheduledNotification {
  readonly id: string;
  readonly userId: string;
  readonly verseId: string | null;

  /** When it goes out next. */
  readonly fireAt: Date;
  /** The anchor the recurrence counts from — never moves once set. */
  readonly startAt: Date;
  /** How many have already fired, so COUNT can be honoured without replay. */
  readonly occurrences: number;

  /** RRULE, or null for a one-off. */
  readonly recurrence: string | null;

  readonly status: NotificationStatus;
  readonly title: string;
  readonly body: string | null;

  readonly attempts: number;
  readonly lastError: string | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface NotificationPreference {
  readonly userId: string;
  /** Null when this person has never set quiet hours — see the migration's CHECK. */
  readonly quietHours: QuietHours | null;
  readonly version: number;
}

/** How a claimed row is left once the dispatcher is done with it. */
export interface DispatchOutcome {
  readonly id: string;
  /** Advanced to the next occurrence, or null when the series is over. */
  readonly nextFireAt: Date | null;
  readonly occurrences: number;
  readonly status: NotificationStatus;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface NotificationRepository {
  create(notification: ScheduledNotification): Promise<void>;
  findById(id: string): Promise<ScheduledNotification | null>;
  listForUser(userId: string, limit: number): Promise<ScheduledNotification[]>;

  /**
   * Takes ownership of up to `limit` reminders that are due.
   *
   * The contract §8.4 asks for: `SELECT ... FOR UPDATE SKIP LOCKED`, so two
   * instances ticking at the same moment never hand the same reminder to two
   * dispatchers. `SKIP LOCKED` rather than a plain `FOR UPDATE` is the whole
   * point — the second instance walks past the locked rows and takes the next
   * ones instead of blocking behind the first.
   */
  claimDue(now: Date, limit: number): Promise<ScheduledNotification[]>;

  /**
   * When the next pending reminder is due, or null when nothing is pending.
   *
   * What a tick asks before it finishes, so it can leave a wake-up behind for
   * whatever comes next (see `WakeUps`). Past times are returned as they are:
   * a backlog larger than one tick's limit is "due now", and the caller is the
   * one that knows what now is.
   */
  earliestPendingFireAt(): Promise<Date | null>;

  /** Writes back what the dispatcher decided about a claimed row. */
  settle(outcome: DispatchOutcome): Promise<void>;

  /**
   * Deletes by owner. Called on erasure (§8.7) — a reminder is this module's
   * own data, so purging it is this module's job, which is what the boundaries
   * buy.
   */
  deleteForUser(userId: string): Promise<number>;
}

export interface PreferenceRepository {
  find(userId: string): Promise<NotificationPreference | null>;
  upsert(preference: NotificationPreference): Promise<void>;
  deleteForUser(userId: string): Promise<number>;
}

/** One browser's Web Push subscription (§8.4). */
export interface PushSubscriptionRecord {
  readonly id: string;
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent: string | null;
}

export interface PushSubscriptionRepository {
  /** Every browser this person has subscribed. A reminder goes to all of them. */
  listForUser(userId: string): Promise<PushSubscriptionRecord[]>;

  /**
   * Stores a subscription, keyed on the endpoint rather than the id.
   *
   * A browser re-subscribes on its own schedule — after a permission reset, a
   * profile restore, or whenever the push service rotates the endpoint — and
   * each time it hands back the same endpoint with fresh keys. Inserting would
   * accumulate rows that all address one device; upserting keeps one row and
   * the newest keys.
   */
  upsert(subscription: PushSubscriptionRecord): Promise<void>;

  /**
   * Forgets one, by endpoint and owner.
   *
   * Scoped to the owner even though the endpoint is unique: the endpoint is not
   * a secret — it travels in every subscription payload — so an unscoped delete
   * would let anyone holding one unsubscribe someone else's device.
   */
  remove(userId: string, endpoint: string): Promise<boolean>;

  /**
   * Forgets one the push service has rejected as gone, wherever it lives.
   *
   * Unscoped on purpose, and the only place that is right: a 404 or 410 from
   * the push service is that service saying this endpoint no longer exists, and
   * keeping it means failing against it on every tick forever.
   */
  removeByEndpoint(endpoint: string): Promise<boolean>;

  deleteForUser(userId: string): Promise<number>;
}

/** Where a reminder actually goes. */
export interface NotificationDelivery {
  /** Human-readable, for the status page and for logs. */
  readonly description: string;

  /**
   * Sends one reminder.
   *
   * Throws on failure rather than returning a result: the dispatcher counts
   * attempts and decides whether to retry, and a transport that swallowed its
   * own errors would make that decision impossible to reach.
   */
  send(input: {
    userId: string;
    title: string;
    body: string | null;
    verseId: string | null;
  }): Promise<void>;
}

/**
 * Asking to be woken at a moment (§8.4).
 *
 * The dispatcher does not poll. It first shipped behind a five-minute cron,
 * which worked and was the one design this platform cannot afford: the
 * database suspends after five idle minutes, so a five-minute poll keeps it
 * awake around the clock and spends roughly twice the free plan's compute
 * allowance doing nothing. Instead each reminder asks for one callback at its
 * own fire time, and the service and database sleep until it arrives.
 *
 * **A wake-up is a hint, never the truth.** It carries no reminder id and no
 * payload: it only says "run a tick now", and the tick claims whatever is
 * actually due from the table. That is what makes duplicates, late arrivals
 * and lost wake-ups all safe — a duplicate claims nothing, a late one claims
 * what is overdue, and a lost one is recovered by the daily sweep's own tick.
 */
export interface WakeUps {
  readonly description: string;
  at(when: Date): Promise<void>;
}
