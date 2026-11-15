'use client';

import { useState } from 'react';
import { Composer } from './Composer';
import { VerseSheet } from './VerseSheet';

/**
 * Adding a verse: the composer bar, and the form behind its plus.
 *
 * The bar is the fast path — type it the way you would message yourself. The
 * plus opens `VerseSheet`, the same sheet editing uses, for what typing cannot
 * say. The plus is the "metallic paper" from CLAUDE.md: a soft vertical
 * silver-to-pewter gradient with a 1px lighter top edge and darker bottom
 * edge. No gloss, no bevel — the styling is in globals.css.
 */
export function QuickAdd({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Composer onAdded={onAdded} onOpenForm={() => setOpen(true)} />

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
