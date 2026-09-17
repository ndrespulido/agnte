import { describe, expect, it } from 'vitest';
import {
  REMINDER_TAG,
  normaliseTagName,
  planTags,
  reminderVerseFields,
} from '@/app/_client/reminder-verse';
import { verseIdFromSearch, withoutVerse } from '@/app/_client/deep-link';

/**
 * A reminder is a Verse.
 *
 * These are the two decisions in that sentence that can be got wrong quietly:
 * which tags a reminder ends up carrying, and where it sits on the timeline.
 */

describe('planTags', () => {
  const known = [
    { id: 't-reminder', name: 'reminder' },
    { id: 't-flight', name: 'flight' },
  ];

  it('uses a tag that already exists rather than making a second one', () => {
    const plan = planTags([REMINDER_TAG], known);

    expect(plan.ids).toEqual(['t-reminder']);
    expect(plan.create).toEqual([]);
  });

  it('asks for a tag that does not exist yet', () => {
    const plan = planTags(['.barcelona-trip'], known);

    expect(plan.ids).toEqual([]);
    expect(plan.create).toEqual(['barcelona-trip']);
  });

  /**
   * The failure this exists to prevent: creating the same tag twice in one
   * submit. The server refuses a duplicate name, and a refused write sits at
   * the head of the outbox blocking everything queued behind it (api.ts).
   */
  it('collapses names that normalise to the same tag', () => {
    const plan = planTags(['.Barcelona', 'barcelona', '  BARCELONA '], known);

    expect(plan.create).toEqual(['barcelona']);
  });

  it('keeps chips that were already selected, without duplicating them', () => {
    const plan = planTags([REMINDER_TAG, '.flight'], known, ['t-flight']);

    expect(plan.ids).toEqual(['t-flight', 't-reminder']);
    expect(plan.create).toEqual([]);
  });

  it('ignores blanks and a field of nothing but dots', () => {
    const plan = planTags([REMINDER_TAG, '', '  ', '..'], known);

    expect(plan.ids).toEqual(['t-reminder']);
    expect(plan.create).toEqual([]);
  });

  it('normalises the way the domain does', () => {
    expect(normaliseTagName('..Restaurant  ')).toBe('restaurant');
  });
});

describe('reminderVerseFields', () => {
  /**
   * `eventStart`, not `createdAt`. A reminder for next Tuesday belongs next
   * Tuesday on the timeline — putting it at "written today" would bury it
   * among everything else logged today and leave the future half empty, which
   * is the whole thing this was asked for.
   */
  it('places the verse at the moment the reminder is for', () => {
    const fields = reminderVerseFields({
      title: 'Take the tablet',
      fireAt: '2026-10-01T08:00:00.000Z',
      tagIds: ['t-reminder'],
    });

    expect(fields.eventStart).toBe('2026-10-01T08:00:00.000Z');
    expect(fields.xp).toBe('Take the tablet');
    expect(fields.tagIds).toEqual(['t-reminder']);
  });

  it('trims the text, so a stray space is not what the timeline shows', () => {
    expect(
      reminderVerseFields({ title: '  Renew it  ', fireAt: 'x', tagIds: [] }).xp,
    ).toBe('Renew it');
  });

  /** Copied, not aliased: mutating the caller's array must not reach the verse. */
  it('does not hold on to the caller’s array', () => {
    const tagIds = ['t-reminder'];
    const fields = reminderVerseFields({ title: 'x', fireAt: 'y', tagIds });

    tagIds.push('t-oops');
    expect(fields.tagIds).toEqual(['t-reminder']);
  });
});

describe('verseIdFromSearch', () => {
  const id = '0192f4a0-1c2d-7e3f-8a9b-0c1d2e3f4a5b';

  it('reads the verse a tapped notification asked for', () => {
    expect(verseIdFromSearch(`?verse=${id}`)).toBe(id);
  });

  it('is nothing when the parameter is absent', () => {
    expect(verseIdFromSearch('')).toBeNull();
    expect(verseIdFromSearch('?tag=flight')).toBeNull();
  });

  /**
   * `?verse=` is reachable by anyone who can put a link in front of someone,
   * and the value goes straight into a fetch path. A shape check means a
   * crafted parameter produces nothing rather than a request elsewhere.
   */
  it.each(['../../v1/me', 'not-a-uuid', '', `${id} `, `${id}/extra`])(
    'refuses a value that is not a uuid (%j)',
    (value) => {
      expect(verseIdFromSearch(`?verse=${encodeURIComponent(value)}`)).toBeNull();
    },
  );

  it('accepts the uppercase form and answers in lowercase', () => {
    expect(verseIdFromSearch(`?verse=${id.toUpperCase()}`)).toBe(id);
  });
});

describe('withoutVerse', () => {
  /**
   * Without this, a reload reopens the same verse forever, because the
   * parameter is still in the address bar.
   */
  it('takes the parameter out', () => {
    expect(withoutVerse('http://localhost:3000/?verse=abc')).toBe('/');
  });

  it('leaves the other parameters alone', () => {
    expect(withoutVerse('http://localhost:3000/?verse=abc&tag=flight')).toBe(
      '/?tag=flight',
    );
  });

  it('keeps the path and the hash', () => {
    expect(withoutVerse('http://localhost:3000/somewhere?verse=abc#top')).toBe(
      '/somewhere#top',
    );
  });

  it('is a no-op on a url that has no verse in it', () => {
    expect(withoutVerse('http://localhost:3000/')).toBe('/');
  });
});
