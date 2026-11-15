import { afterEach, describe, expect, it } from 'vitest';
import { serverSaid, setLocale } from '@/app/_client/locale';
import { en, es, fr, zh } from '@agnte/core';
import { VerseErrorCode } from '@/modules/verse/domain/errors';
import { IdentityErrorCode } from '@/modules/identity/domain/errors';

/**
 * Server failures in the reader's language.
 *
 * The API answers `{ error: { code, message } }` with an English message. The
 * client picks its own sentence by code, so a Spanish screen does not turn
 * English the moment something goes wrong.
 */
describe('serverSaid', () => {
  afterEach(() => setLocale('en'));

  const body = (code: string, message = 'English from the server.') => ({
    error: { code, message },
  });

  it('says a known code in the chosen language', () => {
    setLocale('es');
    expect(serverSaid(body('verse.no_tags'))).toBe(es.errors['verse.no_tags']);
    setLocale('zh');
    expect(serverSaid(body('verse.no_tags'))).toBe(zh.errors['verse.no_tags']);
    setLocale('fr');
    expect(serverSaid(body('rate_limited'))).toBe(fr.errors.rate_limited);
  });

  it('falls back to the server sentence for a code it has no words for', () => {
    setLocale('es');
    expect(serverSaid(body('verse.something_new'))).toBe('English from the server.');
  });

  it('is not fooled by a code that names something every object has', () => {
    // `known[code]` alone would answer with Object.prototype.toString here.
    expect(serverSaid(body('toString'))).toBe('English from the server.');
    expect(serverSaid(body('constructor'))).toBe('English from the server.');
  });

  it('answers null when the body says nothing, so the screen uses its own words', () => {
    expect(serverSaid(null)).toBe(null);
    expect(serverSaid({})).toBe(null);
  });

  /**
   * A key in the table that the server never sends is a translation nobody
   * will ever see, and usually a typo for one that somebody should. Checked
   * for the two modules whose codes are declared as a list.
   */
  it('only has words for codes that exist', () => {
    const real = new Set<string>([
      ...Object.values(VerseErrorCode),
      ...Object.values(IdentityErrorCode),
    ]);
    const stray = Object.keys(en.errors).filter(
      (code) =>
        (code.startsWith('verse.') || code.startsWith('identity.')) && !real.has(code),
    );
    expect(stray).toEqual([]);
  });
});
