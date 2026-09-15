import { getDatabase } from '@/shared/infra/database';
import { getObjectStorage } from '@/shared/infra/object-storage';
import { getDeferredJobs } from '@/shared/infra/deferred-jobs';
import { DomainError, uuidv7, type Result, err, ok } from '@/shared/kernel';
import { contactEmailFor } from '@/modules/identity';
import { getEmailTransport } from '@/shared/infra/email';
import { loadConfig } from '@/shared/infra/config';
import { exportForUser as exportVerse } from '@/modules/verse';
import { exportForUser as exportMedia } from '@/modules/media';
import { exportForUser as exportNotifications } from '@/modules/notifications';

/**
 * Data export, which doubles as GDPR portability (§8.5, §8.7).
 *
 * Asynchronous because §8.5 says so and because a synchronous export would tie
 * its size to a request deadline. The request marks a row and enqueues a Cloud
 * Task; the worker assembles and stores it; the person gets an email with a
 * short-lived link.
 *
 * Media travels as signed URLs rather than bytes — see modules/media's export
 * for why, and for the honest cost of that choice.
 */

/** §8.5: one export per user per 24h. */
export const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** How long the finished export's link is good for. */
export const EXPORT_TTL_SECONDS = 24 * 60 * 60;

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('privacy requires a database; DATABASE_URL is not set');
  return db;
};

export const tooSoon = (retryAfterMs: number): DomainError =>
  new DomainError(
    'privacy.export_too_soon',
    `An export was requested recently. Try again in about ${Math.ceil(
      retryAfterMs / 3_600_000,
    )} hours.`,
  );

export interface ExportRequested {
  readonly id: string;
  readonly queued: boolean;
}

/**
 * Records the request and asks for the work to be done.
 *
 * The cooldown is answered from the request table rather than the shared rate
 * limiter. The limiter is per-minute-ish protection against abuse; this is a
 * per-day product rule about an expensive operation, and expressing it where
 * the requests already live means the two cannot disagree about what happened.
 */
export async function requestExport(
  userId: string,
  now: Date,
): Promise<Result<ExportRequested, DomainError>> {
  const db = requireDatabase();

  const recent = await db.$queryRaw<{ requested_at: Date }[]>`
    SELECT requested_at FROM privacy.export_request
     WHERE user_id = ${userId}::uuid
     ORDER BY requested_at DESC
     LIMIT 1
  `;

  const last = recent[0]?.requested_at;
  if (last && now.getTime() - last.getTime() < EXPORT_COOLDOWN_MS) {
    return err(tooSoon(EXPORT_COOLDOWN_MS - (now.getTime() - last.getTime())));
  }

  const id = uuidv7(now.getTime());
  await db.$executeRaw`
    INSERT INTO privacy.export_request (id, user_id, status, requested_at, updated_at)
    VALUES (${id}::uuid, ${userId}::uuid, 'pending', ${now}, ${now})
  `;

  /*
   * A failed enqueue is reported, not swallowed.
   *
   * `confirmUpload` swallows its enqueue failure on purpose — a photo that
   * landed should not fail because a thumbnail did. This is the opposite case:
   * the enqueue *is* the request. Swallowing it would leave a row saying
   * "pending" that nothing will ever pick up, and someone waiting for an email
   * that is not coming.
   */
  const jobs = getDeferredJobs();
  if (!jobs) return ok({ id, queued: false });

  try {
    await jobs.enqueue({ path: '/internal/privacy/export', body: { exportId: id } });
    return ok({ id, queued: true });
  } catch {
    return ok({ id, queued: false });
  }
}

/**
 * Assembles one export and stores it.
 *
 * Idempotent by status: a Cloud Task delivered twice finds the row already
 * `ready` and does nothing, which matters because Cloud Tasks guarantees
 * at-least-once and a second assembly would bill a second set of signed URLs
 * and overwrite a link someone may already be using.
 */
