import type { Tag } from './tag';
import type { Verse } from './verse';
import type { Visibility } from './visibility';

/**
 * The ports the verse module needs (hexagonal architecture, architecture.md §1).
 *
 * Stated in the domain's vocabulary, implemented in infrastructure/. Note what
 * is *not* here: nothing takes a SQL fragment, a Prisma filter or a page of
 * rows shaped by the database. A port that leaked the query language would make
 * the visibility rule (visibility.ts) something each adapter re-decides, which
 * is the one thing this module must not allow.
 */

export interface TagRepository {
  findById(id: string): Promise<Tag | null>;
  findByName(ownerId: string, name: string): Promise<Tag | null>;
  findByShortcut(ownerId: string, shortcut: string): Promise<Tag | null>;
  findManyByIds(ownerId: string, ids: readonly string[]): Promise<Tag[]>;
  listForOwner(ownerId: string): Promise<Tag[]>;

  /** The shortcuts already spoken for, so a default can avoid them. */
  takenShortcuts(ownerId: string): Promise<Set<string>>;

  /**
   * Fails rather than throws on a name collision, for the same reason
   * identity's `createUser` does: two requests can race past a lookup and both
   * insert, and losing that race is expected rather than exceptional.
   */
  create(tag: Tag): Promise<CreateTagOutcome>;

  /**
   * An outcome rather than a boolean, for the same reason `create` has one: a
   * rename can lose to the version check *or* to either unique index, and those
   * are three different things to tell the user. Classifying a driver error is
   * the adapter's job — an application layer doing it would be reaching through
   * the port at the database underneath.
   */
  update(tag: Tag, expectedVersion: number): Promise<UpdateTagOutcome>;

  delete(id: string, expectedVersion: number): Promise<boolean>;
}

/**
 * Why a verse insert did not happen, when it did not.
 *
 * An outcome rather than a thrown error for the same reason `CreateTagOutcome`
 * is one: a client-minted id colliding is a thing the API can be asked to do
 * (§2), not a bug, and the caller has to be able to answer 409 rather than
 * letting a driver error become a 500.
 */
export type CreateVerseOutcome =
  | { kind: 'created' }
  /** The client-minted id is already a row. See `verseIdTaken`. */
  | { kind: 'id-taken' };

export type CreateTagOutcome =
  | { kind: 'created' }
  | { kind: 'name-taken' }
  | { kind: 'shortcut-taken' }
  /** The client-minted id is already a row. See `tagIdTaken` for why it is not a crash. */
  | { kind: 'id-taken' };

export type UpdateTagOutcome =
  | { kind: 'updated' }
  /** The version moved: someone else wrote first (architecture.md §2). */
  | { kind: 'stale' }
  | { kind: 'name-taken' }
  | { kind: 'shortcut-taken' };

/**
 * A page of results plus the cursor to continue from.
 *
 * `nextCursor` is null at the end of the list rather than the caller inferring
 * exhaustion from a short page — a page can legitimately come back short when
 * visibility filtering removes rows.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * How the timeline is walked.
 *
 * `anchor` is the point the timeline is centred on — today, normally — and
 * `direction` says which way this page runs from it. The timeline scrolls into
 * both past and future from a centre (CLAUDE.md), so a single "next page" would
 * not describe it.
 */
export interface TimelineQuery {
  readonly ownerId: string;
  readonly viewerId: string | null;
  readonly anchor: Date;
  readonly direction: 'past' | 'future';
  readonly limit: number;
  readonly cursor?: string | null;
  readonly tagIds?: readonly string[];
  /** All of the given tags rather than any of them. */
  readonly matchAllTags?: boolean;
  /**
   * Free text, narrowing the timeline the way tags do (§8.2).
   *
   * The same predicate `search` uses, so the timeline and the search endpoint
   * cannot disagree about what a word matches. Absent or blank is no filter.
   */
  readonly text?: string | null;
}

export interface SearchQuery {
  readonly ownerId: string;
  readonly viewerId: string | null;
  readonly text: string;
  readonly limit: number;
  readonly cursor?: string | null;
  readonly tagIds?: readonly string[];
  readonly matchAllTags?: boolean;
  readonly ratingAtLeast?: number | null;
  readonly from?: Date | null;
  readonly to?: Date | null;
  readonly hasMedia?: boolean | null;
}

/**
 * A verse the search matched.
 *
 * A wrapper around one field, deliberately kept. It used to carry a relevance
 * rank as well; substring matching has no relevance to report, and results are
 * ordered newest-first. Collapsing this to `Verse` would make the port say
 * "search returns verses" when what it returns is *hits* — and the next thing
 * a hit wants to carry (which field matched, where) has nowhere to go.
 */
export interface SearchHit {
  readonly verse: Verse;
}

export interface VerseRepository {
  findById(id: string): Promise<Verse | null>;
  create(verse: Verse): Promise<CreateVerseOutcome>;
  update(verse: Verse, expectedVersion: number): Promise<boolean>;
  delete(id: string, expectedVersion: number): Promise<boolean>;

