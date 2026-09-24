'use client';

import { useEffect } from 'react';
import { LanguagePicker } from './LanguagePicker';
import { useStrings } from './locale';

/**
 * The header's actions, behind one button.
 *
 * They used to sit in the header as text buttons, which stopped working before
 * this sheet existed: the date is set deliberately larger than feels
 * comfortable (CLAUDE.md's type direction), and at 390px a long date like
 * "Monday 1 March 2027" beside two buttons already wrapped onto two lines —
 * which the fixed header's height, and the padding `.app-main` uses to clear
 * it, both assume does not happen. A third button took it to four lines and
 * the date collided with the buttons outright.
 *
 * So the header keeps the date and one small affordance, and everything else
 * moves here. That is the sober, minimal reading anyway: a paper agenda's tab
 * shows the date, not a toolbar.
 */
export function Menu({
  onTags,
  onReminders,
  onPassword,
  onYourData,
  onSignOut,
  onClose,
}: {
  onTags: () => void;
  onReminders: () => void;
  onPassword: () => void;
  onYourData: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const s = useStrings();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet menu-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={s.menu.label}
        onClick={(event) => event.stopPropagation()}
      >
        <ul className="menu-rows">
          <li>
            <button type="button" className="menu-row" onClick={onTags}>
              {s.menu.tags}
            </button>
          </li>
          <li>
            <button type="button" className="menu-row" onClick={onReminders}>
              {s.menu.reminders}
            </button>
          </li>
          <li>
            <button type="button" className="menu-row" onClick={onPassword}>
              {s.menu.password}
            </button>
          </li>
          <li>
            {/* Above Sign out, below the everyday rows: it is where someone
                goes looking for "what happens to what I wrote", and it is not
                something to put a thumb's width from the thing you tap when
                you are done. */}
            <button type="button" className="menu-row" onClick={onYourData}>
              {s.menu.yourData}
            </button>
          </li>
          <li>
            <button type="button" className="menu-row" onClick={onSignOut}>
              {s.menu.signOut}
            </button>
          </li>
        </ul>

        {/* Below the rows and above Close: it is a setting, not a
            destination, and it is the one row someone reaches for when the
            app is in a language they cannot read — so it must be visible
            without first understanding any of the words above it. */}
        <LanguagePicker />

        <div className="sheet-actions">
          <button type="button" className="quiet" onClick={onClose}>
            {s.common.close}
          </button>
        </div>
      </div>
    </div>
  );
}
