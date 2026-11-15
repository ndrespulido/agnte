import { describe, expect, it } from 'vitest';
import { en, parseComposer } from '@agnte/core';
import type { TagView } from '@/app/_client/api';
import {
  dateLine,
  draftToText,
  resolveTags,
  verseFrom,
  type DraftFields,
} from '@/app/_client/compose';

process.env.TZ = 'UTC';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const parse = (text: string) => parseComposer(text, { strings: en, now: NOW });

const tag = (name: string, shortcut: string | null = null): TagView => ({
  id: `id-${name}`,
  name,
  label: `.${name}`,
  visibility: 'private',
  shortcut,
  vertical: null,
  suggestedProperties: [],
  version: 0,
});

describe('resolveTags', () => {
  const mine = [tag('movies', 'm'), tag('travel'), tag('m2')];

  it('finds a tag by name, expands a shortcut, and marks the rest as new', () => {
    expect(resolveTags(['travel', 'm', 'recife'], mine)).toEqual([
      { name: 'travel', existing: mine[1] },
      { name: 'movies', existing: mine[0] },
      { name: 'recife', existing: null },
    ]);
  });

  it('prefers a tag called that over another tag’s shortcut', () => {
    const both = [tag('movies', 'm'), tag('m')];
    expect(resolveTags(['m'], both)).toEqual([{ name: 'm', existing: both[1] }]);
  });

  it('does not file a verse under the same tag twice', () => {
    // The name and its shortcut, both typed.
    expect(resolveTags(['movies', 'm'], mine)).toHaveLength(1);
  });
});

describe('verseFrom', () => {
  it('carries the parse and the literal text', () => {
    const text =
      'Trip to Recife from: 5 January 2027 to: 24/02/27 where: Recife rating:5 .travel';
    expect(verseFrom(parse(text), text, NOW)).toEqual({
      xp: 'Trip to Recife',
      location: 'Recife',
      rating: 5,
      eventStart: '2027-01-05T00:00:00.000Z',
      eventEnd: '2027-02-24T00:00:00.000Z',
      eventPrecision: 'date',
      visibility: null,
      properties: {},
      typedText: text,
    });
  });

  it('places an undated verse now, as a moment', () => {
    expect(verseFrom(parse('Coffee .daily'), 'Coffee .daily', NOW)).toMatchObject({
      eventStart: '2026-11-15T12:00:00.000Z',
      eventPrecision: 'minute',
    });
  });

  /**
   * Fail closed (CLAUDE.md): the composer never picks a visibility. Unsaid or
   * misspelt, it is sent as null and the server resolves restrictively.
   */
  it('never chooses a visibility that was not typed', () => {
    expect(verseFrom(parse('Notes .health'), '', NOW).visibility).toBe(null);
    expect(verseFrom(parse('Notes visibility: publik .health'), '', NOW).visibility).toBe(
      null,
    );
    expect(verseFrom(parse('Notes visibility: public .health'), '', NOW).visibility).toBe(
      'public',
    );
  });
});

describe('dateLine', () => {
  it('shows a day, a moment and a range the way the timeline will', () => {
    expect(dateLine(parse('when: tomorrow'), NOW, en)).toBe('Tomorrow');
    expect(dateLine(parse('when: 5 January 2027 17:30'), NOW, en)).toBe(
      'Tuesday 5 January 2027, 17:30',
    );
    expect(dateLine(parse('from: 5 January 2027 to: 24/02/27'), NOW, en)).toBe(
      'Tuesday 5 January 2027 — Wednesday 24 February 2027',
    );
  });

  it('says nothing when no date was typed', () => {
    expect(dateLine(parse('Coffee .daily'), NOW, en)).toBe(null);
  });
});

describe('draftToText', () => {
  const base: DraftFields = {
    xp: '',
    tags: [],
    properties: {},
    start: null,
    endIso: null,
    location: '',
    rating: null,
    visibility: '',
  };
  const say = (over: Partial<DraftFields>) => draftToText({ ...base, ...over }, en, NOW);

  it('says a whole form in the bar’s own words, and reads back the same', () => {
    const result = say({
      xp: 'Dinner at Ramiro',
      tags: ['restaurant', 'lisbon'],
      properties: { plat: 'prawns', 'Sea View': 'yes' },
      start: { iso: '2027-01-05T20:30:00.000Z', precision: 'minute' },
      location: 'Lisbon',
      rating: 9,
      visibility: 'private',
    });
    expect(result.lossless).toBe(true);
    expect(result.text).toBe(
      'Dinner at Ramiro where: Lisbon rating: 9 visibility: private when: 2027-01-05 20:30 plat: prawns sea-view: yes .restaurant .lisbon',
    );
  });

  it('says a range of days', () => {
    const result = say({
      xp: 'Trip',
      tags: ['travel'],
      start: { iso: '2027-01-05T00:00:00.000Z', precision: 'date' },
      endIso: '2027-02-24T00:00:00.000Z',
    });
    expect(result.lossless).toBe(true);
    expect(result.text).toContain('from: 2027-01-05 to: 2027-02-24');
  });

  it('says an empty form as nothing at all', () => {
    expect(say({})).toEqual({ text: '', lossless: true });
  });

  it('keeps accented and non-Latin detail names', () => {
    const result = say({ tags: ['menu'], properties: { entrée: 'soup', 座位: '4A' } });
    expect(result.lossless).toBe(true);
    expect(result.text).toBe('entrée: soup 座位: 4A .menu');
  });

  /**
   * The cases the bar cannot say. Each would read back as something else, so
   * the form must stay open rather than minimise into it.
   */
  it('refuses what would read back differently', () => {
    expect(say({ xp: 'Note: call mom', tags: ['a'] }).lossless).toBe(false);
    expect(say({ location: 'Lisbon: Alfama', tags: ['a'] }).lossless).toBe(false);
    expect(say({ properties: { rating: 'lots' }, tags: ['a'] }).lossless).toBe(false);
    expect(say({ xp: 'see https://x.test and .5 of it', tags: ['a'] }).lossless).toBe(
      true,
    );
  });

  it('collapses a note’s line breaks into spaces, and says that is fine', () => {
    const result = say({ xp: 'one\n\ntwo', tags: ['a'] });
    expect(result.text).toBe('one two .a');
    expect(result.lossless).toBe(true);
  });
});
