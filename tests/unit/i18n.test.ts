import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  en,
  es,
  fr,
  isLocale,
  localeInfo,
  matchLocale,
  stringsFor,
  zh,
  type Locale,
  type Strings,
} from '@/shared/i18n';

/**
 * The string tables, and the rules for picking between them.
 *
 * Most of what could go wrong here is already a compile error: `Strings` is
 * derived from the English table, so a missing key, a misspelled one, or a
 * function whose arguments were reordered all fail `tsc` rather than reaching
 * a test. What is left is what the type cannot see — an empty string where a
 * sentence should be, a translation that quietly dropped the value it was
 * given, and the matching rules.
 */

const TABLES: Record<Locale, Strings> = { en, es, fr, zh };

/** Every leaf of a table, as `path` → value, so a walk can name what it found. */
function leaves(value: unknown, path = ''): [string, unknown][] {
  if (typeof value !== 'object' || value === null) return [[path, value]];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leaves(item, `${path}[${index}]`));
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, path === '' ? key : `${path}.${key}`),
  );
}

describe('every table is complete', () => {
  /**
   * Every language has a table, checked through `LOCALES` rather than through
   * the map — the picker is built from `LOCALES`, so a code listed there with
   * nothing behind it is an option that silently renders English.
   */
  it.each(LOCALES.map((l) => l.code))('%s has strings of its own', (code) => {
    const table = stringsFor(code);
    expect(table).toBe(TABLES[code]);
    if (code !== 'en') expect(table).not.toBe(en);
  });

  it.each(Object.keys(TABLES) as Locale[])('%s has no empty strings', (code) => {
    const blank = leaves(TABLES[code])
      .filter(([, value]) => typeof value === 'string' && value.trim() === '')
      .map(([path]) => path);

    expect(blank).toEqual([]);
  });

  /**
   * Every function produces something, in every language.
   *
   * A translation that ended up as a bare template literal with the value left
   * out is not a type error — the signature still matches — and it renders as
   * a sentence with a hole in it. Calling each one is the cheapest way to see
   * that it at least says something.
   */
  it.each(Object.keys(TABLES) as Locale[])('%s renders every function', (code) => {
    const silent = leaves(TABLES[code])
      .filter(([, value]) => typeof value === 'function')
      .filter(([, fn]) => {
        // Both a string and a number, because the tables take both and a
        // Chinese scale word does arithmetic on what it is handed.
        const out = (fn as (...args: unknown[]) => unknown)('1', 1, 1, 1);
        return typeof out !== 'string' || out.trim() === '';
      })
      .map(([path]) => path);

    expect(silent).toEqual([]);
  });

  it.each(Object.keys(TABLES) as Locale[])(
    '%s names twelve months and seven days',
    (code) => {
      expect(TABLES[code].dates.months).toHaveLength(12);
      expect(TABLES[code].dates.days).toHaveLength(7);
    },
  );
});

/**
 * Counting, where the languages genuinely disagree.
 *
 * The reason `count` is a function per noun rather than a `{n, plural}`
 * template: these four rules do not fit one shape.
 */
describe('counting', () => {
  it('uses two forms in English and Spanish', () => {
    expect(en.count.verses(1)).toBe('1 verse');
    expect(en.count.verses(2)).toBe('2 verses');
    expect(es.count.verses(1)).toBe('1 verso');
    expect(es.count.verses(2)).toBe('2 versos');
  });

  /** French puts zero in the singular, which English does not. */
  it('keeps zero singular in French and plural in English', () => {
    expect(fr.count.verses(0)).toBe('0 verset');
    expect(fr.count.verses(1)).toBe('1 verset');
    expect(fr.count.verses(2)).toBe('2 versets');
    expect(en.count.verses(0)).toBe('0 verses');
  });

  /** Chinese has one form, and a measure word instead. */
  it('has no plural in Chinese', () => {
    expect(zh.count.verses(1)).toBe('1 条记录');
    expect(zh.count.verses(7)).toBe('7 条记录');
    expect(zh.count.photos(3)).toBe('3 张照片');
  });
});

describe('matchLocale', () => {
  it('takes the first preference this app speaks', () => {
    expect(matchLocale(['fr', 'en'])).toBe('fr');
    expect(matchLocale(['en', 'fr'])).toBe('en');
  });

  /**
   * A language we do not have must not stop the search. Someone with
   * ["ca", "es", "en"] speaks Spanish, and answering English because Catalan
   * came first would be worse than either.
   */
  it('skips languages there is no table for', () => {
    expect(matchLocale(['ca', 'es', 'en'])).toBe('es');
  });

  /**
   * The region is dropped before matching. `es-419` is Latin American Spanish
   * and `zh-TW` is Taiwanese Mandarin; a regional variant of a language we
   * have beats a language the reader may not read at all.
   */
  it('ignores the region', () => {
    expect(matchLocale(['es-419'])).toBe('es');
    expect(matchLocale(['zh-TW'])).toBe('zh');
    expect(matchLocale(['EN-GB'])).toBe('en');
  });

  /** Null rather than the default, so a caller can tell the two apart. */
  it('is null when nothing matches', () => {
    expect(matchLocale(['ja', 'ko'])).toBeNull();
    expect(matchLocale([])).toBeNull();
  });
});

describe('isLocale', () => {
  it('accepts exactly the codes with a table', () => {
    for (const { code } of LOCALES) expect(isLocale(code)).toBe(true);
  });

  /**
   * The guard the write endpoint leans on. An unchecked value reaches the user
   * row and is read back by the email sender, where it falls through to
   * English forever — a setting that appears to save and does nothing.
   */
  it('rejects anything else', () => {
    for (const value of ['', 'EN', 'es-ES', 'ja', null, undefined, 7, {}]) {
      expect(isLocale(value)).toBe(false);
    }
  });
});

describe('falling back', () => {
  it('answers English for a locale with no table', () => {
    // Cast because the type forbids it — the point is what happens when a row
    // written by a newer build, offering a language this one does not have,
    // is read back.
    expect(stringsFor('ja' as Locale)).toBe(en);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('describes a locale, and never returns nothing', () => {
    expect(localeInfo('zh').nativeName).toBe('中文');
    expect(localeInfo('ja' as Locale).code).toBe('en');
  });

  /**
   * The picker labels each option in its own language. Someone who has landed
   * in a language they cannot read needs to recognise their own without
   * reading any of the others.
   */
  it('names every language in itself', () => {
    expect(LOCALES.map((l) => l.nativeName)).toEqual([
      'English',
      'Español',
      'Français',
      '中文',
    ]);
  });
});
