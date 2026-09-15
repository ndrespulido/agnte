import { getDatabase } from '@/shared/infra/database';
import type { CataloguePage, DeepTimeRepository } from '../domain/ports';
import type { DeepTimeCategory, DeepTimeEvent } from '../domain/deep-time-event';
import { decodeCursor, encodeCursor } from '../domain/cursor';

interface EventRow {
  id: string;
  slug: string;
  timeline_years: number;
  title: string;
  detail: string | null;
  category: string;
}

/**
 * The cast is safe because the migration constrains `category` to the same
 * four values — the reasoning media's repository documents for `status`.
 */
const toEvent = (row: EventRow): DeepTimeEvent => ({
  id: row.id,
  slug: row.slug,
  timelineYears: row.timeline_years,
  title: row.title,
  detail: row.detail,
  category: row.category as DeepTimeCategory,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('insights requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaDeepTimeRepository implements DeepTimeRepository {
  async before(
    before: number,
    limit: number,
    cursor: string | null,
  ): Promise<CataloguePage> {
    let after = before;
    let afterId: string | null = null;

    if (cursor) {
      const decoded = decodeCursor(cursor);
      // An unreadable cursor starts the page over rather than throwing, the
      // same choice verse's timeline makes: a hard failure mid-scroll is worse
      // than a repeated page, and the API validates separately.
      if (decoded.ok) {
        after = decoded.value.years;
        afterId = decoded.value.id;
      }
    }

    // One extra row, to learn whether there is a next page without a second
    // query — a count would be a second scan and a short page is ambiguous.
    const rows = await requireDatabase().$queryRaw<EventRow[]>`
      SELECT id, slug, timeline_years, title, detail, category
      FROM insights.deep_time_event
      WHERE timeline_years < ${after}
        OR (timeline_years = ${after} AND ${afterId}::uuid IS NOT NULL
            AND id < ${afterId}::uuid)
      ORDER BY timeline_years DESC, id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      events: page.map(toEvent),
      nextCursor:
        hasMore && last
          ? encodeCursor({ years: last.timeline_years, id: last.id })
          : null,
    };
  }
}
