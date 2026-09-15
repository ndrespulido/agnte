import { getDatabase } from '@/shared/infra/database';
import { getMediaBlobStore } from '../infrastructure/blob-store';
import { PrismaMediaRepository } from '../infrastructure/prisma-media-repository';

/**
 * Erases everything this module holds about one person (§8.7).
 *
 * The only purge that has to reach outside Postgres: photos live in R2, and a
 * row deleted without its object leaves the bytes sitting in a bucket, which is
 * precisely what someone asking to be forgotten is asking not to happen.
 *
 * Objects are removed *before* the rows, which is the opposite of what the
 * abandoned-upload pruner does, and the difference is deliberate. There, an
 * orphaned object is a tidiness problem and clearing rows matters more. Here,
 * an orphaned object is undeleted personal data and the row is the only thing
 * that knows its storage key — delete the row first and a failure afterwards
 * leaves bytes nobody can find, let alone erase.
 *
 * So a storage failure aborts, loudly. The erasure event dead-letters, the
 * account keeps its grace window, and the sweep tries again — which is the
 * behaviour that ends with the data actually gone.
 */
export async function purgeForUser(userId: string): Promise<{
  media: number;
  objects: number;
}> {
  const db = getDatabase();
  if (!db) throw new Error('media requires a database; DATABASE_URL is not set');

  const rows = await db.$queryRaw<{ id: string; storage_key: string }[]>`
    SELECT id, storage_key FROM media.media WHERE owner_id = ${userId}::uuid
  `;
  if (rows.length === 0) return { media: 0, objects: 0 };

  // Variants are separate objects in storage even though their rows cascade.
  const variants = await db.$queryRaw<{ storage_key: string }[]>`
    SELECT v.storage_key
      FROM media.media_variant v
      JOIN media.media m ON m.id = v.media_id
     WHERE m.owner_id = ${userId}::uuid
  `;

  const blobStore = getMediaBlobStore();
  let objects = 0;

  if (blobStore) {
    const keys = [
      ...rows.map((r) => r.storage_key),
      ...variants.map((v) => v.storage_key),
    ];
    for (const key of keys) {
      // Not caught: see above. A failure here must stop the purge rather than
      // let the rows go and strand the bytes.
      await blobStore.delete(key);
      objects += 1;
    }
  }

  const media = await new PrismaMediaRepository().deleteMany(rows.map((r) => r.id));

  return { media, objects };
}
