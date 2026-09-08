import { getDatabase } from '@/shared/infra/database';
import type {
  Page,
  SearchHit,
  SearchQuery,
  SearchRepository,
  TimelineQuery,
  TimelineRepository,
  VerseRepository,
} from '../domain/ports';
import { decodeCursor, encodeCursor, timelineYears } from '../domain/timeline';
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
  timeline_years: number;
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

export class PrismaVerseRepository
  implements VerseRepository, TimelineRepository, SearchRepository
{
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
           rating, xp, properties, visibility, media_ids, timeline_years,
           created_at, updated_at, version)
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
          ${timelineYears(verse)},
          ${verse.createdAt},
          ${verse.updatedAt},
          ${verse.version}
        )
      `;

      await insertTags(tx, verse.id, verse.tagIds);

      // After the tag rows, because the vector includes tag names. Same
      // transaction, so a verse is never briefly present but unfindable.
      await refreshSearch(tx, verse.id);
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
            timeline_years = ${timelineYears(verse)},
            updated_at = ${verse.updatedAt},
            version = version + 1
        WHERE id = ${verse.id}::uuid
          AND version = ${expectedVersion}
      `;

      if (updated === 0) return false;

      await tx.$executeRaw`DELETE FROM verse.verse_tag WHERE verse_id = ${verse.id}::uuid`;
      await insertTags(tx, verse.id, verse.tagIds);
      await refreshSearch(tx, verse.id);

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

  /**
   * A page of the timeline, walked from an anchor in one direction.
   *
   * Keyset pagination, not OFFSET. The timeline is written to while it is being
   * read, and an offset shifts under the reader — page two then repeats a row
   * page one already showed. `(timeline_years, id)` is the key, and both halves
   * are needed: two verses can share a position exactly, and a cursor on
   * position alone would skip or repeat at that boundary.
   *
   * The two directions are deliberately not folded into one query with a
   * flipped comparison operator built by string concatenation. Prisma's tagged
   * template is what parameterises the values; assembling the operator into the
   * SQL text is how a query stops being a template and starts being string
   * building, and this file should never grow that habit.
   *
   * Ownership is a WHERE clause here, but it is not the access decision — the
   * application layer resolves visibility over what comes back (read-verse.ts).
   * A repository that filtered by visibility would be a second implementation
   * of the rule, which is the thing this module forbids.
   */
  async timeline(query: TimelineQuery): Promise<Page<Verse>> {
    const anchor = timelineYears({
      deepTimeYears: null,
      eventStart: query.anchor,
      createdAt: query.anchor,
    });

    let after = anchor;
    let afterId: string | null = null;

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      // An unreadable cursor is treated as "start from the anchor" rather than
      // throwing: the caller is paging, and a hard failure mid-scroll is worse
      // than a page that starts over. The API validates the cursor separately
      // and can answer 400 before reaching here.
      if (cursor.ok) {
        after = cursor.value.years;
        afterId = cursor.value.id;
      }
    }

    // One extra row, to learn whether there is a next page without a second
    // query. A count would be a second scan; a short page would be ambiguous.
    const limit = query.limit + 1;

    const tagFilter = query.tagIds && query.tagIds.length > 0 ? [...query.tagIds] : null;
    const requireAll = query.matchAllTags === true && tagFilter !== null;

    const rows =
      query.direction === 'past'
        ? await requireDatabase().$queryRaw<VerseRow[]>`
            SELECT v.* FROM verse.verse v
            WHERE v.owner_id = ${query.ownerId}::uuid
              AND (
                v.timeline_years < ${after}
                OR (v.timeline_years = ${after} AND ${afterId}::uuid IS NOT NULL
                    AND v.id < ${afterId}::uuid)
              )
              AND (${tagFilter}::uuid[] IS NULL OR EXISTS (
                SELECT 1 FROM verse.verse_tag vt
                WHERE vt.verse_id = v.id AND vt.tag_id = ANY(${tagFilter}::uuid[])
              ))
              AND (NOT ${requireAll} OR (
                SELECT count(DISTINCT vt.tag_id) FROM verse.verse_tag vt
                WHERE vt.verse_id = v.id AND vt.tag_id = ANY(${tagFilter}::uuid[])
              ) = ${tagFilter === null ? 0 : tagFilter.length})
            ORDER BY v.timeline_years DESC, v.id DESC
            LIMIT ${limit}
          `
        : await requireDatabase().$queryRaw<VerseRow[]>`
            SELECT v.* FROM verse.verse v
            WHERE v.owner_id = ${query.ownerId}::uuid
              AND (
                v.timeline_years > ${after}
                OR (v.timeline_years = ${after} AND ${afterId}::uuid IS NOT NULL
                    AND v.id > ${afterId}::uuid)
              )
              AND (${tagFilter}::uuid[] IS NULL OR EXISTS (
                SELECT 1 FROM verse.verse_tag vt
                WHERE vt.verse_id = v.id AND vt.tag_id = ANY(${tagFilter}::uuid[])
              ))
              AND (NOT ${requireAll} OR (
                SELECT count(DISTINCT vt.tag_id) FROM verse.verse_tag vt
                WHERE vt.verse_id = v.id AND vt.tag_id = ANY(${tagFilter}::uuid[])
              ) = ${tagFilter === null ? 0 : tagFilter.length})
            ORDER BY v.timeline_years ASC, v.id ASC
            LIMIT ${limit}
          `;

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    const tagsByVerse = await this.tagIdsOfMany(page.map((r) => r.id));

    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? encodeCursor({ years: last.timeline_years, id: last.id }) : null;

    return {
      items: page.map((row) => toVerse(row, tagsByVerse.get(row.id) ?? [])),
      nextCursor,
    };
  }

  /**
   * Full-text search (§8.2), with the filters composing.
   *
   * Ranked by `ts_rank_cd` over the weighted vector, so `xp` beats a property
   * value beats a tag name. Paged by `(rank, id)` rather than the timeline's
   * `(position, id)`: search results are ordered by relevance, and reusing the
   * timeline cursor here would page through a different order than the one the
   * rows came back in.
   *
   * The query text goes through `websearch_to_tsquery`, which accepts what a
   * person actually types — quoted phrases, `or`, a leading `-` to exclude —
   * and, crucially, never throws on malformed input. `to_tsquery` raises a
   * syntax error on a bare `&`, which would turn a typo into a 500.
   *
   * Ownership is a WHERE clause and is not the access decision: the application
   * layer resolves visibility over what comes back, the same as the timeline. A
   * repository filtering by visibility would be a second implementation of the
   * rule, and §8.2 names search as the single most likely place for exactly
   * that bug.
   */
  async search(query: SearchQuery): Promise<Page<SearchHit>> {
    const limit = query.limit + 1;

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    // For search the cursor's "years" slot carries the rank of the last row.
    const afterRank = cursor?.ok ? cursor.value.years : null;
    const afterId = cursor?.ok ? cursor.value.id : null;

    const tagFilter = query.tagIds && query.tagIds.length > 0 ? [...query.tagIds] : null;
    const requireAll = query.matchAllTags === true && tagFilter !== null;

    const rows = await requireDatabase().$queryRaw<(VerseRow & { rank: number })[]>`
      WITH matched AS (
        SELECT v.*, ts_rank_cd(v.search_vector, q.query) AS rank
        FROM verse.verse v,
             websearch_to_tsquery('simple', ${query.text}) AS q(query)
        WHERE v.owner_id = ${query.ownerId}::uuid
          AND v.search_vector @@ q.query
          AND (${tagFilter}::uuid[] IS NULL OR EXISTS (
            SELECT 1 FROM verse.verse_tag vt
            WHERE vt.verse_id = v.id AND vt.tag_id = ANY(${tagFilter}::uuid[])
          ))
          AND (NOT ${requireAll} OR (
            SELECT count(DISTINCT vt.tag_id) FROM verse.verse_tag vt
            WHERE vt.verse_id = v.id AND vt.tag_id = ANY(${tagFilter}::uuid[])
          ) = ${tagFilter === null ? 0 : tagFilter.length})
          AND (${query.ratingAtLeast ?? null}::double precision IS NULL
               OR v.rating >= ${query.ratingAtLeast ?? null})
          AND (${query.from ?? null}::timestamptz IS NULL
               OR coalesce(v.event_start, v.created_at) >= ${query.from ?? null})
          AND (${query.to ?? null}::timestamptz IS NULL
               OR coalesce(v.event_start, v.created_at) <= ${query.to ?? null})
          AND (${query.hasMedia ?? null}::boolean IS NULL
               OR (cardinality(v.media_ids) > 0) = ${query.hasMedia ?? null})
      )
      SELECT * FROM matched
      WHERE ${afterRank}::double precision IS NULL
         OR rank < ${afterRank}
         OR (rank = ${afterRank} AND id < ${afterId}::uuid)
      ORDER BY rank DESC, id DESC
      LIMIT ${limit}
    `;

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    const tagsByVerse = await this.tagIdsOfMany(page.map((r) => r.id));

    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? encodeCursor({ years: last.rank, id: last.id }) : null;

    return {
      items: page.map((row) => ({
        verse: toVerse(row, tagsByVerse.get(row.id) ?? []),
        rank: row.rank,
      })),
      nextCursor,
    };
  }

  /**
   * Rewrites the search vectors of every verse carrying a tag.
   *
   * Renaming `.movies` to `.films` has to make its verses findable under the
   * new name and not the old one. The vector holds tag names because §8.2 asks
   * for them, and that denormalisation is only correct if something maintains
   * it — this is that something.
   */
  async refreshSearchForTag(tagId: string): Promise<void> {
    const db = requireDatabase();
    const rows = await db.$queryRaw<{ verse_id: string }[]>`
      SELECT verse_id FROM verse.verse_tag WHERE tag_id = ${tagId}::uuid
    `;

    for (const row of rows) await refreshSearch(db, row.verse_id);
  }

  /** Tag ids only, for building a page of verses without loading whole tags. */
  private async tagIdsOfMany(
    verseIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (verseIds.length === 0) return out;

    const rows = await requireDatabase().$queryRaw<
      { verse_id: string; tag_id: string }[]
    >`
      SELECT verse_id, tag_id FROM verse.verse_tag
      WHERE verse_id = ANY(${[...verseIds]}::uuid[])
      ORDER BY position, tag_id
    `;

    for (const row of rows) {
      const list = out.get(row.verse_id);
      if (list) list.push(row.tag_id);
      else out.set(row.verse_id, [row.tag_id]);
    }

    return out;
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
   * Verses whose *only* tag is this one.
   *
   * `HAVING count(*) = 1` on the join rows for the verse, restricted to verses
   * carrying this tag. Counting the tag's own verses and subtracting would be
   * wrong: a verse with three tags including this one survives the delete.
   */
  async countVersesOnlyTaggedWith(tagId: string): Promise<number> {
    const rows = await requireDatabase().$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM (
        SELECT vt.verse_id
        FROM verse.verse_tag vt
        WHERE vt.verse_id IN (
          SELECT verse_id FROM verse.verse_tag WHERE tag_id = ${tagId}::uuid
        )
        GROUP BY vt.verse_id
        HAVING count(*) = 1
      ) AS orphaned
    `;
    return Number(rows[0]?.count ?? 0);
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
 * Rebuilds one verse's search vector from the row and its tags.
 *
 * Written here rather than as a Postgres GENERATED column because a generated
 * column may only reference its own row, and the tag names it needs live in
 * another table. That is the whole reason renaming a tag has to rewrite its
 * verses (`refreshSearchForTag`).
 *
 * Weights, highest first: `xp` is what the person actually wrote, then the
 * property values, then the tag names — so a note *about* Barcelona ranks above
 * one merely tagged `.barcelona-trip`.
 *
 * Hyphens become spaces so `.barcelona-trip` is two searchable words. Without
 * it the only query that ever matches the tag is the tag's exact full name,
 * which is the one query a user would have used the tag filter for instead.
 */
async function refreshSearch(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  verseId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE verse.verse v
    SET search_vector =
      setweight(to_tsvector('simple', coalesce(v.xp, '')), 'A') ||
      setweight(
        to_tsvector(
          'simple',
          coalesce((SELECT string_agg(value, ' ') FROM jsonb_each_text(v.properties)), '')
        ),
        'B'
      ) ||
      setweight(
        to_tsvector(
          'simple',
          coalesce(
            (
              SELECT string_agg(replace(t.name, '-', ' '), ' ')
              FROM verse.verse_tag vt
              JOIN verse.tag t ON t.id = vt.tag_id
              WHERE vt.verse_id = v.id
            ),
            ''
          )
        ),
        'C'
      )
    WHERE v.id = ${verseId}::uuid
  `;
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
