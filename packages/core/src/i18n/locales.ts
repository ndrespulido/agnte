/**
 * The languages the interface is offered in, as data.
 *
 * Same discipline as `design/tokens.ts`: plain values, no React, no browser.
 * A future React Native client reads this exact file to build its own picker,
 * which only works if nothing here assumes a DOM.
 *
 * **Adding a language is meant to be three steps and no thinking.** Write a
 * string table next to `en.ts` that satisfies the `Strings` contract — the
 * compiler lists every key you have missed — add its code to `LOCALES` below,
 * and add the table to the map in `index.ts`. Nothing else in the codebase
 * enumerates languages; everything else reads this array.
 */

/** A language tag, narrowed to the ones that have a string table. */
export type Locale = 'en' | 'es' | 'fr' | 'zh';

export interface LocaleInfo {
  readonly code: Locale;
  /**
   * The language's name **in that language** — "Español", not "Spanish".
   *
   * A picker labelled in the language you cannot read is a picker you cannot
   * use, which is exactly the situation of someone who has landed in the wrong
   * language and is trying to get out.
   */
  readonly nativeName: string;
  /**
   * The BCP 47 tag handed to `Intl` for dates and numbers.
   *
   * Separate from `code` because they are not the same kind of thing: `code`
   * identifies a string table this repo maintains, and this identifies a set
   * of formatting rules the platform maintains. They coincide today, and a
   * future `pt-BR` table keyed `pt` would make them differ.
   */
  readonly intlTag: string;
}

/**
 * Ordered as they appear in the picker: English first because it is the
 * fallback, then the rest alphabetically by code.
 */
export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', nativeName: 'English', intlTag: 'en-GB' },
  { code: 'es', nativeName: 'Español', intlTag: 'es-ES' },
  { code: 'fr', nativeName: 'Français', intlTag: 'fr-FR' },
  { code: 'zh', nativeName: '中文', intlTag: 'zh-CN' },
];

/**
 * The one used when nothing else is known.
 *
 * English rather than the browser's language, because this is also the
 * fallback on the *server*, where there is no browser — an email sent by the
 * nightly reminder tick has no request to read a header from.
 */
export const DEFAULT_LOCALE: Locale = 'en';

const CODES: ReadonlySet<string> = new Set(LOCALES.map((l) => l.code));

/** Whether a string is a locale this app has a table for. */
export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && CODES.has(value);

export const localeInfo = (locale: Locale): LocaleInfo =>
  LOCALES.find((l) => l.code === locale) ?? LOCALES[0]!;

/**
 * The best supported locale for a list of preferences, or null for none.
 *
 * Takes what `navigator.languages` or an `Accept-Language` header holds:
 * ordered, region-tagged, and full of languages this app does not have. The
 * region is dropped before matching, so `es-419` (Latin American Spanish) gets
 * Spanish rather than English — a regional variant of a language we do have is
 * always a better answer than a language the reader may not speak.
 *
 * Returns null rather than the default so a caller can tell "they asked for
 * nothing we have" from "they asked for English", which matters when deciding
 * whether to write a preference down.
 */
export function matchLocale(preferred: readonly string[]): Locale | null {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base !== undefined && isLocale(base)) return base;
  }
  return null;
}
