import { getDatabase } from '@/shared/infra/database';
import type {
  ShareRepository,
  SharePermission,
  TagShare,
  VerseShare,
} from '../domain/ports';

interface TagShareRow {
  tag_id: string;
  grantee_id: string;
  permission: string;
  created_at: Date;
}

interface VerseShareRow {
  verse_id: string;
  grantee_id: string;
  permission: string;
  created_at: Date;
}

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('verse requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaShareRepository implements ShareRepository {
  /**
   * Upsert rather than insert.
   *
   * Re-sharing something with someone who already has it is not an error, it is
   * the same request arriving twice — which on a mobile network it will. The
   * permission is updated so changing someone from read to contribute is the
   * same call.
   */
  async shareTag(share: TagShare): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO verse.tag_share (tag_id, grantee_id, permission, created_at)
      VALUES (${share.tagId}::uuid, ${share.granteeId}::uuid, ${share.permission}, ${share.createdAt})
      ON CONFLICT (tag_id, grantee_id)
      DO UPDATE SET permission = EXCLUDED.permission
    `;
  }

  async unshareTag(tagId: string, granteeId: string): Promise<void> {
    await requireDatabase().$executeRaw`
      DELETE FROM verse.tag_share
      WHERE tag_id = ${tagId}::uuid AND grantee_id = ${granteeId}::uuid
    `;
  }

  async listTagShares(tagId: string): Promise<TagShare[]> {
    const rows = await requireDatabase().$queryRaw<TagShareRow[]>`
      SELECT * FROM verse.tag_share WHERE tag_id = ${tagId}::uuid ORDER BY created_at
    `;
    return rows.map((row) => ({
      tagId: row.tag_id,
      granteeId: row.grantee_id,
      permission: row.permission as SharePermission,
      createdAt: row.created_at,
    }));
  }

  async shareVerse(share: VerseShare): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO verse.verse_share (verse_id, grantee_id, permission, created_at)
      VALUES (${share.verseId}::uuid, ${share.granteeId}::uuid, ${share.permission}, ${share.createdAt})
      ON CONFLICT (verse_id, grantee_id)
      DO UPDATE SET permission = EXCLUDED.permission
    `;
  }

  async unshareVerse(verseId: string, granteeId: string): Promise<void> {
    await requireDatabase().$executeRaw`
      DELETE FROM verse.verse_share
      WHERE verse_id = ${verseId}::uuid AND grantee_id = ${granteeId}::uuid
    `;
  }

  async listVerseShares(verseId: string): Promise<VerseShare[]> {
    const rows = await requireDatabase().$queryRaw<VerseShareRow[]>`
      SELECT * FROM verse.verse_share WHERE verse_id = ${verseId}::uuid ORDER BY created_at
    `;
    return rows.map((row) => ({
      verseId: row.verse_id,
      granteeId: row.grantee_id,
      permission: row.permission as SharePermission,
      createdAt: row.created_at,
    }));
  }

  /**
   * Both routes in one query.
   *
   * A viewer can reach a verse through a share on the verse itself or through a
   * share on any of its tags. Answering with two calls would let a caller check
   * one and forget the other; a UNION makes "is this reachable?" a single
   * question with a single answer.
   */
  async viewerHasShare(verseId: string, viewerId: string): Promise<boolean> {
    const rows = await requireDatabase().$queryRaw<{ found: number }[]>`
      SELECT 1 AS found
      FROM verse.verse_share
      WHERE verse_id = ${verseId}::uuid AND grantee_id = ${viewerId}::uuid
      UNION ALL
      SELECT 1
      FROM verse.tag_share ts
      JOIN verse.verse_tag vt ON vt.tag_id = ts.tag_id
      WHERE vt.verse_id = ${verseId}::uuid AND ts.grantee_id = ${viewerId}::uuid
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async viewerSharesFor(
    verseIds: readonly string[],
    viewerId: string,
  ): Promise<Set<string>> {
    if (verseIds.length === 0) return new Set();

    const rows = await requireDatabase().$queryRaw<{ verse_id: string }[]>`
      SELECT verse_id
      FROM verse.verse_share
      WHERE verse_id = ANY(${[...verseIds]}::uuid[]) AND grantee_id = ${viewerId}::uuid
      UNION
      SELECT vt.verse_id
      FROM verse.tag_share ts
      JOIN verse.verse_tag vt ON vt.tag_id = ts.tag_id
      WHERE vt.verse_id = ANY(${[...verseIds]}::uuid[]) AND ts.grantee_id = ${viewerId}::uuid
    `;
    return new Set(rows.map((r) => r.verse_id));
  }

  async sharedTagIdsFor(viewerId: string): Promise<Set<string>> {
    const rows = await requireDatabase().$queryRaw<{ tag_id: string }[]>`
      SELECT tag_id FROM verse.tag_share WHERE grantee_id = ${viewerId}::uuid
    `;
    return new Set(rows.map((r) => r.tag_id));
  }
}
