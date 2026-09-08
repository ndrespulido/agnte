import { type Clock, type DomainError, type Result, err, ok } from '@/shared/kernel';
import { parseShortcut, parseTagName, type Tag } from '../domain/tag';
import type { TagRepository, VerseRepository } from '../domain/ports';
import {
  tagAlreadyExists,
  tagNotFound,
  tagShortcutTaken,
  versionConflict,
  visibilityInvalid,
} from '../domain/errors';
import { isVisibility } from '../domain/visibility';
import { DomainError as DomainErrorClass } from '@/shared/kernel';
import { VerseErrorCode } from '../domain/errors';

export interface TagDeps {
  tags: TagRepository;
  verses: VerseRepository;
  clock: Clock;
}

export const listTags = (ownerId: string, deps: Pick<TagDeps, 'tags'>): Promise<Tag[]> =>
  deps.tags.listForOwner(ownerId);

export interface UpdateTagInput {
  ownerId: string;
  tagId: string;
  expectedVersion: number;
  name?: string | undefined;
  displayName?: string | null | undefined;
  visibility?: string | undefined;
  shortcut?: string | null | undefined;
}

/**
 * Renaming a tag, changing its visibility, or moving its shortcut.
 *
 * Ownership is checked by comparing the loaded row's owner, and a mismatch
 * answers "not found" rather than "not yours" — telling a caller that a tag id
 * exists but belongs to someone else is an enumeration leak, the same one
 * identity avoids on sign-in.
 */
export async function updateTag(
  input: UpdateTagInput,
  deps: Pick<TagDeps, 'tags' | 'clock'>,
): Promise<Result<Tag, DomainError>> {
  const existing = await deps.tags.findById(input.tagId);
  if (!existing || existing.ownerId !== input.ownerId) return err(tagNotFound());

  let name = existing.name;
  if (input.name !== undefined) {
    const parsed = parseTagName(input.name);
    if (!parsed.ok) return parsed;
    name = parsed.value;
  }

  let visibility = existing.visibility;
  if (input.visibility !== undefined) {
    if (!isVisibility(input.visibility)) return err(visibilityInvalid());
    visibility = input.visibility;
  }

  let shortcut = existing.shortcut;
  if (input.shortcut !== undefined) {
    if (input.shortcut === null) {
      shortcut = null;
    } else {
      const parsed = parseShortcut(input.shortcut);
      if (!parsed.ok) return parsed;
      shortcut = parsed.value;
    }
  }

  const updated: Tag = {
    ...existing,
    name,
    displayName:
      input.displayName === undefined ? existing.displayName : input.displayName,
    visibility,
    shortcut,
    updatedAt: deps.clock.now(),
    version: existing.version + 1,
  };

  // Uniqueness is arbitrated by the index rather than a lookup, for the same
  // reason creation does it: a check-then-write has a window another request
  // fits through. The three ways this can fail are reported apart, because they
  // point the user at three different things.
  const outcome = await deps.tags.update(updated, input.expectedVersion);

  if (outcome.kind === 'name-taken') return err(tagAlreadyExists(name));
  if (outcome.kind === 'shortcut-taken') return err(tagShortcutTaken(shortcut ?? ''));

  if (outcome.kind === 'stale') {
    const current = await deps.tags.findById(input.tagId);
    return err(versionConflict(input.expectedVersion, current?.version ?? -1));
  }

  return ok(updated);
}

export interface DeleteTagInput {
  ownerId: string;
  tagId: string;
  expectedVersion: number;
}

/**
 * Deleting a tag, refusing when it would strip a verse's last tag.
 *
 * This is the rule the database cannot enforce (a CHECK cannot see another
 * table), and `ON DELETE CASCADE` on the join is perfectly willing to leave a
 * verse with none. The count is reported so the answer is actionable: "3 verses
 * have only this tag" tells the user what to fix, where "cannot delete" does
 * not.
 */
export async function deleteTag(
  input: DeleteTagInput,
  deps: Pick<TagDeps, 'tags' | 'verses'>,
): Promise<Result<null, DomainError>> {
  const existing = await deps.tags.findById(input.tagId);
  if (!existing || existing.ownerId !== input.ownerId) return err(tagNotFound());

  const orphaned = await deps.verses.countVersesOnlyTaggedWith(input.tagId);
  if (orphaned > 0) {
    return err(
      new DomainErrorClass(
        VerseErrorCode.NoTags,
        orphaned === 1
          ? 'One verse has only this tag. Give it another tag first, or delete it.'
          : `${orphaned} verses have only this tag. Give them another tag first, or delete them.`,
        { details: { orphaned } },
      ),
    );
  }

  const deleted = await deps.tags.delete(input.tagId, input.expectedVersion);
  if (!deleted) {
    const current = await deps.tags.findById(input.tagId);
    return err(versionConflict(input.expectedVersion, current?.version ?? -1));
  }

  return ok(null);
}
