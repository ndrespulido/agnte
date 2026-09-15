import { describe, expect, it } from 'vitest';
import {
  MAX_CO_TAGS,
  parseNumericValue,
  summarise,
  type SummaryInput,
} from '@/modules/verse/domain/summary';
import type { Tag } from '@/modules/verse';
import type { Verse } from '@/modules/verse';

/**
 * The dashboard's arithmetic.
 *
 * Tested directly and without a database, which is the point of putting it in
 * the domain: these are the numbers someone reads as "I spent €840 in
 * Barcelona", and a wrong one is not obviously wrong on screen.
 */

const tag = (id: string, name: string): Tag => ({
  id,
  ownerId: 'owner',
  name,
  displayName: null,
  visibility: 'private',
  shortcut: null,
  vertical: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  version: 1,
});

const verse = (over: Partial<Verse> = {}): Verse => ({
  id: 'v1',
  ownerId: 'owner',
  eventStart: null,
  eventEnd: null,
  deepTimeYears: null,
  location: null,
  rating: null,
  xp: null,
  properties: {},
  visibility: null,
  mediaIds: [],
  tagIds: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  version: 1,
  ...over,
});

const row = (
  over: Partial<Verse> = {},
  tags: Tag[] = [],
  mediaCount = 0,
): SummaryInput => ({
  verse: verse(over),
  tags,
  mediaCount,
});

const SUBJECT = tag('subject', 'barcelona');

describe('parseNumericValue', () => {
  it('reads the shapes a person actually types', () => {
    expect(parseNumericValue('42')).toBe(42);
    expect(parseNumericValue('42.50')).toBe(42.5);
    expect(parseNumericValue('  42.50  ')).toBe(42.5);
    expect(parseNumericValue('-5')).toBe(-5);
    expect(parseNumericValue('€42.50')).toBe(42.5);
    expect(parseNumericValue('42.50 €')).toBe(42.5);
    expect(parseNumericValue('42.50 EUR')).toBe(42.5);
  });

  it('reads a decimal comma, which is what a Spanish keyboard produces', () => {
    expect(parseNumericValue('42,50')).toBe(42.5);
    expect(parseNumericValue('42,50 €')).toBe(42.5);
  });

  /**
   * The case worth refusing rather than guessing at. "1,234" is 1234 to an
   * English speaker and 1.234 to a Spanish one, and a schema-free string
   * carries nothing to say which. Guessing turns a €1.23 coffee into a €1,234
   * one; refusing shows up honestly in `numericCount`.
   */
  it('refuses a value that could be a thousands separator or a decimal', () => {
    expect(parseNumericValue('1,234')).toBeNull();
    expect(parseNumericValue('1.234')).toBeNull();
    expect(parseNumericValue('1,234.56')).toBeNull();
  });

  it('refuses anything that is not plainly a number', () => {
    expect(parseNumericValue('about forty')).toBeNull();
    expect(parseNumericValue('')).toBeNull();
    expect(parseNumericValue('   ')).toBeNull();
    expect(parseNumericValue('12abc')).toBeNull();
    expect(parseNumericValue('seat 14C')).toBeNull();
    // A model number, far more likely than a billion in a free-text field.
    expect(parseNumericValue('1e9')).toBeNull();
  });
});

