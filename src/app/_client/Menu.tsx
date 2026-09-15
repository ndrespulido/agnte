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
  onTags,
  onPassword,
  onSignOut,
  onClose,
}: {
  onTags: () => void;
  onPassword: () => void;
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
          <li>
            <button type="button" className="menu-row" onClick={onTags}>
              Tags
            </button>
          </li>
          <li>
            <button type="button" className="menu-row" onClick={onPassword}>
              Password
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
