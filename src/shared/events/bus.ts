import { getDatabase } from '@/shared/infra/database';
import { uuidv7 } from '@/shared/kernel';

/**
 * The in-process event bus (architecture.md §1.2).
 *
 * Its interface is deliberately the one a real broker would give: publish and
 * subscribe, handler-level idempotency, retry with backoff, dead-letter. None
 * of that is needed to call a function in the same process — it is here so that
 * swapping in Pub/Sub later is an adapter change rather than a redesign, and so
 * that handlers are written idempotent from the first day rather than audited
 * for it on the day of the swap.
 *
 * §1.2 deferred this until something subscribed, on the grounds that building
 * publish/subscribe against no consumer means designing for imagined
 * requirements. Erasure (§8.7) is that consumer: one event, several modules,
 * each purging its own data — which is the case the boundaries exist for.
 *
 * ---------------------------------------------------------------------------
 * Publishing is synchronous, and that is not a shortcut.
 *
 * Cloud Run stops the container once a response returns (§1.3), so nothing may
 * be fire-and-forget. A bus that queued handlers to run "after" the request
 * would lose them on the instance that is about to be killed — and for erasure
 * that means a module quietly keeping data someone asked to have deleted,
 * which is the failure with legal weight attached.
 *
 * So `publish` awaits every handler before it returns. The cost is that the
 * publishing request pays for its subscribers; the benefit is that when it
 * answers, the work has actually happened.
 * ---------------------------------------------------------------------------
 */

export interface DomainEvent<T = Record<string, unknown>> {
  readonly id: string;
  readonly name: string;
  readonly occurredAt: Date;
  readonly payload: T;
}

export type EventHandler<T = Record<string, unknown>> = (
  event: DomainEvent<T>,
) => Promise<void>;

interface Subscription {
  readonly eventName: string;
  /** Stable across deploys: it is half the idempotency key. */
  readonly handler: string;
  readonly run: EventHandler;
}

/** Attempts per handler before it is dead-lettered. */
export const MAX_HANDLER_ATTEMPTS = 3;

/** Backoff between attempts, in milliseconds. */
const BACKOFF_MS = [50, 250];

const subscriptions: Subscription[] = [];

/**
 * Registers a handler.
 *
 * `handler` is a stable name, not the function's identity, because it is half
 * of the idempotency key: renaming it re-runs every event that was already
 * handled under the old name. That is occasionally what you want, and always
 * worth doing on purpose.
 */
export function subscribe<T>(
  eventName: string,
  handler: string,
  run: EventHandler<T>,
): void {
  const already = subscriptions.some(
    (s) => s.eventName === eventName && s.handler === handler,
  );
  // Module files can be imported more than once in development; registering
  // twice would run a handler twice per event and look like a bus bug.
  if (already) return;

  subscriptions.push({
    eventName,
    handler,
    run: run as EventHandler,
  });
}

/** Test seam: forget every subscription. */
export function resetSubscriptionsForTests(): void {
  subscriptions.length = 0;
}

export function newEvent<T>(name: string, payload: T, occurredAt: Date): DomainEvent<T> {
  return { id: uuidv7(occurredAt.getTime()), name, occurredAt, payload };
}

export interface PublishResult {
  readonly handled: number;
  readonly skipped: number;
  readonly deadLettered: number;
}

/**
 * Runs every handler subscribed to this event.
 *
 * One failing handler does not stop the others: a module that cannot purge its
 * data must not prevent the modules that can. The failure is recorded rather
 * than thrown, because the caller's job — answering the request that published
 * the event — is not made better by failing it.
 */
export async function publish<T>(event: DomainEvent<T>): Promise<PublishResult> {
  const matching = subscriptions.filter((s) => s.eventName === event.name);

  let handled = 0;
  let skipped = 0;
  let deadLettered = 0;

  for (const subscription of matching) {
    if (await alreadyHandled(event.id, subscription.handler)) {
      skipped += 1;
      continue;
    }

    const failure = await runWithRetries(event, subscription);
    if (failure === null) {
      await recordHandled(event.id, subscription.handler);
      handled += 1;
    } else {
      await deadLetter(event, subscription.handler, failure);
      deadLettered += 1;
    }
  }

  return { handled, skipped, deadLettered };
}

