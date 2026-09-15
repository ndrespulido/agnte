import { err, ok, DomainError, type Result } from '@/shared/kernel';

/**
 * Keyset cursor for the catalogue: a position on the shared axis plus an id.
 *
 * Both halves are needed. Several catalogue entries share a year exactly —
 * the first stars and the Milky Way are both -13.6e9, because at that
 * magnitude the figures have three significant digits between them — and a
 * cursor on position alone would repeat or skip at that boundary.
 *
 * This is a near-copy of `verse/domain/timeline`'s codec, deliberately.
 * Importing that one would be a deep import across a module boundary, which
 * ESLint blocks and §1.1 forbids on purpose: a shared *domain* type is what
 * re-couples two modules that are otherwise free to move apart. Twelve lines
 * duplicated is the price of that, and it is the cheaper side of the trade —
 * the alternative is a shared-kernel type that both modules then cannot
 * change independently.
 *
 * Encoded as base64url of "years|id": opaque enough that nobody hand-builds
 * one, short enough for a query string. Not a secret and not signed — it names
 * a row from a catalogue every user can read in full anyway.
 */
export interface CatalogueCursor {
  readonly years: number;
  readonly id: string;
}

export const encodeCursor = (cursor: CatalogueCursor): string =>
  Buffer.from(`${cursor.years}|${cursor.id}`, 'utf8').toString('base64url');

export function decodeCursor(raw: string): Result<CatalogueCursor, DomainError> {
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

export const cursorInvalid = (): DomainError =>
  new DomainError('insights.cursor_invalid', 'That cursor is not readable.');
