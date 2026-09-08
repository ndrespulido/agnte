import { type Clock, type DomainError, type Result, err, ok } from '@/shared/kernel';
import {
  createTag,
  defaultShortcut,
  isVertical,
  parseShortcut,
  parseTagName,
  type Tag,
  type Vertical,
} from '../domain/tag';
import type { TagRepository } from '../domain/ports';
import {
  tagAlreadyExists,
  tagNameInvalid,
  tagShortcutTaken,
  visibilityInvalid,
} from '../domain/errors';
import { isVisibility, type Visibility } from '../domain/visibility';

export interface CreateTagInput {
  ownerId: string;
  name: string;
  displayName?: string | null | undefined;
  visibility?: string | undefined;
  /**
   * Three states, not two. Absent means "give me the default"; an explicit
   * string means "use this"; explicit null means "no shortcut, don't pick one
   * for me". Collapsing the last two would make opting out impossible.
   */
  shortcut?: string | null | undefined;
  vertical?: string | null | undefined;
}

export interface CreateTagDeps {
  tags: TagRepository;
  clock: Clock;
}

/**
 * Creating a tag, including the shortcut rules (CLAUDE.md).
 *
 * The shortcut is the interesting part. A vertical defaults to its first
 * letter, and on a collision the tag is simply left without one rather than
 * being handed a derived alternative — `.m` silently meaning `.medical` for a
 * user whose muscle memory says `.movies` files things in the wrong place,
 * which for this app can mean filing a medical note under a holiday.
 */
export async function createTagFor(
  input: CreateTagInput,
  deps: CreateTagDeps,
): Promise<Result<Tag, DomainError>> {
  const name = parseTagName(input.name);
  if (!name.ok) return name;

  let visibility: Visibility | undefined;
  if (input.visibility !== undefined) {
    if (!isVisibility(input.visibility)) {
      // Not `tagNameInvalid`; a bad visibility is its own mistake. Falling back
      // to a default would be worse: the caller asked for something specific
      // and would get silence plus, potentially, a more permissive answer.
      return err(visibilityInvalid());
    }
    visibility = input.visibility;
  }

  let vertical: Vertical | null = null;
  if (input.vertical !== undefined && input.vertical !== null) {
    if (!isVertical(input.vertical)) {
      return err(tagNameInvalid(`${input.vertical} is not one of the verticals`));
    }
    vertical = input.vertical;
  }

  let shortcut: string | null = null;
  if (input.shortcut === undefined) {
    // Nothing asked for: offer the default, avoiding what is taken.
    shortcut = defaultShortcut(name.value, await deps.tags.takenShortcuts(input.ownerId));
  } else if (input.shortcut !== null) {
    const parsed = parseShortcut(input.shortcut);
    if (!parsed.ok) return parsed;
    shortcut = parsed.value;
  }

  const tag = createTag({
    ownerId: input.ownerId,
    name: name.value,
    displayName: input.displayName ?? null,
    ...(visibility === undefined ? {} : { visibility }),
    shortcut,
    vertical,
    clock: deps.clock,
  });

  const outcome = await deps.tags.create(tag);

  if (outcome.kind === 'name-taken') return err(tagAlreadyExists(name.value));

  if (outcome.kind === 'shortcut-taken') {
    // An explicitly requested shortcut that is taken is an error the user can
    // act on. A *defaulted* one that lost a race is not — nobody asked for it,
    // so retry without it rather than failing a tag creation over a convenience.
    if (input.shortcut !== undefined) {
      return err(tagShortcutTaken(shortcut ?? ''));
    }

    const retry = { ...tag, shortcut: null };
    const second = await deps.tags.create(retry);
    if (second.kind === 'name-taken') return err(tagAlreadyExists(name.value));
    if (second.kind !== 'created') return err(tagShortcutTaken(''));
    return ok(retry);
  }

  return ok(tag);
}
