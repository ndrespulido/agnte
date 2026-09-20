/**
 * Filtering the timeline by tag.
 *
 * A tag is already a filterable sub-timeline in the domain (CLAUDE.md) — this
 * is that idea reaching the screen. The filter narrows the timeline in place
 * rather than opening a separate view, so the date column, the two-directional
 * scroll and the sticky header all keep working and only the contents change.
 *
 * The rules here are small and easy to break silently, which is why they are
 * pure functions with tests rather than conditions buried in a component.
 */

/**
 * Whether the shared deep-time catalogue belongs under the current filter.
 *
 * The catalogue is the global run of historical events every user sees once
 * their own past runs out (CLAUDE.md) — the Big Bang, the moon landing. It is
 * nobody's data and carries none of anyone's tags.
 *
 * So under a filter it is simply wrong: someone narrowing to `.flight` is
 * asking what they have filed under `.flight`, and answering with the printing
 * press is answering a question they did not ask. Worse, it reads as though
 * those events were somehow tagged.
 *
 * The same goes for a text filter, and for the same reason: someone searching
 * "olives" is asking what they wrote, and the moon landing is not an answer.
 *
 * Unfiltered, it stays exactly as it was.
 */
export const showsCatalogue = (tagIds: readonly string[], text = ''): boolean =>
  tagIds.length === 0 && text.trim() === '';

/**
 * Adds or removes a tag from the filter.
 *
 * Toggling rather than replacing, because the filter is a set: tapping
 * `.barcelona-trip` and then `.restaurant` means "both", which is what the
 * timeline query does with several tags. Order is preserved so the chips do
 * not rearrange themselves as they are added.
 */
export function toggleFilterTag(
  tagIds: readonly string[],
  tagId: string,
): readonly string[] {
  return tagIds.includes(tagId)
    ? tagIds.filter((id) => id !== tagId)
    : [...tagIds, tagId];
}

/**
 * What the timeline says when a filter matches nothing.
 *
 * Its own sentence rather than the unfiltered empty state, because the two
 * mean opposite things: "you have not written anything yet" is an invitation,
 * and saying it to someone with a full timeline who has just narrowed to a tag
 * reads as though their record had been lost.
 */
export function emptyMessage(
  tagIds: readonly string[],
  labels: readonly string[],
  text = '',
): string {
  const typed = text.trim();

  if (tagIds.length === 0 && typed === '') {
    return 'Nothing on the timeline yet. Add the first verse with the button below.';
  }

  // Named rather than counted: "Nothing under 2 tags" makes someone go back and
  // look at the chips to find out which two.
  const named = labels.join(' and ');

  if (typed !== '' && named !== '') return `Nothing under ${named} matches “${typed}”.`;
  if (typed !== '') return `Nothing matches “${typed}”.`;
  return named === '' ? 'Nothing filed under that tag.' : `Nothing filed under ${named}.`;
}
