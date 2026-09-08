import { uuidv7, type Clock, type Result, err, ok } from '@/shared/kernel';
import { DEFAULT_VISIBILITY, type Visibility } from './visibility';
import { tagNameInvalid, tagShortcutInvalid } from './errors';

/**
 * The single grouping primitive (CLAUDE.md).
 *
 * A Verse belongs to many tags at once — "tables this row is stored in", not
 * "folder it sits in" — and each tag is also a filterable sub-timeline. There
 * is deliberately no Timeline entity; a timeline is a filtered view over tags.
 *
 * The leading dot is presentation. It is how a tag is written and typed
 * (`.barcelona-trip`), but storing it would put a constant in every row and
 * make every comparison depend on remembering it. `name` holds `barcelona-trip`
 * and `format` puts the dot back.
 */
export interface Tag {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly displayName: string | null;
  readonly visibility: Visibility;

  /**
   * Unique per user, so `.m` means one thing everywhere in the app
   * (CLAUDE.md: shortcut scope is global per user, not per-tag context).
   * Null when the tag has none — including a vertical whose default letter was
   * already taken.
   */
  readonly shortcut: string | null;

  /** Set when the tag was created from a vertical; null for an ordinary tag. */
  readonly vertical: Vertical | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export const MAX_TAG_NAME_LENGTH = 64;
export const MAX_SHORTCUT_LENGTH = 8;

/**
 * Lowercase letters, digits and single inner hyphens.
 *
 * Anchored with ^...$ deliberately: an unanchored test would accept
 * ".holiday\n.medical" as a single tag name, and a newline inside a name is
 * exactly the sort of thing that later reappears in a denormalized search
 * column or a CSV export as two rows.
 */
const TAG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHORTCUT = /^[a-z0-9]+$/;

/**
 * The five verticals (CLAUDE.md).
 *
 * Their property sets are *suggestions* that pre-fill a form. Every field stays
 * optional, and a Verse tagged `.flight` with nothing but a photo is valid —
 * that is a design rule, not an edge case, so nothing here may be read as a
 * required-field list.
 */
export const VERTICALS = {
  flight: ['airline', 'flight-number', 'from', 'to', 'departure', 'arrival', 'seat'],
  hotel: ['name', 'address', 'check-in', 'check-out', 'room', 'confirmation'],
  restaurant: ['name', 'address', 'cuisine', 'party-size', 'reservation'],
  concert: ['artist', 'venue', 'city', 'support', 'seat'],
  movie: ['title', 'director', 'year', 'where', 'with'],
} as const satisfies Record<string, readonly string[]>;

export type Vertical = keyof typeof VERTICALS;

export const VERTICAL_NAMES = Object.keys(VERTICALS) as Vertical[];

export const isVertical = (value: unknown): value is Vertical =>
  typeof value === 'string' && Object.hasOwn(VERTICALS, value);

/** The suggested property keys for a vertical. Never a validation rule. */
export const suggestedProperties = (vertical: Vertical): readonly string[] =>
  VERTICALS[vertical];

/**
 * Parses a tag as a person types it.
 *
 * Accepts `.barcelona-trip` or `barcelona-trip` — the dot is how tags are
 * written, and rejecting the form the UI shows would be hostile. Trims and
 * lowercases, because `.Barcelona` and `.barcelona` are the same tag and
 * discovering otherwise after a month of use is unrecoverable.
 */
export function parseTagName(
  input: string,
): Result<string, ReturnType<typeof tagNameInvalid>> {
  const trimmed = input.trim().replace(/^\.+/, '').toLowerCase();

  if (trimmed.length === 0) return err(tagNameInvalid('it is empty'));
  if (trimmed.length > MAX_TAG_NAME_LENGTH) {
    return err(tagNameInvalid(`it is longer than ${MAX_TAG_NAME_LENGTH} characters`));
  }
  if (!TAG_NAME.test(trimmed)) {
    return err(
      tagNameInvalid('use lowercase letters, digits and hyphens, as in .barcelona-trip'),
    );
  }

  return ok(trimmed);
}

/** Parses a shortcut, with the same leading-dot tolerance as a tag name. */
export function parseShortcut(
  input: string,
): Result<string, ReturnType<typeof tagShortcutInvalid>> {
  const trimmed = input.trim().replace(/^\.+/, '').toLowerCase();

  if (trimmed.length === 0) return err(tagShortcutInvalid('it is empty'));
  if (trimmed.length > MAX_SHORTCUT_LENGTH) {
    return err(tagShortcutInvalid(`it is longer than ${MAX_SHORTCUT_LENGTH} characters`));
  }
  if (!SHORTCUT.test(trimmed)) {
    return err(tagShortcutInvalid('use lowercase letters and digits only'));
  }

  return ok(trimmed);
}

/** How a tag is written: `.barcelona-trip`. */
export const format = (tag: Pick<Tag, 'name'>): string => `.${tag.name}`;

/**
 * The shortcut a tag would like, given what is already taken.
 *
 * Verticals default to their first letter (CLAUDE.md). On a collision the
 * second tag is simply left without a default rather than being handed some
 * derived alternative: a shortcut nobody chose is worse than no shortcut,
 * because `.m` silently meaning `.movies` for one user and `.medical` for
 * another is how muscle memory files things in the wrong place. The user can
 * always set one explicitly.
 */
export function defaultShortcut(name: string, taken: ReadonlySet<string>): string | null {
  const first = name[0];
  if (first === undefined) return null;
  return taken.has(first) ? null : first;
}

export function createTag(input: {
  ownerId: string;
  name: string;
  displayName?: string | null;
  visibility?: Visibility;
  shortcut?: string | null;
  vertical?: Vertical | null;
  clock: Clock;
}): Tag {
  const now = input.clock.now();
  return {
    id: uuidv7(now.getTime()),
    ownerId: input.ownerId,
    name: input.name,
    displayName: input.displayName ?? null,
    visibility: input.visibility ?? DEFAULT_VISIBILITY,
    shortcut: input.shortcut ?? null,
    vertical: input.vertical ?? null,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}
