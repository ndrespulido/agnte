import { type DomainError, type Result, err, ok } from '@/shared/kernel';
import type {
  MediaResolver,
  Page,
  SearchHit,
  SearchRepository,
  ShareRepository,
  VerseRepository,
  VisibleVerse,
} from '../domain/ports';
import { searchQueryInvalid } from '../domain/errors';
import { visibleMany } from './read-verse';

export const MAX_SEARCH_LIMIT = 100;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_TEXT_LENGTH = 200;

export interface SearchInput {
  ownerId: string;
  viewerId: string | null;
  text: string;
  limit?: number | undefined;
  cursor?: string | null | undefined;
  tagIds?: readonly string[] | undefined;
  matchAllTags?: boolean | undefined;
  ratingAtLeast?: number | null | undefined;
  from?: Date | null | undefined;
  to?: Date | null | undefined;
  hasMedia?: boolean | null | undefined;
}

export interface SearchDeps {
  verses: VerseRepository & SearchRepository;
  shares: ShareRepository;
  media: MediaResolver;
}

/**
 * Search, filtered by the same visibility resolver as every other read path.
 *
 * §8.2 names search as the single most likely place for a disclosure bug,
 * "because it's tempting to write a fast bespoke query". So the results go
 * through `visibleMany` exactly like a timeline page does — the search path
 * has nothing of its own to justify a different route.
 */
export async function searchVerses(
  input: SearchInput,
  deps: SearchDeps,
): Promise<Result<Page<VisibleVerse>, DomainError>> {
  const text = input.text.trim();

  if (text.length === 0) return err(searchQueryInvalid('it is empty'));
  if (text.length > MAX_SEARCH_TEXT_LENGTH) {
    return err(
      searchQueryInvalid(`it is longer than ${MAX_SEARCH_TEXT_LENGTH} characters`),
    );
  }

  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1),
    MAX_SEARCH_LIMIT,
  );

  const page = await deps.verses.search({
    ownerId: input.ownerId,
    viewerId: input.viewerId,
    text,
    limit,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
    ...(input.matchAllTags === undefined ? {} : { matchAllTags: input.matchAllTags }),
    ...(input.ratingAtLeast === undefined ? {} : { ratingAtLeast: input.ratingAtLeast }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
    ...(input.hasMedia === undefined ? {} : { hasMedia: input.hasMedia }),
  });

  const allowed = await visibleMany(
    page.items.map((hit: SearchHit) => hit.verse),
    input.viewerId,
    deps,
  );

  return ok({ items: allowed, nextCursor: page.nextCursor });
}
