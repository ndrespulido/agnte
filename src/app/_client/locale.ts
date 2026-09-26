'use client';

import { useSyncExternalStore } from 'react';
import {
  DEFAULT_LOCALE,
  isLocale,
  matchLocale,
  stringsFor,
  type Locale,
  type Strings,
} from '@/shared/i18n';

/**
 * Which language the interface is in, in the browser.
 *
 * Deliberately the same shape as `session.ts` — an external store read through
 * `useSyncExternalStore` rather than state set in an effect — and for the same
 * reason. The effect version renders one frame in the wrong language before
 * localStorage is read, and a person who has chosen Chinese watching the app
 * flash English on every open is being told, once per open, that the setting
 * did not stick.
 *
 * The preference is also written to the server (see `App.tsx`), because the
 * browser is not the only thing that writes to this person: a reminder email
 * is composed by the nightly tick, where there is no browser and no request
 * header to read a language from. localStorage is the fast local copy; the
 * user row is the durable one.
 */

const KEY = 'agnte.locale';

/**
 * Guarded exactly like the session's reads, and for the same reasons listed
 * there: localStorage throws rather than returning null in a private window
 * and where site data is blocked.
 */
function read(): Locale | null {
  try {
    const stored = globalThis.localStorage?.getItem(KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

function write(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(KEY, locale);
  } catch {
    // Nothing useful to do: the choice simply will not survive a reload, and
    // the browser's own language takes over again.
  }
}

/**
 * What the browser asks for, if this app speaks any of it.
 *
 * `navigator.languages` rather than `navigator.language`: the list is ordered
 * by preference and someone with ["ca", "es", "en"] should get Spanish, not
 * English, because Catalan is not offered. `matchLocale` drops the region, so
 * `es-419` and `zh-TW` land on the tables that exist.
 */
function fromBrowser(): Locale | null {
  try {
    const asked = globalThis.navigator?.languages ?? [];
    return matchLocale(asked.length > 0 ? asked : [globalThis.navigator?.language ?? '']);
  } catch {
    return null;
  }
}

let current: Locale | null = null;
const listeners = new Set<() => void>();

/**
 * Resolution order: an explicit choice, then the browser's, then English.
 *
 * Computed once and cached, because `useSyncExternalStore` compares snapshots
 * by identity and re-reading localStorage on every render would be both
 * wasteful and — for a value derived from an array — a new object each time.
 */
export function getLocaleSnapshot(): Locale {
  current ??= read() ?? fromBrowser() ?? DEFAULT_LOCALE;
  return current;
}

/**
 * The server renders in the default, always.
 *
 * It cannot know better — there is no localStorage and the markup is cached
 * across people — and guessing from `Accept-Language` would produce HTML that
 * disagrees with what the browser then hydrates. `App` renders nothing until
 * the session store has answered, so nothing localised ever reaches the page
 * in this language; it exists to keep the store honest about not knowing.
 */
export const getServerLocaleSnapshot = (): Locale => DEFAULT_LOCALE;

export function subscribeToLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes the language everywhere, at once. */
export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  write(locale);
  for (const listener of listeners) listener();
}

/**
 * Adopts a preference the server holds, without overriding a local choice.
 *
 * Called after sign-in. The server's copy is what a second device should
 * inherit, but this device may have just been used to pick a language while
 * signed out — and the explicit local choice is the more recent statement of
 * intent, so it wins. A device with nothing stored takes the server's.
 */
export function adoptStoredLocale(locale: Locale): void {
  if (read() !== null) return;
  setLocale(locale);
}

/** Whether this browser has an explicit choice, as opposed to a guess. */
export const hasChosenLocale = (): boolean => read() !== null;

export function useLocale(): Locale {
  return useSyncExternalStore(
    subscribeToLocale,
    getLocaleSnapshot,
    getServerLocaleSnapshot,
  );
}

/**
 * The strings for the current language.
 *
 * The hook components actually use. Returning the whole table rather than a
 * `t('some.key')` function is what keeps this typed: `s.timeline.endOfPast` is
 * checked at compile time and renamed by the editor, where a string key is
 * neither.
 */
export function useStrings(): Strings {
  return stringsFor(useLocale());
}

/**
 * What to show for a caught failure.
 *
 * Two things are being reconciled. A rejected request usually arrives carrying
 * its own sentence from the server, and that sentence is more specific than
 * anything this screen could say. A failure with nothing to say — a thrown
 * non-Error, an aborted fetch — needs the screen's own words instead.
 *
 * The fallback is supplied at *render* time rather than inside the `catch`,
 * and that is the point of the helper rather than an `??`. Reading a string
 * from the table inside an effect makes the current language a dependency of
 * that effect: change the language and the effect re-runs, refetching data
 * nobody asked for. So the catch stores `''` — "it failed and I have nothing
 * to add" — and the sentence is chosen where the language is already known.
 *
 * **Known gap, stated rather than hidden:** the server's own message is
 * English, because the API has not been translated. Domain errors already
 * carry stable codes (`verse.verse_id_taken` and the like), so mapping codes
 * to translated sentences on this side is the way to close it — but until that
 * exists, a server-side failure reads in English inside a screen that is
 * otherwise not.
 */
export const failureMessage = (caught: string | null, fallback: string): string =>
  caught !== null && caught !== '' ? caught : fallback;
