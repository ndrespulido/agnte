import { type DomainError, type Result, err, ok } from '@/shared/kernel';
import type {
  MediaResolver,
  Page,
  ShareRepository,
  TimelineRepository,
  VerseRepository,
  VisibleVerse,
} from '../domain/ports';
import { decodeCursor } from '../domain/timeline';
import { visibleMany } from './read-verse';

export const MAX_TIMELINE_LIMIT = 100;
export const DEFAULT_TIMELINE_LIMIT = 20;

export interface TimelineInput {
  ownerId: string;
  viewerId: string | null;
  anchor: Date;
  direction: 'past' | 'future';
  limit?: number | undefined;
  cursor?: string | null | undefined;
  tagIds?: readonly string[] | undefined;
  matchAllTags?: boolean | undefined;
}

export interface TimelineDeps {
  verses: VerseRepository & TimelineRepository;
  shares: ShareRepository;
  media: MediaResolver;
}

/**
 * A page of the timeline, filtered to what the viewer may see.
 *
 * The filtering happens *after* the page is read, through `visibleMany` — the
 * same resolver every other read path uses. That means a page can come back
 * shorter than the limit, which is why `nextCursor` is authoritative rather
 * than the caller inferring exhaustion from a short page (ports.ts).
 *
 * Pushing the visibility rule down into the SQL would make pages exactly the
 * requested length, at the cost of a second implementation of the one rule this
 * module insists on having once. That trade is not close.
 */
export async function timelinePage(
  input: TimelineInput,
  deps: TimelineDeps,
): Promise<Result<Page<VisibleVerse>, DomainError>> {
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_TIMELINE_LIMIT, 1),
    MAX_TIMELINE_LIMIT,
  );

  // Validated here rather than swallowed in the repository: a caller paging
  // with a corrupted cursor should be told, not silently sent back to the
  // anchor as though they had asked for the first page again.
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor.ok) return err(cursor.error);
  }

  const page = await deps.verses.timeline({
    ownerId: input.ownerId,
    viewerId: input.viewerId,
    anchor: input.anchor,
    direction: input.direction,
    limit,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
    ...(input.matchAllTags === undefined ? {} : { matchAllTags: input.matchAllTags }),
  });

  const items = await visibleMany(page.items, input.viewerId, deps);

  return ok({ items, nextCursor: page.nextCursor });
}