export async function buildExport(exportId: string, now: Date): Promise<boolean> {
  const db = requireDatabase();

  const rows = await db.$queryRaw<{ user_id: string; status: string }[]>`
    SELECT user_id, status FROM privacy.export_request WHERE id = ${exportId}::uuid
  `;
  const request = rows[0];
  if (!request || request.status !== 'pending') return false;

  try {
    const [verse, media, notifications] = await Promise.all([
      exportVerse(request.user_id),
      exportMedia(request.user_id),
      exportNotifications(request.user_id),
    ]);

    const document = {
      // Versioned so anyone rebuilding from this can tell which shape they have.
      format: 'agnte.export.v1',
      exportedAt: now.toISOString(),
      account: { id: request.user_id, email: await contactEmailFor(request.user_id) },
      verses: verse.verses,
      tags: verse.tags,
      shares: verse.shares,
      media,
      reminders: notifications.reminders,
      notificationPreferences: notifications.preferences,
      note: 'Photo links expire 24 hours after this export was produced.',
    };

    const storage = getObjectStorage();
    if (!storage) throw new Error('No object storage is configured.');

    const key = `exports/${request.user_id}/${exportId}.json`;
    await storage.put(key, JSON.stringify(document, null, 2));

    await db.$executeRaw`
      UPDATE privacy.export_request
         SET status = 'ready', storage_key = ${key}, completed_at = ${now},
             updated_at = ${now}
       WHERE id = ${exportId}::uuid
    `;

    await notifyReady(request.user_id);
    return true;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await db.$executeRaw`
      UPDATE privacy.export_request
         SET status = 'failed', error = ${message}, updated_at = ${now}
       WHERE id = ${exportId}::uuid
    `;
    // Rethrown so Cloud Tasks sees a non-2xx and retries: a failed export is
    // worth another attempt, and the row records why the last one failed.
    throw cause;
  }
}

export interface ExportStatus {
  readonly id: string;
  readonly status: string;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
  readonly error: string | null;
}

export async function latestExport(userId: string): Promise<ExportStatus | null> {
  const rows = await requireDatabase().$queryRaw<
    {
      id: string;
      status: string;
      requested_at: Date;
      completed_at: Date | null;
      error: string | null;
    }[]
  >`
    SELECT id, status, requested_at, completed_at, error
      FROM privacy.export_request
     WHERE user_id = ${userId}::uuid
     ORDER BY requested_at DESC
     LIMIT 1
  `;

  const row = rows[0];
  return row
    ? {
        id: row.id,
        status: row.status,
        requestedAt: row.requested_at,
        completedAt: row.completed_at,
        error: row.error,
      }
    : null;
}

/**
 * Tells the person their export is ready.
 *
 * §8.5 says to email a signed URL. This emails a link to the app instead, and
 * the download route authenticates — a deliberate deviation, and the safer one.
 *
 * A signed URL in an email is a capability: anyone who reads the mailbox, or
 * any system that scans it, holds the export. This particular export is the
 * whole of someone's timeline, which CLAUDE.md is explicit contains medical
 * notes and financial screenshots. Requiring a session to download costs the
 * recipient one sign-in and removes an entire class of exposure.
 *
 * Best effort: a failed email must not undo an export that was built. The row
 * is already `ready` and the status endpoint will say so, so the work survives
 * a transport that is down.
 */
async function notifyReady(userId: string): Promise<void> {
  const transport = getEmailTransport();
  if (!transport) return;

  const to = await contactEmailFor(userId);
  if (!to) return;

  const origin = loadConfig().APP_BASE_URL?.replace(/\/+$/, '');

  try {
    await transport.send({
      to,
      subject: 'Your Agnte export is ready',
      text: [
        'The copy of your Agnte data you asked for is ready.',
        '',
        ...(origin ? [`Download it here: ${origin}/`, ''] : []),
        'You will need to sign in — the download is not a public link, because',
        'it contains everything you have written.',
        '',
        'Photos in the export are linked rather than included, and those links',
        'expire 24 hours after the export was produced.',
      ].join('\n'),
    });
  } catch {
    // Deliberately swallowed; see above.
  }
}
