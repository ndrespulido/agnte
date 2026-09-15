import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import {
  MAX_HANDLER_ATTEMPTS,
  newEvent,
  publish,
  resetSubscriptionsForTests,
  retryDeadLetters,
  subscribe,
} from '@/shared/events';

/**
 * The bus, against real Postgres.
 *
 * Idempotency and dead-lettering are the whole reason it exists in this shape —
 * nothing here is needed to call a function in the same process — so they are
 * tested where they actually live rather than against a fake that would just
 * agree with the implementation.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const at = (iso: string) => new Date(iso);

describe.skipIf(!DATABASE_URL)('event bus', () => {
  beforeEach(async () => {
    resetSubscriptionsForTests();
    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM platform.event_handled');
    await db.$executeRawUnsafe('DELETE FROM platform.event_dead_letter');
  });

  afterEach(() => {
    resetSubscriptionsForTests();
  });

  it('runs every handler subscribed to the event', async () => {
    const seen: string[] = [];
    subscribe('thing.happened', 'a', async () => void seen.push('a'));
    subscribe('thing.happened', 'b', async () => void seen.push('b'));
    subscribe('other.thing', 'c', async () => void seen.push('c'));

    const result = await publish(
      newEvent('thing.happened', { x: 1 }, at('2026-09-15T09:00:00Z')),
    );

    expect(seen).toEqual(['a', 'b']);
    expect(result).toMatchObject({ handled: 2, deadLettered: 0 });
  });

  /**
   * "Handlers must be idempotent from day one" — enforced here rather than
   * trusted to every handler author, so a redelivery is a no-op even when the
   * handler itself would not have been.
   */
  it('runs a handler once per event, however many times it is published', async () => {
    let runs = 0;
    subscribe('thing.happened', 'counter', async () => {
      runs += 1;
    });

    const event = newEvent('thing.happened', {}, at('2026-09-15T09:00:00Z'));
    await publish(event);
    const second = await publish(event);

    expect(runs).toBe(1);
    expect(second).toMatchObject({ handled: 0, skipped: 1 });
  });

  it('does not let one failing handler stop the others', async () => {
    const seen: string[] = [];
    subscribe('thing.happened', 'broken', async () => {
      throw new Error('nope');
    });
    subscribe('thing.happened', 'fine', async () => void seen.push('fine'));

    const result = await publish(
      newEvent('thing.happened', {}, at('2026-09-15T09:00:00Z')),
    );

    // A module that cannot purge must not prevent the modules that can.
    expect(seen).toEqual(['fine']);
    expect(result).toMatchObject({ handled: 1, deadLettered: 1 });
  });

  it('retries before giving up, then dead-letters with the payload', async () => {
    let attempts = 0;
    subscribe('thing.happened', 'flaky', async () => {
      attempts += 1;
      throw new Error('still down');
    });

    await publish(
      newEvent('thing.happened', { userId: 'u1' }, at('2026-09-15T09:00:00Z')),
    );

    expect(attempts).toBe(MAX_HANDLER_ATTEMPTS);

    const rows = await getDatabase()!.$queryRawUnsafe<
      { handler: string; attempts: number; last_error: string; payload: unknown }[]
    >('SELECT handler, attempts, last_error, payload FROM platform.event_dead_letter');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ handler: 'flaky', last_error: 'still down' });
    // The payload is kept because a retry needs it — an event whose body was
    // discarded can be investigated but never replayed.
    expect(rows[0]?.payload).toEqual({ userId: 'u1' });
  });

  it('recovers a dead letter once the handler works again', async () => {
    let healthy = false;
    subscribe('thing.happened', 'recovers', async () => {
      if (!healthy) throw new Error('down');
    });

    await publish(
      newEvent('thing.happened', { userId: 'u1' }, at('2026-09-15T09:00:00Z')),
    );
    healthy = true;

    expect(await retryDeadLetters()).toBe(1);

    const left = await getDatabase()!.$queryRawUnsafe<{ id: string }[]>(
      'SELECT id FROM platform.event_dead_letter',
    );
    expect(left).toHaveLength(0);
  });

  /**
   * Evidence that something was dropped. Deleting it would erase the only
   * record that an event went unhandled, which is a decision for a person.
   */
  it('leaves a dead letter whose handler no longer exists', async () => {
    subscribe('thing.happened', 'gone', async () => {
      throw new Error('down');
    });
    await publish(newEvent('thing.happened', {}, at('2026-09-15T09:00:00Z')));

    resetSubscriptionsForTests();
    expect(await retryDeadLetters()).toBe(0);

    const left = await getDatabase()!.$queryRawUnsafe<{ id: string }[]>(
      'SELECT id FROM platform.event_dead_letter',
    );
    expect(left).toHaveLength(1);
  });
});
