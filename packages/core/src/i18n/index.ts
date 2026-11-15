/**
 * The one importable surface of the i18n layer.
 *
 * Shared *infrastructure*, not a shared domain type (CLAUDE.md): no module's
 * domain imports this, and nothing here knows what a Verse is. The client
 * reads it to render, and `notifications` reads it to write an email in the
 * language its recipient chose — which is the reason the preference is stored
 * on the user rather than read from a request header. The nightly reminder
 * tick has no request to read.
 */
import { en, type Strings } from './en';
import { es } from './es';
import { fr } from './fr';
import { zh } from './zh';
import { DEFAULT_LOCALE, type Locale } from './locales';

export { en, type Strings } from './en';
/*
 * The individual tables are exported as well as `stringsFor`.
 *
 * Not for the app — it should always go through `stringsFor`, which falls back
 * — but for tests, which need to assert that a date reads "3 de marzo" in
 * Spanish without going through a resolution step that could mask the answer.
 */
export { es } from './es';
export { fr } from './fr';
export { zh } from './zh';
export {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  localeInfo,
  matchLocale,
  type Locale,
  type LocaleInfo,
} from './locales';

/**
 * Every table, keyed by locale.
 *
 * `Record<Locale, Strings>` rather than a loose map: adding a code to `LOCALES`
 * without adding its table here is a compile error, which is the failure mode
 * worth catching — the other order (a table nothing points at) is dead code,
 * not a broken screen.
 */
const TABLES: Record<Locale, Strings> = { en, es, fr, zh };

/** The strings for a locale. Falls back to English rather than throwing. */
export const stringsFor = (locale: Locale): Strings =>
  TABLES[locale] ?? TABLES[DEFAULT_LOCALE];
