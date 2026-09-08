import { type DomainError, type Result, err, ok } from '@/shared/kernel';
import { cursorInvalid } from './errors';
import type { Verse } from './verse';

/**
 * Where a Verse sits on the timeline, as one number.
 *
 * Years from 2000-01-01, positive into the future. The scale exists because a
 * page can legitimately span a booked flight and the Chicxulub impact, and
 * neither a timestamp column nor a deep-time float can hold both.
 *
 * Kept in the domain rather than in SQL so the rule has one definition: the
 * repository writes what this returns, and the migration's backfill is the same
 * expression in the same units. If they ever disagree, ordering silently
 * changes, which is the sort of bug that looks like "the timeline feels wrong".
 */

/** A Julian year in milliseconds — the same constant deep-time conversion uses. */
const MS_PER_JULIAN_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** 2000-01-01T00:00:00Z. */
export const TIMELINE_EPOCH_MS = Date.UTC(2000, 0, 1);

export const yearsFromEpoch = (date: Date): number =>
  (date.getTime() - TIMELINE_EPOCH_MS) / MS_PER_JULIAN_YEAR;

/**
 * The verse's position, from whichever of the three ways it is placed.
 *
 * The precedence matters: deep time wins because it is mutually exclusive with
 * the event fields, then the event date, then when it was written — a Verse
 * with no date at all still has to appear somewhere, and "when I wrote it" is
 * the only honest answer.
 */
export function timelineYears(
  verse: Pick<Verse, 'deepTimeYears' | 'eventStart' | 'createdAt'>,
): number {
  if (verse.deepTimeYears !== null) return verse.deepTimeYears;
  return yearsFromEpoch(verse.eventStart ?? verse.createdAt);
}

/**
 * A keyset cursor: the position and id of the last row on the previous page.
 *
 * Keyset rather than OFFSET because the timeline is written to while it is
 * being read — a new verse shifts every offset under the reader, so page two
 * repeats a row page one already showed. The id is part of the key because two
 * verses can share a position exactly, and a cursor on position alone would
 * skip or repeat at that boundary.
 *
 * Encoded as base64url of "years|id" rather than JSON, so it is opaque enough
 * that nobody builds one by hand and short enough to sit in a query string.
 * It is not a secret and is not signed: it names a row the caller has already
 * been shown, and every query it feeds is still scoped to the caller.
 */
export interface Cursor {
  readonly years: number;
  readonly id: string;
}

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(`${cursor.years}|${cursor.id}`, 'utf8').toString('base64url');

export function decodeCursor(raw: string): Result<Cursor, DomainError> {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return err(cursorInvalid());
  }

  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) return err(cursorInvalid());

  const years = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isFinite(years) || id.length === 0) return err(cursorInvalid());

  return ok({ years, id });
}
