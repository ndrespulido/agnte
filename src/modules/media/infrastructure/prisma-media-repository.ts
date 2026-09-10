import { getDatabase } from '@/shared/infra/database';
import type { AllowedContentType, Media, MediaStatus } from '../domain/media';
import type { MediaRepository } from '../domain/ports';
import type { MediaVariant, VariantKind } from '../domain/variant';

interface MediaRow {
  id: string;
  owner_id: string;
  status: string;
  content_type: string;
  declared_size_bytes: number;
  storage_key: string;
  created_at: Date;
  updated_at: Date;
  version: number;
}

interface VariantRow {
  media_id: string;
  kind: string;
  storage_key: string;
  width: number;
  height: number;
  size_bytes: number;
  created_at: Date;
}

/**
 * The casts are safe because the database refuses anything else — the
 * migration constrains `status` and `content_type` to closed sets, the same
 * reasoning verse's `PrismaTagRepository` documents for `visibility`.
 */
const toMedia = (row: MediaRow): Media => ({
  id: row.id,
  ownerId: row.owner_id,
  status: row.status as MediaStatus,
  contentType: row.content_type as AllowedContentType,
  declaredSizeBytes: row.declared_size_bytes,
  storageKey: row.storage_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

const toVariant = (row: VariantRow): MediaVariant => ({
  mediaId: row.media_id,
  kind: row.kind as VariantKind,
  storageKey: row.storage_key,
  width: row.width,
  height: row.height,
  sizeBytes: row.size_bytes,
  createdAt: row.created_at,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) {
    // No safe degraded mode: an upload with nowhere to record its row is not
    // a feature running in a reduced mode, it is a feature that cannot start.
    throw new Error('media requires a database; DATABASE_URL is not set');
  }
  return db;
};

/**
 * Columns are listed explicitly in every query below rather than `SELECT *` —
 * the lesson from verse's search vector, where an added column the driver
 * could not deserialize broke every read at once. A column list is a
 * contract between the query and the row type, checked again on every read
 * here rather than trusted to stay in sync.
 */
export class PrismaMediaRepository implements MediaRepository {
  async findById(id: string): Promise<Media | null> {
    const rows = await requireDatabase().$queryRaw<MediaRow[]>`
      SELECT id, owner_id, status, content_type, declared_size_bytes,
             storage_key, created_at, updated_at, version
      FROM media.media
      WHERE id = ${id}::uuid
      LIMIT 1
    `;
    return rows[0] ? toMedia(rows[0]) : null;
  }

  async findManyByIds(ownerId: string, ids: readonly string[]): Promise<Media[]> {
    if (ids.length === 0) return [];

    const rows = await requireDatabase().$queryRaw<MediaRow[]>`
      SELECT id, owner_id, status, content_type, declared_size_bytes,
             storage_key, created_at, updated_at, version
      FROM media.media
      WHERE owner_id = ${ownerId}::uuid
        AND id = ANY(${[...ids]}::uuid[])
    `;
    return rows.map(toMedia);
  }

  async create(media: Media): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO media.media
        (id, owner_id, status, content_type, declared_size_bytes, storage_key,
         created_at, updated_at, version)
      VALUES (
        ${media.id}::uuid,
        ${media.ownerId}::uuid,
        ${media.status},
        ${media.contentType},
        ${media.declaredSizeBytes},
        ${media.storageKey},
        ${media.createdAt},
        ${media.updatedAt},
        ${media.version}
      )
    `;
  }

  /**
   * Conditional on the version the caller read (architecture.md §2). The
   * status transition itself is validated in the domain before this is ever
   * called (see `modules/media/domain/media.ts`'s `transition`), so this
   * write does not re-check the state machine — it only guards against two
   * writers racing on the same row.
   */
  async update(media: Media, expectedVersion: number): Promise<boolean> {
    const updated = await requireDatabase().$executeRaw`
      UPDATE media.media
      SET status = ${media.status},
          updated_at = ${media.updatedAt},
          version = version + 1
      WHERE id = ${media.id}::uuid
        AND version = ${expectedVersion}
    `;
    return updated > 0;
  }

  async delete(id: string, expectedVersion: number): Promise<boolean> {
    // media_variant cascades from the foreign key.
    const deleted = await requireDatabase().$executeRaw`
      DELETE FROM media.media
      WHERE id = ${id}::uuid AND version = ${expectedVersion}
    `;
    return deleted > 0;
  }

  async findAbandonedPending(before: Date): Promise<Media[]> {
    const rows = await requireDatabase().$queryRaw<MediaRow[]>`
      SELECT id, owner_id, status, content_type, declared_size_bytes,
             storage_key, created_at, updated_at, version
      FROM media.media
      WHERE status = 'pending'
        AND created_at < ${before}
      -- Bounded so one run cannot try to delete a runaway backlog in a single
      -- statement; the scheduler comes back every day and takes the next slice.
      LIMIT 1000
    `;
    return rows.map(toMedia);
  }

  async findStalledProcessing(before: Date): Promise<Media[]> {
    const rows = await requireDatabase().$queryRaw<MediaRow[]>`
      SELECT id, owner_id, status, content_type, declared_size_bytes,
             storage_key, created_at, updated_at, version
      FROM media.media
      WHERE status = 'processing'
        AND updated_at < ${before}
      -- A tighter bound than findAbandonedPending's: every row here becomes a
      -- queued task, a Cloud Run request and a sharp decode, where every row
      -- there becomes one DELETE. The daily run takes the next hundred.
      LIMIT 100
    `;
    return rows.map(toMedia);
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;

    return requireDatabase().$executeRaw`
      DELETE FROM media.media WHERE id = ANY(${[...ids]}::uuid[])
    `;
  }

  async createVariant(variant: MediaVariant): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO media.media_variant
        (media_id, kind, storage_key, width, height, size_bytes, created_at)
      VALUES (
        ${variant.mediaId}::uuid,
        ${variant.kind},
        ${variant.storageKey},
        ${variant.width},
        ${variant.height},
        ${variant.sizeBytes},
        ${variant.createdAt}
      )
      -- Confirming a completed upload twice (a retried request after a lost
      -- response) must not fail the second time round trying to insert the
      -- same (media_id, kind) pair again.
      ON CONFLICT (media_id, kind) DO UPDATE SET
        storage_key = EXCLUDED.storage_key,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        size_bytes = EXCLUDED.size_bytes,
        created_at = EXCLUDED.created_at
    `;
  }

  async variantsFor(mediaId: string): Promise<MediaVariant[]> {
    const rows = await requireDatabase().$queryRaw<VariantRow[]>`
      SELECT media_id, kind, storage_key, width, height, size_bytes, created_at
      FROM media.media_variant
      WHERE media_id = ${mediaId}::uuid
      ORDER BY kind
    `;
    return rows.map(toVariant);
  }

  /**
   * The timeline's N+1 guard, same shape as verse's `tagsOfMany`: rendering a
   * page of verses means resolving every referenced media item's variants,
   * and doing that one row at a time would turn one page load into dozens of
   * queries.
   */
  async variantsForMany(
    mediaIds: readonly string[],
  ): Promise<Map<string, MediaVariant[]>> {
    const out = new Map<string, MediaVariant[]>();
    if (mediaIds.length === 0) return out;

    const rows = await requireDatabase().$queryRaw<VariantRow[]>`
      SELECT media_id, kind, storage_key, width, height, size_bytes, created_at
      FROM media.media_variant
      WHERE media_id = ANY(${[...mediaIds]}::uuid[])
      ORDER BY kind
    `;

    for (const row of rows) {
      const list = out.get(row.media_id);
      if (list) list.push(toVariant(row));
      else out.set(row.media_id, [toVariant(row)]);
    }

    return out;
  }
}
