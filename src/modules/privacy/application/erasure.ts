import { EVENTS, newEvent, publish, subscribe, type DomainEvent } from '@/shared/events';
import { erasableUsers, hardDeleteUser, markForErasure } from '@/modules/identity';
import { purgeForUser as purgeNotifications } from '@/modules/notifications';
import { purgeForUser as purgeVerse } from '@/modules/verse';
import { purgeForUser as purgeMedia } from '@/modules/media';

/**
 * Erasure, coordinated (architecture.md §8.7).
 *
 * The shape §8.7 describes: `DELETE /v1/me` → soft delete → an event → each
 * module purges its own data → hard delete after the grace window. What makes
 * that worth the ceremony is the middle step. Privacy knows the *decision* and
 * nothing about anyone else's tables; every module answers for its own rows.
 * The alternative — one module that knows the shape of six schemas — is exactly
 * the coupling the boundaries exist to prevent, and it would rot the first time
 * anyone added a table without remembering this file.
 *
 * ---------------------------------------------------------------------------
 * On anonymising contributed Verses.
 *
 * §8.7 decides that a Verse contributed to someone else's shared tag is
 * *anonymised* rather than deleted, so one person cannot destroy another's trip
 * record. That is not implemented here, and deliberately: it currently has
 * nothing to act on. `contribute` is an open decision (CLAUDE.md), the
 * application layer refuses contribute writes until it is settled, and so no
 * Verse can exist that one person wrote onto another person's tag.
 *
 * Worth recording for whoever lands `contribute`, because implementing
 * anonymisation surfaced a real gap: `canRead` grants access by ownership, by
 * `public`, or by an explicit share row — and a tag's *owner* is not a grantee
 * of their own tag. So anonymising a Verse's `ownerId` would make it readable
 * by nobody, which is functionally the deletion the rule exists to prevent.
 * Landing `contribute` means deciding how the tag owner keeps access: a share
 * row granted at anonymisation, a transfer of ownership, or a change to the
 * visibility rule itself — the last of which is the most safety-critical
 * function in this system and should be the last resort.
 * ---------------------------------------------------------------------------
 */

export { ERASURE_GRACE_MS } from '@/modules/identity';

export interface ErasureResult {
  readonly marked: boolean;
  readonly handled: number;
  readonly deadLettered: number;
}

/**
 * Registers every module's purge against the erasure event.
 *
 * Called once at startup rather than at each publish: a subscription created
 * inside the publishing path would be registered by whichever request happened
 * to run first, and absent for any process that never published.
 *
 * Handler names are stable strings because they are half the bus's idempotency
 * key — renaming one re-runs it for every event already handled.
 */
export function registerErasureHandlers(): void {
  subscribe(EVENTS.userErasureRequested, 'verse.purge', async (event: DomainEvent) => {
    await purgeVerse(String(event.payload.userId));
  });

  subscribe(EVENTS.userErasureRequested, 'media.purge', async (event: DomainEvent) => {
    await purgeMedia(String(event.payload.userId));
  });

  subscribe(
    EVENTS.userErasureRequested,
    'notifications.purge',
    async (event: DomainEvent) => {
      await purgeNotifications(String(event.payload.userId));
    },
  );
}

/**
 * Marks the account and tells every module to purge.
 *
 * The event is published even when the account was already marked. Purges are
 * idempotent by the bus's construction, and a second request is far more likely
 * to be someone checking their first one worked than an attack — refusing it
 * outright would leave a half-erased account with no way to finish.
 */
export async function requestErasure(userId: string, now: Date): Promise<ErasureResult> {
  const marked = await markForErasure(userId, now);

  const result = await publish(newEvent(EVENTS.userErasureRequested, { userId }, now));

  return { marked, handled: result.handled, deadLettered: result.deadLettered };
}

/**
 * Removes accounts whose grace window has closed.
 *
 * Republishes the event before deleting the row rather than trusting the
 * original publish: a handler that dead-lettered thirty days ago must not be
 * the reason data survives the account it belonged to. The bus skips handlers
 * that already succeeded, so this costs nothing when everything worked.
 */
export async function sweepErasures(now: Date): Promise<number> {
  const users = await erasableUsers(now);

  let erased = 0;
  for (const userId of users) {
    const result = await publish(newEvent(EVENTS.userErasureRequested, { userId }, now));

    // A module that still cannot purge keeps the account alive for another
    // sweep. Deleting the row here would strand whatever it could not remove,
    // with nothing left to identify it by.
    if (result.deadLettered > 0) continue;

    await hardDeleteUser(userId);
    erased += 1;
  }

  return erased;
}
