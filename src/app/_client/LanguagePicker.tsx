'use client';

import { LOCALES, type Locale } from '@/shared/i18n';
import { setLocale, useLocale, useStrings } from './locale';
import { saveLocale } from './api';

/**
 * Choosing the language, in the menu.
 *
 * A row of the language names *in their own languages* rather than a `<select>`
 * of them. Two reasons, and neither is decoration: the native control renders
 * as the platform's own widget, which is the one element on a screen built out
 * of hairlines that arrives with a box around it (the same argument the file
 * picker in `YourData` makes); and someone reaching this screen is quite
 * possibly reading a language they do not speak, so every option needs to be
 * visible at once rather than behind a tap.
 *
 * Four languages fit on one line at 390px. If the list grows past what fits,
 * this wants the same treatment the tag bar got — two rows, scrolling sideways
 * — not a dropdown.
 */
export function LanguagePicker() {
  const current = useLocale();
  const s = useStrings();

  /**
   * Switches immediately, then tells the server.
   *
   * Not awaited, and a failure is swallowed on purpose. The language has
   * already changed on screen and in localStorage, so the person got what they
   * asked for; the server copy only decides what a *second* device and their
   * reminder emails use. Blocking the interface on that — or worse, reverting
   * the visible language because a request failed — would make a setting that
   * works offline everywhere else feel broken here.
   *
   * It is also sent when signed out, where `authedFetch` has no token and the
   * call simply fails. That is the same swallow, not a separate case: the
   * choice is kept locally and `App` pushes it up after the next sign-in.
   */
  const choose = (locale: Locale) => {
    setLocale(locale);
    void saveLocale(locale).catch(() => undefined);
  };

  return (
    <div className="language-picker">
      <p className="language-heading">{s.locale.heading}</p>
      <div className="language-options" role="group" aria-label={s.locale.heading}>
        {LOCALES.map((locale) => (
          <button
            key={locale.code}
            type="button"
            className={`language-option${locale.code === current ? ' chosen' : ''}`}
            // `aria-pressed` rather than a radio group: these are buttons that
            // act on tap, and a screen reader should say "pressed" for the one
            // in force rather than describing an unsubmitted selection.
            aria-pressed={locale.code === current}
            lang={locale.intlTag}
            onClick={() => choose(locale.code)}
          >
            {locale.nativeName}
          </button>
        ))}
      </div>
    </div>
  );
}
