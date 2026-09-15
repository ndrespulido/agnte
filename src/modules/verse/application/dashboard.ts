import { type DomainError, type Result, err, ok } from '@/shared/kernel';
import type {
  MediaResolver,
  ShareRepository,
  TagRepository,
  TimelineRepository,
  VerseRepository,
} from '../domain/ports';
import { forbidden } from '../domain/errors';
import type { Tag } from '../domain/tag';
import { type SummaryInput, type TagSummary, summarise } from '../domain/summary';
import { visibleMany } from './read-verse';
import { MAX_TIMELINE_LIMIT } from './timeline';

/**
 * How many verses a dashboard will read before it stops and says so.
 *
 * This exists because the aggregation is done in application code rather than
 * in SQL, which is not a shortcut — see `domain/summary.ts` for why a `COUNT`
 * here would mean a second visibility predicate, and architecture.md §2 for why
 * there is exactly one.
 *
 * The cost of that choice is that a dashboard reads every row it counts, so it
 * needs a ceiling. Twenty pages is far past any tag a person accumulates in a
 * few years, and a tag that exceeds it gets a truthful "counted the most recent
 * 2000" rather than a number quietly computed from part of the data.
 */
export const DASHBOARD_VERSE_CAP = 2000;

export interface DashboardInput {
  readonly ownerId: string;
  readonly viewerId: string | null;
  readonly tagId: string;
  /** The centre to walk outwards from. Defaults to now; injected for tests. */
  readonly now: Date;
}

export interface DashboardDeps {
  readonly verses: VerseRepository & TimelineRepository;
  readonly tags: TagRepository;
  readonly shares: ShareRepository;
  readonly media: MediaResolver;
}

export interface Dashboard {
  readonly tag: Tag;
  readonly summary: TagSummary;
  /** True when the tag holds more verses than `DASHBOARD_VERSE_CAP`. */
  readonly truncated: boolean;
}

/**
 * Walks one direction of the timeline to exhaustion, or to what is left of the
 * budget.
 *
 * Reuses `timeline()` rather than adding a "read every verse with this tag"
 * repository method, and that is the point: the timeline query already knows
 * how to filter by tag and how to page, and every page it returns goes through
 * `visibleMany`. A new method would be a second way into the same rows, which
 * is how the second visibility predicate gets written by accident.
 */
async function walk(
  direction: 'past' | 'future',
  budget: number,
  input: DashboardInput,
  deps: DashboardDeps,
): Promise<{ rows: SummaryInput[]; exhausted: boolean }> {
  const rows: SummaryInput[] = [];
  let cursor: string | null = null;
  let remaining = budget;

  while (remaining > 0) {
    const page = await deps.verses.timeline({
      ownerId: input.ownerId,
      viewerId: input.viewerId,
      anchor: input.now,
      direction,
      limit: Math.min(remaining, MAX_TIMELINE_LIMIT),
      cursor,
      tagIds: [input.tagId],
    });

    // Filtered before counting, never after. A page can come back shorter than
    // asked for because rows the viewer may not see are dropped here, which is
    // why the cursor rather than the page length decides whether to continue.
    const visible = await visibleMany(page.items, input.viewerId, deps);
    for (const row of visible) {
      rows.push({
        verse: row.verse,
        tags: row.tags,
        mediaCount: row.media.length,
      });
    }

    // Against the rows *read*, not the rows kept: the budget is a bound on work
    // done, and filtered-out rows cost the same query to find.
    remaining -= page.items.length;

    if (!page.nextCursor) return { rows, exhausted: true };
    cursor = page.nextCursor;
  }

  return { rows, exhausted: false };
}

/**
 * A tag's dashboard: what is in it, over what span, rated how, adding up to what.
 *
 * The timeline runs both ways from today (CLAUDE.md), so a tag's verses sit on
 * both sides of the anchor and both sides have to be walked. A tag holding a
 * booked flight and last year's receipts would otherwise report only half of
 * itself, and — worse — report it without saying so.
 */
export async function tagDashboard(
  input: DashboardInput,
  deps: DashboardDeps,
): Promise<Result<Dashboard, DomainError>> {
  const tag = await deps.tags.findById(input.tagId);

  // `forbidden()` for a tag that is not this owner's, the same as for one that
  // does not exist. Telling the two apart would let anyone confirm which tag
  // ids are real (read-verse.ts makes the same trade for the same reason).
  if (!tag || tag.ownerId !== input.ownerId) return err(forbidden());

  const past = await walk('past', DASHBOARD_VERSE_CAP, input, deps);
  const future = await walk(
    'future',
    DASHBOARD_VERSE_CAP - past.rows.length,
    input,
    deps,
  );

  return ok({
    tag,
    summary: summarise([...past.rows, ...future.rows], tag.id),
    truncated: !past.exhausted || !future.exhausted,
  });
}
