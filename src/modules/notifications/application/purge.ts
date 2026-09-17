import { PrismaNotificationRepository } from '../infrastructure/prisma-notification-repository';
import { PrismaPreferenceRepository } from '../infrastructure/prisma-preference-repository';
import { PrismaPushSubscriptionRepository } from '../infrastructure/prisma-push-subscription-repository';

/**
 * Erases everything this module holds about one person (§8.7).
 *
 * This is what the module boundaries are *for*. Erasure is a fact about a
 * person that every module has to act on, and the alternative — one privacy
 * module that knows the shape of six other modules' tables — is exactly the
 * coupling the boundaries exist to prevent. Privacy publishes the event; each
 * module answers for its own rows.
 *
 * Deletion rather than anonymisation, unlike verse's contributed rows: a
 * reminder is addressed to one person and has no value to anyone else, so
 * there is no second party whose record would be destroyed by removing it.
 */
export async function purgeForUser(userId: string): Promise<{
  reminders: number;
  preferences: number;
  pushSubscriptions: number;
}> {
  const reminders = await new PrismaNotificationRepository().deleteForUser(userId);
  const preferences = await new PrismaPreferenceRepository().deleteForUser(userId);
  // A subscription is an address for reaching someone. Leaving one behind after
  // erasure would mean this deployment could still push to their phone.
  const pushSubscriptions = await new PrismaPushSubscriptionRepository().deleteForUser(
    userId,
  );
  return { reminders, preferences, pushSubscriptions };
}
