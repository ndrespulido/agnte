import { getDatabase } from '@/shared/infra/database';
import { getMediaBlobStore } from '../infrastructure/blob-store';

/**
 * This person's photos, for a data export (§8.5).
 *
 * Links rather than bytes, and that is a deliberate deviation from §8.5's "JSON
 * + original media into a ZIP". Media can run to gigabytes; assembling that
 * inside a Cloud Run request means streaming a ZIP into a multipart upload with
 * bounded memory, and realistically a Cloud Run Job rather than a request,
 * because a large export outlives a request deadline. A manifest of signed URLs
 * hands over exactly the same files with none of that machinery.
 *
 * The honest cost, and the reason it is written down rather than assumed: the
 * links expire, so this is an export someone has to *act on* within the window
 * rather than an archive they can file away. The URL lifetime matches the
 * export's own.
 */
export const EXPORT_LINK_TTL_SECONDS = 24 * 60 * 60;

export interface MediaExportEntry {
  readonly id: string;
  readonly contentType: string;
  readonly createdAt: Date;
  /** Null when object storage is not configured — locally, or in a preview. */
  readonly downloadUrl: string | null;
}

export async function exportForUser(userId: string): Promise<MediaExportEntry[]> {
  const db = getDatabase();
  if (!db) throw new Error('media requires a database; DATABASE_URL is not set');

  const rows = await db.$queryRaw<
    { id: string; content_type: string; storage_key: string; created_at: Date }[]
  >`
    SELECT id, content_type, storage_key, created_at
      FROM media.media
     WHERE owner_id = ${userId}::uuid AND status = 'ready'
     ORDER BY created_at ASC
  `;

  const blobStore = getMediaBlobStore();

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      contentType: row.content_type,
      createdAt: row.created_at,
      downloadUrl: blobStore
        ? await blobStore.presignDownload(row.storage_key, EXPORT_LINK_TTL_SECONDS)
        : null,
    })),
  );
}
