import { systemClock } from '@/shared/kernel';
import { verifyInternalRequest } from '@/shared/infra/internal-auth';
import { PrismaNotificationRepository } from '../infrastructure/prisma-notification-repository';
import { PrismaPreferenceRepository } from '../infrastructure/prisma-preference-repository';
import { EmailNotificationDelivery } from '../infrastructure/email-delivery';
import { tick } from '../application/dispatch';

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

  const result = await tick(systemClock.now(), {
    notifications: new PrismaNotificationRepository(),
    preferences: new PrismaPreferenceRepository(),
    delivery: new EmailNotificationDelivery(),
  });

  return Response.json(
    { ...result, at: systemClock.now().toISOString() },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