async function runWithRetries(
  event: DomainEvent<unknown>,
  subscription: Subscription,
): Promise<{ attempts: number; error: string } | null> {
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_HANDLER_ATTEMPTS; attempt += 1) {
    try {
      await subscription.run(event as DomainEvent);
      return null;
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);

      const wait = BACKOFF_MS[attempt - 1];
      // Short and in-process: the request is still open and Cloud Run's
      // deadline is finite, so this rides out a blip rather than an outage.
      // An outage is what the dead letter is for.
      if (wait !== undefined) await new Promise((r) => setTimeout(r, wait));
    }
  }

  return { attempts: MAX_HANDLER_ATTEMPTS, error: lastError };
}

/*
 * Without a database there is no idempotency record and no dead letter, so the
 * bus degrades to "run each handler once, in memory". That is the right
 * behaviour for `npm run dev` with no DATABASE_URL (§7.1) — the alternative is
 * a bus that refuses to work locally — and it is stated here rather than left
 * to be inferred from three separate null checks.
 */
async function alreadyHandled(eventId: string, handler: string): Promise<boolean> {
  const db = getDatabase();
  if (!db) return false;

  const rows = await db.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM platform.event_handled
     WHERE event_id = ${eventId}::uuid AND handler = ${handler}
  `;
  return rows.length > 0;
}

async function recordHandled(eventId: string, handler: string): Promise<void> {
  const db = getDatabase();
  if (!db) return;

  await db.$executeRaw`
    INSERT INTO platform.event_handled (event_id, handler, handled_at)
    VALUES (${eventId}::uuid, ${handler}, NOW())
    ON CONFLICT (event_id, handler) DO NOTHING
  `;
}

async function deadLetter(
  event: DomainEvent<unknown>,
  handler: string,
  failure: { attempts: number; error: string },
): Promise<void> {
  const db = getDatabase();
  if (!db) {
    // Nowhere to record it, so say it out loud rather than lose it silently.
    console.error(
      `[events] ${event.name} handler "${handler}" failed and there is no database to record it: ${failure.error}`,
    );
    return;
  }

  await db.$executeRaw`
    INSERT INTO platform.event_dead_letter
      (id, event_id, event_name, handler, payload, attempts, last_error,
       occurred_at, created_at, updated_at)
    VALUES
      (${uuidv7()}::uuid, ${event.id}::uuid, ${event.name}, ${handler},
       ${JSON.stringify(event.payload)}::jsonb, ${failure.attempts},
       ${failure.error}, ${event.occurredAt}, NOW(), NOW())
    ON CONFLICT (event_id, handler) DO UPDATE
      SET attempts = platform.event_dead_letter.attempts + EXCLUDED.attempts,
          last_error = EXCLUDED.last_error,
          updated_at = NOW()
  `;
}

/**
 * Re-runs dead-lettered handlers.
 *
 * Called from the retention sweep, so a handler that failed during an outage
 * is retried without anyone noticing it needed to be. A retry that succeeds
 * removes the dead letter; one that fails again leaves it, with the attempt
 * count accumulated and the newest error.
 */
export async function retryDeadLetters(limit = 20): Promise<number> {
  const db = getDatabase();
  if (!db) return 0;

  const rows = await db.$queryRaw<
    {
      id: string;
      event_id: string;
      event_name: string;
      handler: string;
      payload: unknown;
      occurred_at: Date;
    }[]
  >`
    SELECT id, event_id, event_name, handler, payload, occurred_at
      FROM platform.event_dead_letter
     ORDER BY created_at ASC
     LIMIT ${limit}
  `;

  let recovered = 0;

  for (const row of rows) {
    const subscription = subscriptions.find(
      (s) => s.eventName === row.event_name && s.handler === row.handler,
    );
    // A handler that no longer exists cannot be retried. Left in place rather
    // than deleted: it is evidence that something was dropped, and deleting it
    // is a decision for a person.
    if (!subscription) continue;

    const event: DomainEvent = {
      id: row.event_id,
      name: row.event_name,
      occurredAt: row.occurred_at,
      payload: row.payload as Record<string, unknown>,
    };

    const failure = await runWithRetries(event, subscription);
    if (failure === null) {
      await recordHandled(event.id, subscription.handler);
      await db.$executeRaw`
        DELETE FROM platform.event_dead_letter WHERE id = ${row.id}::uuid
      `;
      recovered += 1;
    } else {
      await deadLetter(event, subscription.handler, failure);
    }
  }

  return recovered;
}
