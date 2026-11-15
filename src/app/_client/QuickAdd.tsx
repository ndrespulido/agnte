'use client';

import { Composer } from './Composer';

/**
 * Adding a verse: the composer bar, with the form behind its plus.
 *
 * The bar owns both, because they are one draft: what is typed in the bar is
 * what the form opens with (see `Composer`).
 */
export function QuickAdd({ onAdded }: { onAdded: () => void }) {
  return <Composer onAdded={onAdded} />;
}
