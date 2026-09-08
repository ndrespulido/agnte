import { describe, expect, it } from 'vitest';
import {
  MAX_SHORTCUT_LENGTH,
  MAX_TAG_NAME_LENGTH,
  VERTICALS,
  VERTICAL_NAMES,
  defaultShortcut,
  format,
  isVertical,
  parseShortcut,
  parseTagName,
  suggestedProperties,
} from '@/modules/verse';
import { createTag } from '@/modules/verse/domain/tag';
import { fixedClock } from '@/shared/kernel';

const AT = new Date('2026-01-01T00:00:00.000Z');

describe('parseTagName', () => {
  it('accepts a tag written the way the UI shows it', () => {
    const parsed = parseTagName('.barcelona-trip');
    expect(parsed.ok && parsed.value).toBe('barcelona-trip');
  });

  it('accepts it without the dot too', () => {
    const parsed = parseTagName('barcelona-trip');
    expect(parsed.ok && parsed.value).toBe('barcelona-trip');
  });

  it('folds case, so .Barcelona and .barcelona are one tag', () => {
    const upper = parseTagName('.Barcelona');
    const lower = parseTagName('.barcelona');
    expect(upper.ok && upper.value).toBe(lower.ok ? lower.value : 'mismatch');
  });

  it('trims surrounding whitespace', () => {
    const parsed = parseTagName('  .movies  ');
    expect(parsed.ok && parsed.value).toBe('movies');
  });

  it.each([
    ['', 'empty'],
    ['.', 'a bare dot'],
    ['  ', 'only whitespace'],
    ['has space', 'an inner space'],
    ['-leading', 'a leading hyphen'],
    ['trailing-', 'a trailing hyphen'],
    ['double--hyphen', 'a doubled hyphen'],
    ['emoji-🎬', 'an emoji'],
    ['under_score', 'an underscore'],
  ])('rejects %j (%s)', (input) => {
    expect(parseTagName(input).ok).toBe(false);
  });

  it('rejects a name carrying a newline', () => {
    // An unanchored pattern would accept this, and the second line would later
    // reappear as its own row in an export or a denormalized search column.
    expect(parseTagName('holiday\nmedical').ok).toBe(false);
  });

  it('rejects a name past the length cap but accepts one at it', () => {
    expect(parseTagName('a'.repeat(MAX_TAG_NAME_LENGTH)).ok).toBe(true);
    expect(parseTagName('a'.repeat(MAX_TAG_NAME_LENGTH + 1)).ok).toBe(false);
  });
});

describe('parseShortcut', () => {
  it('accepts a single letter, with or without the dot', () => {
    expect(parseShortcut('.m').ok).toBe(true);
    expect(parseShortcut('m').ok).toBe(true);
  });

  it('rejects hyphens, which names allow and shortcuts do not', () => {
    expect(parseShortcut('bar-trip').ok).toBe(false);
  });

  it('rejects one past the length cap', () => {
    expect(parseShortcut('a'.repeat(MAX_SHORTCUT_LENGTH)).ok).toBe(true);
    expect(parseShortcut('a'.repeat(MAX_SHORTCUT_LENGTH + 1)).ok).toBe(false);
  });
});

describe('format', () => {
  it('puts the dot back for display', () => {
    expect(format({ name: 'barcelona-trip' })).toBe('.barcelona-trip');
  });
});

describe('defaultShortcut', () => {
  it('takes the first letter when it is free', () => {
    expect(defaultShortcut('movies', new Set())).toBe('m');
  });

  it('leaves the second tag without one rather than inventing an alternative', () => {
    // CLAUDE.md is explicit: a collision leaves the second tag without a
    // default. `.m` silently meaning something different from what muscle
    // memory expects is worse than `.m` meaning nothing.
    expect(defaultShortcut('medical', new Set(['m']))).toBe(null);
  });

  it('has nothing to offer an empty name', () => {
    expect(defaultShortcut('', new Set())).toBe(null);
  });
});

describe('verticals', () => {
  it('is exactly the five from CLAUDE.md', () => {
    expect([...VERTICAL_NAMES].sort()).toEqual([
      'concert',
      'flight',
      'hotel',
      'movie',
      'restaurant',
    ]);
  });

  it('suggests properties without requiring any', () => {
    // The suggestion list pre-fills a form; it is never a validation rule. A
    // Verse tagged .flight with nothing but a photo is valid by design.
    expect(suggestedProperties('flight')).toContain('airline');
    expect(suggestedProperties('flight').length).toBeGreaterThan(0);
  });

  it('recognises its own names and nothing else', () => {
    for (const v of VERTICAL_NAMES) expect(isVertical(v)).toBe(true);
    for (const v of ['train', 'Flight', '', null, 'toString', 'constructor']) {
      expect(isVertical(v)).toBe(false);
    }
  });

  it('every vertical has a non-empty suggestion list', () => {
    for (const v of VERTICAL_NAMES) expect(VERTICALS[v].length).toBeGreaterThan(0);
  });
});

describe('createTag', () => {
  it('defaults to private, never to something more permissive', () => {
    const tag = createTag({ ownerId: 'u1', name: 'medical', clock: fixedClock(AT) });
    expect(tag.visibility).toBe('private');
  });

  it('starts at version 0 with matching timestamps', () => {
    const clock = fixedClock(AT);
    const tag = createTag({ ownerId: 'u1', name: 'movies', clock });
    expect(tag.version).toBe(0);
    expect(tag.createdAt).toEqual(tag.updatedAt);
    expect(tag.createdAt).toEqual(clock.now());
  });

  it('mints a time-sortable id', () => {
    const a = createTag({ ownerId: 'u1', name: 'a', clock: fixedClock(AT) });
    const b = createTag({ ownerId: 'u1', name: 'b', clock: fixedClock(AT) });
    expect(a.id < b.id).toBe(true);
  });
});
