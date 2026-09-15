import { getDatabase } from '@/shared/infra/database';

/**
 * Everything this module holds about one person, for a data export (§8.5).
 *
 * Deliberately raw rather than the shape the API returns. An export is a
 * portability artefact — the point is that someone can take their data
 * elsewhere — so it carries the record as stored, including fields the read
 * path resolves away. `visibility` here is the explicit setting rather than the
 * resolved one, because the resolved value is a *derivation* and exporting it
 * as though it were stored would mislead anyone rebuilding from this.
 */
export interface VerseExport {
  readonly verses: unknown[];
  readonly tags: unknown[];
  readonly shares: unknown[];
}

export async function exportForUser(userId: string): Promise<VerseExport> {
  const db = getDatabase();
  if (!db) throw new Error('verse requires a database; DATABASE_URL is not set');

  const verses = await db.$queryRaw<unknown[]>`
    SELECT v.id, v.event_start, v.event_end, v.deep_time_years, v.location,
           v.rating, v.xp, v.properties, v.visibility, v.created_at, v.updated_at,
           COALESCE(
             (SELECT array_agg(vt.tag_id) FROM verse.verse_tag vt WHERE vt.verse_id = v.id),
             '{}'
           ) AS tag_ids,
           v.media_ids
      FROM verse.verse v
     WHERE v.owner_id = ${userId}::uuid
     ORDER BY v.created_at ASC
  `;

  const tags = await db.$queryRaw<unknown[]>`
    SELECT id, name, display_name, visibility, shortcut, vertical,
           created_at, updated_at
      FROM verse.tag
     WHERE owner_id = ${userId}::uuid
     ORDER BY name ASC
  `;

  /*
   * Shares this person granted, not shares granted to them.
   *
   * A share names another person's user id, which is *their* personal data, not
   * the exporter's. Including inbound shares would hand someone a list of who
   * has shared things with them — defensible — but outbound shares are the ones
   * that are a record of this person's own decisions, and the ids are already
   * theirs to know because they chose them.
   */
  const shares = await db.$queryRaw<unknown[]>`
    SELECT 'tag' AS kind, ts.tag_id AS subject_id, ts.grantee_id, ts.permission, ts.created_at
      FROM verse.tag_share ts
      JOIN verse.tag t ON t.id = ts.tag_id
     WHERE t.owner_id = ${userId}::uuid
     UNION ALL
    SELECT 'verse' AS kind, vs.verse_id, vs.grantee_id, vs.permission, vs.created_at
      FROM verse.verse_share vs
      JOIN verse.verse v ON v.id = vs.verse_id
     WHERE v.owner_id = ${userId}::uuid
  `;

  return { verses, tags, shares };
}
