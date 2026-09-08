import { getDatabase } from '@/shared/infra/database';
import type { VerseRepository } from '../domain/ports';
import type { Tag, Vertical } from '../domain/tag';
import type { Verse } from '../domain/verse';
import type { Visibility } from '../domain/visibility';

interface VerseRow {
  id: string;
  owner_id: string;
  event_start: Date | null;
  event_end: Date | null;
  deep_time_years: number | null;
  location: string | null;
  rating: number | null;
  xp: string | null;
  properties: unknown;
  visibility: string | null;
  media_ids: string[];
  created_at: Date;
  updated_at: Date;
  version: number;
}

interface TagRow {
  id: string;
  owner_id: string;
  name: string;
  display_name: string | null;
  visibility: string;
  shortcut: string | null;
  vertical: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

const toTag = (row: TagRow): Tag => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  displayName: row.display_name,
  visibility: row.visibility as Visibility,
  shortcut: row.shortcut,
  vertical: row.vertical as Vertical | null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

/**
 * Properties come back as whatever jsonb held. The column has a CHECK that it
 * is an object, so the cast is safe; the `?? {}` covers the one case the CHECK
 * permits and the type does not — SQL NULL.
 */
const toProperties = (value: unknown): Record<string, string> =>
  (value as Record<string, string> | null) ?? {};

const toVerse = (row: VerseRow, tagIds: readonly string[]): Verse => ({
  id: row.id,
  ownerId: row.owner_id,
  eventStart: row.event_start,
  eventEnd: row.event_end,
  deepTimeYears: row.deep_time_years,
  location: row.location,
  rating: row.rating,
  xp: row.xp,
  properties: Object.freeze(toProperties(row.properties)),
  visibility: row.visibility as Visibility | null,
  tagIds,
  mediaIds: row.media_ids ?? [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('verse requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaVerseRepository implements VerseRepository {
  async findById(id: string): Promise<Verse | null> {
    const db = requireDatabase();

    const rows = await db.$queryRaw<VerseRow[]>`
      SELECT * FROM verse.verse WHERE id = ${id}::uuid LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    const tagRows = await db.$queryRaw<{ tag_id: string }[]>`
      SELECT tag_id FROM verse.verse_tag
      WHERE verse_id = ${id}::uuid
      ORDER BY position, tag_id
    `;

    return toVerse(
      row,
      tagRows.map((r) => r.tag_id),
    );
  }

  /**
   * One transaction, because a Verse without its tags is not a Verse.
   *
   * "At least one tag" is the one domain rule the schema cannot hold: a CHECK
   * cannot see another table, and a trigger would fire in the window between
   * inserting the verse and inserting its first tag row. So the invariant is
   * kept by writing both inside a transaction — one aggregate, one transaction
   * (CLAUDE.md).
   */
  async create(verse: Verse): Promise<void> {
    await requireDatabase().$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO verse.verse
          (id, owner_id, event_start, event_end, deep_time_years, location,
           rating, xp, properties, visibility, media_ids, created_at, updated_at, version)
        VALUES (
          ${verse.id}::uuid,
          ${verse.ownerId}::uuid,
          ${verse.eventStart},
          ${verse.eventEnd},
          ${verse.deepTimeYears},
          ${verse.location},
          ${verse.rating},
          ${verse.xp},
          ${JSON.stringify(verse.properties)}::jsonb,
          ${verse.visibility},
          ${[...verse.mediaIds]}::uuid[],
          ${verse.createdAt},
          ${verse.updatedAt},
          ${verse.version}
        )
      `;

      await insertTags(tx, verse.id, verse.tagIds);
    });
  }

  /**
   * Conditional on the version the caller read (architecture.md §2).
   *
   * The tag rows are replaced rather than diffed: the set is small, and a
   * delete-then-insert inside the same transaction is both simpler to reason
   * about and impossible to leave half-applied. The version check is on the
   * UPDATE, so a stale writer never reaches the tag rewrite.
   */
  async update(verse: Verse, expectedVersion: number): Promise<boolean> {
    return requireDatabase().$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE verse.verse
        SET event_start = ${verse.eventStart},
            event_end = ${verse.eventEnd},
            deep_time_years = ${verse.deepTimeYears},
            location = ${verse.location},
            rating = ${verse.rating},
            xp = ${verse.xp},
            properties = ${JSON.stringify(verse.properties)}::jsonb,
            visibility = ${verse.visibility},
            media_ids = ${[...verse.mediaIds]}::uuid[],
            updated_at = ${verse.updatedAt},
            version = version + 1
        WHERE id = ${verse.id}::uuid
          AND version = ${expectedVersion}
      `;

      if (updated === 0) return false;

      await tx.$executeRaw`DELETE FROM verse.verse_tag WHERE verse_id = ${verse.id}::uuid`;
      await insertTags(tx, verse.id, verse.tagIds);

      return true;
    });
  }

  async delete(id: string, expectedVersion: number): Promise<boolean> {
    // verse_tag and verse_share cascade from the foreign key.
    const deleted = await requireDatabase().$executeRaw`
      DELETE FROM verse.verse
      WHERE id = ${id}::uuid AND version = ${expectedVersion}
    `;
    return deleted > 0;
  }

  async tagsOf(verseId: string): Promise<Tag[]> {
    const rows = await requireDatabase().$queryRaw<TagRow[]>`
      SELECT t.* FROM verse.tag t
      JOIN verse.verse_tag vt ON vt.tag_id = t.id
      WHERE vt.verse_id = ${verseId}::uuid
      ORDER BY vt.position, t.id
    `;
    return rows.map(toTag);
  }

  /**
   * The N+1 guard for read paths.
   *
   * A timeline page resolves visibility for every verse on it, and visibility
   * is inherited from tags — so without this, rendering twenty verses would be
   * twenty-one queries.
   */
  async tagsOfMany(verseIds: readonly string[]): Promise<Map<string, Tag[]>> {
    const out = new Map<string, Tag[]>();
    if (verseIds.length === 0) return out;

    const rows = await requireDatabase().$queryRaw<(TagRow & { verse_id: string })[]>`
      SELECT t.*, vt.verse_id FROM verse.tag t
      JOIN verse.verse_tag vt ON vt.tag_id = t.id
      WHERE vt.verse_id = ANY(${[...verseIds]}::uuid[])
      ORDER BY vt.position, t.id
    `;

    for (const row of rows) {
      const list = out.get(row.verse_id);
      if (list) list.push(toTag(row));
      else out.set(row.verse_id, [toTag(row)]);
    }

    return out;
  }
}

/**
 * `position` records the order the user attached the tags in, which is the
 * order they read best in. Written as one multi-row insert rather than a loop,
 * so a verse with eight tags is one round trip rather than eight.
 */
async function insertTags(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  verseId: string,
  tagIds: readonly string[],
): Promise<void> {
  if (tagIds.length === 0) return;

  const positions = tagIds.map((_, index) => index);

  await tx.$executeRaw`
    INSERT INTO verse.verse_tag (verse_id, tag_id, position)
    SELECT ${verseId}::uuid, tag_id, position
    FROM unnest(${[...tagIds]}::uuid[], ${positions}::int[]) AS t(tag_id, position)
  `;
}
