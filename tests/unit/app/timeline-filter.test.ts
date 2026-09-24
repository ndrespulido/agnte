import { describe, expect, it } from 'vitest';
import {
  emptyMessage,
  showsCatalogue,
  toggleFilterTag,
} from '@/app/_client/timeline-filter';
import { en } from '@/shared/i18n';

/**
 * Filtering the timeline by tag.
 *
 * The rules that would break quietly: what the catalogue does under a filter,
 * and what the timeline says when a filter matches nothing. Both look right on
 * a full timeline and are wrong in exactly the case they exist for.
 */

describe('showsCatalogue', () => {
  it('shows the shared catalogue on the whole timeline', () => {
    expect(showsCatalogue([])).toBe(true);
  });

  /**
   * The one that matters. The deep-time catalogue is global — nobody's data,
   * carrying nobody's tags. Under `.flight` it answers a question that was not
   * asked, and reads as though the moon landing were somehow tagged.
   */
  it('hides it under a filter', () => {
    expect(showsCatalogue(['t-flight'])).toBe(false);
    expect(showsCatalogue(['t-flight', 't-hotel'])).toBe(false);
  });
});

describe('toggleFilterTag', () => {
  it('adds a tag that is not in the filter', () => {
    expect(toggleFilterTag([], 't-flight')).toEqual(['t-flight']);
  });

  it('removes one that is', () => {
    expect(toggleFilterTag(['t-flight', 't-hotel'], 't-flight')).toEqual(['t-hotel']);
  });

  /** A filter is a set, so a second tag narrows rather than replaces. */
  it('keeps both when a second is added', () => {
    expect(toggleFilterTag(['t-flight'], 't-hotel')).toEqual(['t-flight', 't-hotel']);
  });

  it('keeps the order tags were added in, so the chips do not rearrange', () => {
    const filter = toggleFilterTag(toggleFilterTag(['t-a'], 't-b'), 't-c');
    expect(filter).toEqual(['t-a', 't-b', 't-c']);
  });

  it('does not mutate what it was given', () => {
    const before = ['t-flight'];
    toggleFilterTag(before, 't-hotel');
    expect(before).toEqual(['t-flight']);
  });
});

describe('emptyMessage', () => {
  it('invites a first verse on an empty timeline', () => {
    expect(emptyMessage([], [], '', en)).toContain('Add the first verse');
  });

  /**
   * And never says that under a filter. Someone with a full timeline who has
   * just narrowed to a tag being told they have written nothing reads as
   * though their record had been lost.
   */
  it('never says that under a filter', () => {
    expect(emptyMessage(['t-flight'], ['.flight'], '', en)).not.toContain(
      'Add the first verse',
    );
  });

  it('names the tag rather than counting it', () => {
    expect(emptyMessage(['t-flight'], ['.flight'], '', en)).toBe(
      'Nothing filed under .flight.',
    );
  });

  it('names both when there are two', () => {
    expect(emptyMessage(['t-a', 't-b'], ['.flight', '.hotel'], '', en)).toBe(
      'Nothing filed under .flight and .hotel.',
    );
  });

  /** Labels can be missing while the tag list is still loading. */
  it('still says something useful with no labels to hand', () => {
    expect(emptyMessage(['t-flight'], [], '', en)).toBe('Nothing filed under that tag.');
  });
});