  /**
   * Timeline and search are declared on their own interfaces below rather than
   * here. Both arrive in later tasks (2.5, 2.7), and a method on this port that
   * every adapter had to stub in the meantime would be a landmine: a stub that
   * returns an empty page is indistinguishable from a timeline with nothing on
   * it.
   */

  /** Every tag on a verse, for resolving inherited visibility. */
  tagsOf(verseId: string): Promise<Tag[]>;

  /**
   * How many verses would be left with no tags if this tag were deleted.
   *
   * The counterpart to the missing CHECK: "a verse has at least one tag" cannot
   * be a database constraint, and `ON DELETE CASCADE` on the join table is
   * perfectly happy to strip a verse's last tag. So the application asks first.
   * A count rather than a boolean because the answer is worth telling the user —
   * "3 verses have only this tag" is actionable where "cannot delete" is not.
   */
  countVersesOnlyTaggedWith(tagId: string): Promise<number>;

  /** Tags for many verses at once, keyed by verse id — the timeline's N+1 guard. */
  tagsOfMany(verseIds: readonly string[]): Promise<Map<string, Tag[]>>;
}

/** Reading the timeline (2.5). */
export interface TimelineRepository {
  timeline(query: TimelineQuery): Promise<Page<Verse>>;
}

/**
 * Text search (2.7).
 *
 * One method, and that is the point. The tsvector version needed a second —
 * `refreshSearchForTag`, to rewrite the denormalised copy of a tag's name into
 * every verse carrying it after a rename. Reading the tag names through a join
 * at query time removed the copy, and with it the obligation to maintain it:
 * a rename is now correct because nothing was duplicated, not because something
 * remembered to fix it.
 */
export interface SearchRepository {
  search(query: SearchQuery): Promise<Page<SearchHit>>;
}

/**
 * Who a tag or verse has been shared with.
 *
 * `permission` carries `contribute` even though nothing honours it yet
 * (CLAUDE.md open decision 1). Modelling it now means answering that question
 * later is a behaviour change rather than a migration; the application layer
 * refuses contribute writes until it is settled.
 */
export type SharePermission = 'read' | 'contribute';

export interface TagShare {
  readonly tagId: string;
  readonly granteeId: string;
  readonly permission: SharePermission;
  readonly createdAt: Date;
}

export interface VerseShare {
  readonly verseId: string;
  readonly granteeId: string;
  readonly permission: SharePermission;
  readonly createdAt: Date;
}

export interface ShareRepository {
  shareTag(share: TagShare): Promise<void>;
  unshareTag(tagId: string, granteeId: string): Promise<void>;
  listTagShares(tagId: string): Promise<TagShare[]>;

  shareVerse(share: VerseShare): Promise<void>;
  unshareVerse(verseId: string, granteeId: string): Promise<void>;
  listVerseShares(verseId: string): Promise<VerseShare[]>;

  /**
   * Whether a viewer holds a share reaching this verse, directly or through any
   * of its tags. One call rather than two so the read path cannot accidentally
   * check only one of the two routes.
   */
  viewerHasShare(verseId: string, viewerId: string): Promise<boolean>;

  /** The same question for many verses, keyed by verse id. */
  viewerSharesFor(verseIds: readonly string[], viewerId: string): Promise<Set<string>>;

  /** Tag ids a viewer can reach through a share, used to scope timeline reads. */
  sharedTagIdsFor(viewerId: string): Promise<Set<string>>;
}

/**
 * What a read path needs to know about one attached media item, in verse's
 * own words rather than media's. A local shape rather than importing media's
 * `MediaSummaryForVerse` type: CLAUDE.md is explicit that sharing an
 * *infrastructure* boundary (calling media's public function) is fine where
 * sharing a *domain type* across it would re-couple the modules — so this is
 * defined here and an adapter in infrastructure/ maps media's answer onto it,
 * even though the fields happen to match today.
 */
export interface VerseMedia {
  readonly id: string;
  readonly status: string;
  readonly originalUrl: string | null;
  readonly thumbUrl: string | null;
  readonly mediumUrl: string | null;
}

/** Verse's own name for "ask media whether these ids belong to this owner". */
export interface MediaOwnership {
  ownedMediaIds(
    ownerId: string,
    mediaIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

/** Verse's own name for "ask media to resolve these ids into readable links". */
export interface MediaResolver {
  resolveForVerse(ownerId: string, mediaIds: readonly string[]): Promise<VerseMedia[]>;
}

/**
 * A resolved verse as read paths hand it out: the verse, its tags, its
 * attached media, and the visibility decision already made. Bundling the
 * decision with the data is deliberate — a caller that receives a Verse alone
 * has to remember to resolve, and "remember to" is how the leak happens.
 *
 * `media` is resolved using the *verse owner's* id, always — see
 * `application/read-verse.ts`'s doc comment for why, and never the viewer's,
 * even when they are the same person for an owner viewing their own verse.
 */
export interface VisibleVerse {
  readonly verse: Verse;
  readonly tags: readonly Tag[];
  readonly media: readonly VerseMedia[];
  readonly effectiveVisibility: Visibility;
}
