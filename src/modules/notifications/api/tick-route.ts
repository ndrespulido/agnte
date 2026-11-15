import { systemClock } from '@/shared/kernel';
import { verifyInternalRequest } from '@/shared/infra/internal-auth';
import { PrismaNotificationRepository } from '../infrastructure/prisma-notification-repository';
import { PrismaPreferenceRepository } from '../infrastructure/prisma-preference-repository';
import { EmailNotificationDelivery } from '../infrastructure/email-delivery';
import { PrismaPushSubscriptionRepository } from '../infrastructure/prisma-push-subscription-repository';
import { PushWithEmailFallback } from '../infrastructure/push-delivery';
import { tick, type TickResult } from '../application/dispatch';
import { getWakeUps } from '../infrastructure/wake-ups';

/**
 * The five-minute tick (§8.4).
 *
 * Guarded by the same shared secret as every other `/internal/*` route and for
 * the same reason: Cloud Run runs this service `--allow-unauthenticated` so a
 * preview URL opens on a phone with no Google account, which means IAM cannot
 * gate a subset of routes.
 *
 * Returns the counts rather than 204. A scheduled job that answers "OK" tells
 * you nothing when it has quietly stopped doing any work — the retention sweep
 * makes the same choice, for the same reason.
 */
export async function handleNotificationsTick(request: Request): Promise<Response> {
  const auth = verifyInternalRequest(request);
  if (!auth.ok) return auth.response;

  const result = await runReminderTick(systemClock.now());

  return Response.json(
    { ...result, at: systemClock.now().toISOString() },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * One tick with the production adapters.
 *
 * Its own function because there are two entry points: the wake-up route
 * above, and the daily sweep (`/internal/prune`), which runs a tick as the
 * safety net for a wake-up that was lost — and whose tick is also what
 * schedules reminders that were further out than the wake horizon when they
 * were created.
 */
export function runReminderTick(now: Date): Promise<TickResult> {
  return tick(now, {
    notifications: new PrismaNotificationRepository(),
    preferences: new PrismaPreferenceRepository(),
    // Push first, email behind it (§8.4). The dispatcher is unchanged: both
    // are the same port, and it still counts attempts and decides on retries.
    delivery: new PushWithEmailFallback(
      new PrismaPushSubscriptionRepository(),
      new EmailNotificationDelivery(),
    ),
    wakeUps: getWakeUps(),
  });
}
