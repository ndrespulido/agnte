'use client';

import { useState } from 'react';
import { VerseSheet } from './VerseSheet';
import { useStrings } from './locale';

/**
 * The add button.
 *
 * The button is the "metallic paper" from CLAUDE.md: a soft vertical
 * silver-to-pewter gradient with a 1px lighter top edge and darker bottom edge,
 * and a very soft shadow. No gloss, no bevel — the styling is in globals.css so
 * the gradient and its two edges sit together where they can be read as one
 * idea.
 *
 * The sheet it opens is `VerseSheet`, the same one editing uses; see that file
 * for why there is only one.
 */
export function QuickAdd({ onAdded }: { onAdded: () => void }) {
  const s = useStrings();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="add-button"
        aria-label={s.timeline.addAVerse}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">+</span>
      </button>

      {open ? (
        <VerseSheet
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            onAdded();
          }}
        />
      ) : null}
    </>
  );
}