describe('summarise', () => {
  it('counts nothing without inventing anything', () => {
    const empty = summarise([], SUBJECT.id);

    expect(empty.verseCount).toBe(0);
    // Null rather than 0 throughout: "nothing is rated" is a different fact
    // from "everything is rated zero", and the UI renders them differently.
    expect(empty.averageRating).toBeNull();
    expect(empty.firstEvent).toBeNull();
    expect(empty.lastEvent).toBeNull();
    expect(empty.coTags).toEqual([]);
    expect(empty.properties).toEqual([]);
  });

  it('spans from the earliest start to the latest end', () => {
    const summary = summarise(
      [
        row({ eventStart: new Date('2026-03-10T12:00:00Z') }),
        row({ eventStart: new Date('2026-01-05T12:00:00Z') }),
        // A range: its *end* is what extends the span, not its start.
        row({
          eventStart: new Date('2026-02-01T12:00:00Z'),
          eventEnd: new Date('2026-06-30T12:00:00Z'),
        }),
      ],
      SUBJECT.id,
    );

    expect(summary.firstEvent?.toISOString()).toBe('2026-01-05T12:00:00.000Z');
    expect(summary.lastEvent?.toISOString()).toBe('2026-06-30T12:00:00.000Z');
  });

  /**
   * A minimal Verse — media, a tag, nothing else — is a deliberate design rule
   * rather than an edge case (CLAUDE.md), so an undated verse must count
   * towards the total while contributing nothing to the span.
   */
  it('counts undated and deep-time verses without letting them distort the span', () => {
    const summary = summarise(
      [
        row({ eventStart: new Date('2026-01-05T12:00:00Z') }),
        row(),
        row({ deepTimeYears: -66_000_000 }),
      ],
      SUBJECT.id,
    );

    expect(summary.verseCount).toBe(3);
    expect(summary.undatedCount).toBe(1);
    expect(summary.deepTimeCount).toBe(1);
    expect(summary.firstEvent?.toISOString()).toBe('2026-01-05T12:00:00.000Z');
    expect(summary.lastEvent?.toISOString()).toBe('2026-01-05T12:00:00.000Z');
  });

  it('averages only what is rated, and keeps the histogram', () => {
    const summary = summarise(
      [row({ rating: 8 }), row({ rating: 7 }), row({ rating: 0 }), row()],
      SUBJECT.id,
    );

    expect(summary.ratedCount).toBe(3);
    expect(summary.averageRating).toBe(5);
    expect(summary.ratingHistogram[0]).toBe(1);
    expect(summary.ratingHistogram[7]).toBe(1);
    expect(summary.ratingHistogram[8]).toBe(1);
    expect(summary.ratingHistogram).toHaveLength(11);
  });

  /**
   * A rating of 0 is a real rating — the range is 0–10 — so an unrated verse
   * must not be folded in as a zero. That would drag every average down and
   * look plausible while doing it.
   */
  it('does not treat an unrated verse as a zero', () => {
    expect(summarise([row({ rating: 10 }), row()], SUBJECT.id).averageRating).toBe(10);
    expect(
      summarise([row({ rating: 10 }), row({ rating: 0 })], SUBJECT.id).averageRating,
    ).toBe(5);
  });

  it('rounds the average to something a person would read', () => {
    const summary = summarise(
      [row({ rating: 7 }), row({ rating: 8 }), row({ rating: 7 })],
      SUBJECT.id,
    );
    expect(summary.averageRating).toBe(7.3);
  });

  it('counts media by verse and in total, which are different questions', () => {
    const summary = summarise([row({}, [], 3), row({}, [], 1), row()], SUBJECT.id);

    expect(summary.withMediaCount).toBe(2);
    expect(summary.mediaCount).toBe(4);
  });

  it('ranks co-occurring tags and leaves the subject out of its own list', () => {
    const flight = tag('t-flight', 'flight');
    const food = tag('t-food', 'restaurant');

    const summary = summarise(
      [row({}, [SUBJECT, flight, food]), row({}, [SUBJECT, food]), row({}, [SUBJECT])],
      SUBJECT.id,
    );

    expect(summary.coTags.map((t) => [t.name, t.count])).toEqual([
      ['restaurant', 2],
      ['flight', 1],
    ]);
    expect(summary.coTags.some((t) => t.id === SUBJECT.id)).toBe(false);
    // Written the way the domain writes a tag, rather than a second copy of
    // the leading-dot rule living in the summary.
    expect(summary.coTags[0]?.label).toBe('.restaurant');
  });

  it('breaks a co-tag tie by name so the order does not depend on read order', () => {
    const a = tag('t-a', 'alpha');
    const z = tag('t-z', 'zulu');

    const forwards = summarise([row({}, [z]), row({}, [a])], SUBJECT.id);
    const backwards = summarise([row({}, [a]), row({}, [z])], SUBJECT.id);

    expect(forwards.coTags.map((t) => t.name)).toEqual(['alpha', 'zulu']);
    expect(backwards.coTags.map((t) => t.name)).toEqual(['alpha', 'zulu']);
  });

  it('stops listing co-tags before the list stops being a summary', () => {
    const many = Array.from({ length: MAX_CO_TAGS + 5 }, (_, i) =>
      tag(`t-${i}`, `tag-${i}`),
    );
    const summary = summarise([row({}, many)], SUBJECT.id);

    expect(summary.coTags).toHaveLength(MAX_CO_TAGS);
  });

  /** The "query it like a database" payoff: what a tag's numbers add up to. */
  it('adds up the property values that are numbers', () => {
    const summary = summarise(
      [
        row({ properties: { amount: '42.50', seat: '14C' } }),
        row({ properties: { amount: '€100', seat: '2A' } }),
        row({ properties: { amount: 'free' } }),
      ],
      SUBJECT.id,
    );

    const amount = summary.properties.find((p) => p.key === 'amount');
    expect(amount).toEqual({
      key: 'amount',
      verseCount: 3,
      numericCount: 2,
      sum: 142.5,
    });

    // A key whose values never parse reports null, not a misleading zero.
    const seat = summary.properties.find((p) => p.key === 'seat');
    expect(seat?.sum).toBeNull();
    expect(seat?.verseCount).toBe(2);
  });

  it('orders properties by how many verses carry them', () => {
    const summary = summarise(
      [
        row({ properties: { common: '1', rare: '1' } }),
        row({ properties: { common: '1' } }),
        row({ properties: { common: '1' } }),
      ],
      SUBJECT.id,
    );

    expect(summary.properties.map((p) => p.key)).toEqual(['common', 'rare']);
  });
});
