/**
 * Who may see a Verse.
 *
 * This file is the *only* place in the system that decides that question
 * (CLAUDE.md; architecture.md §2). Every read path — timeline, tag filter,
 * search, dashboard, export — resolves through `resolveVisibility` rather than
 * building its own predicate. The rule is small enough that reimplementing it
 * inline always looks reasonable, which is exactly why it must not be: this app
 * stores medical notes and bank screenshots, and the failure mode of a second,
 * subtly different copy is disclosure.
 */

/**
 * Ordered most restrictive first. The order is the semantics — `resolve` below
 * is a minimum over this scale — so it is declared once here rather than
 * implied by comparisons scattered around.
 */
export const VISIBILITY_ORDER = ['private', 'shared', 'public'] as const;

export type Visibility = (typeof VISIBILITY_ORDER)[number];

/**
 * The safe answer when nothing else is known.
 *
 * Named rather than written as a literal at each use, so that "what happens
 * when we cannot tell?" has exactly one answer and grepping for it finds every
 * caller.
 */
export const DEFAULT_VISIBILITY: Visibility = 'private';

const RANK: Record<Visibility, number> = {
  private: 0,
  shared: 1,
  public: 2,
};

export const isVisibility = (value: unknown): value is Visibility =>
  typeof value === 'string' && (VISIBILITY_ORDER as readonly string[]).includes(value);

/**
 * The more restrictive of two visibilities.
 *
 * Note the direction: this is a *minimum*, never a maximum. Combining
 * permissions by taking the more permissive side is the classic way an access
 * rule leaks, and writing it as `Math.min` over an explicit rank makes the
 * direction hard to invert by accident.
 */
export const moreRestrictive = (a: Visibility, b: Visibility): Visibility =>
  RANK[a] <= RANK[b] ? a : b;

/** True when `actual` is at least as permissive as `required`. */
export const atLeast = (actual: Visibility, required: Visibility): boolean =>
  RANK[actual] >= RANK[required];

/**
 * A Verse's effective visibility.
 *
 * Two rules, in order (CLAUDE.md):
 *
 *  1. An explicit setting on the Verse wins outright. Someone who marked a
 *     single Verse private meant it, and no tag may widen that.
 *  2. Otherwise the Verse inherits the **most restrictive** visibility among
 *     its tags. A photo tagged both `.holiday` (public) and `.medical`
 *     (private) resolves to private. This is the mis-tag case CLAUDE.md calls
 *     out: one wrong tag must never be able to publish something.
 *
 * With no explicit setting and no tags there is nothing to inherit from, so the
 * answer is `private` — fail closed.
 *
 * @param explicit The Verse's own setting, or null to inherit.
 * @param tagVisibilities Visibility of every tag the Verse carries, in any
 *                        order. An empty list is not an error; it means there
 *                        is nothing to inherit.
 */
export function resolveVisibility(
  explicit: Visibility | null,
  tagVisibilities: readonly Visibility[],
): Visibility {
  if (explicit !== null) return explicit;
  if (tagVisibilities.length === 0) return DEFAULT_VISIBILITY;
  return tagVisibilities.reduce(moreRestrictive);
}

/**
 * Whether a Verse is readable by a given viewer.
 *
 * Separate from `resolveVisibility` because they answer different questions:
 * one is a property of the Verse, the other a decision about a request. Callers
 * that only need to *display* a badge want the former; anything gating data
 * wants this.
 *
 * `shared` is deliberately not readable here on visibility alone — it means
 * "shared with specific people", and who those people are lives in the share
 * tables (2.6). Until that is passed in, treating `shared` as readable by
 * anyone signed in would be the leak. So the caller supplies the answer to
 * "is this viewer on the share list?" and this function combines the two.
 */
export function canRead(input: {
  ownerId: string;
  viewerId: string | null;
  effective: Visibility;
  /** True when the viewer holds an explicit share on the Verse or one of its tags. */
  viewerHasShare?: boolean;
}): boolean {
  if (input.viewerId !== null && input.viewerId === input.ownerId) return true;
  if (input.effective === 'public') return true;
  if (input.effective === 'shared') return input.viewerHasShare === true;
  return false;
}
