'use client';

import { useEffect } from 'react';

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
  onSearch,
  onTags,
  onReminders,
  onPassword,
  onYourData,
  onSignOut,
  onClose,
}: {
  onSearch: () => void;
  onTags: () => void;
  onReminders: () => void;
  onPassword: () => void;
  onYourData: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
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
        aria-label="Menu"
        onClick={(event) => event.stopPropagation()}
      >
        <ul className="menu-rows">
          {/* First, because it is the one people reach for most once there is
              enough on the timeline to lose things in. */}
          <li>
            <button type="button" className="menu-row" onClick={onSearch}>
              Search
            </button>
          </li>
          <li>
            <button type="button" className="menu-row" onClick={onTags}>
              Tags
            </button>
          </li>
          <li>
            <button type="button" className="menu-row" onClick={onReminders}>
              Reminders
            </button>
          </li>
          <li>
            <button type="button" className="menu-row" onClick={onPassword}>
              Password
            </button>
          </li>
          <li>
            {/* Above Sign out, below the everyday rows: it is where someone
                goes looking for "what happens to what I wrote", and it is not
                something to put a thumb's width from the thing you tap when
                you are done. */}
            <button type="button" className="menu-row" onClick={onYourData}>
              Your data
            </button>
          </li>
          <li>
            <button type="button" className="menu-row" onClick={onSignOut}>
              Sign out
            </button>
          </li>
        </ul>

        <div className="sheet-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
