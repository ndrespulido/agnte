import { DomainError } from '@/shared/kernel';
import { getObjectStorage } from '@/shared/infra/object-storage';
import { getDatabase } from '@/shared/infra/database';
import { jsonError } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';

/**
 * `GET /v1/privacy/export/download` — the finished export.
 *
 * Authenticated rather than a signed URL, which is a deliberate deviation from
 * §8.5: a signed link in an email is a capability anyone reading that mailbox
 * holds, and this file is the whole of someone's timeline. See `notifyReady`
 * in the application layer for the full reasoning.
 *
 * The storage key is never accepted from the caller and never returned: the row
 * is looked up by the authenticated user, so there is no id to guess and no
 * path to traverse.
 */
export async function handleDownloadExport(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const db = getDatabase();
  if (!db) {
    return jsonError(new DomainError('unavailable', 'No database is configured.'), 503);
  }

  const rows = await db.$queryRaw<{ storage_key: string | null }[]>`
    SELECT storage_key FROM privacy.export_request
     WHERE user_id = ${auth.userId}::uuid AND status = 'ready'
     ORDER BY requested_at DESC
     LIMIT 1
  `;

  const key = rows[0]?.storage_key;
  if (!key) {
    return jsonError(
      new DomainError('privacy.no_export', 'There is no export ready to download.'),
      404,
    );
  }

  const storage = getObjectStorage();
  const body = storage ? await storage.get(key) : undefined;

  if (body === undefined) {
    // The row says ready and the object is gone — a retention rule that ran, or
    // a bucket someone emptied. Said plainly rather than as a 500.
    return jsonError(
      new DomainError('privacy.export_expired', 'That export is no longer available.'),
      410,
    );
  }

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="agnte-export.json"',
      'cache-control': 'no-store',
    },
  });
}
