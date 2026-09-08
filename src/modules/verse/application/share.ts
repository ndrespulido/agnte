import { type Clock, type DomainError, type Result, err, ok } from '@/shared/kernel';
import type {
  ShareRepository,
  SharePermission,
  TagRepository,
  TagShare,
  VerseRepository,
  VerseShare,
} from '../domain/ports';
import {
  forbidden,
  shareInvalid,
  shareNotPermitted,
  tagNotFound,
} from '../domain/errors';

/**
 * Sharing a tag or a single verse with another person.
 *
 * Two things are deliberately absent, and both are called out rather than left
 * to be discovered:
 *
 * 1. **`contribute` is refused.** The column accepts it and the type carries
 *    it, but nothing honours it — whether a collaborator may add Verses to a
 *    shared tag is CLAUDE.md's first open decision. Refusing loudly is better
 *    than accepting a grant that silently behaves as read-only, which would
 *    leave someone believing they had given access they had not.
 *
 * 2. **You share with a user id, not an email address.** Sharing by address is
 *    what people actually want, but "share with x@example.com" that fails for
 *    an unknown address is a user-enumeration oracle — anyone could test which
 *    addresses have accounts. Doing it properly means an invitation flow that
 *    answers identically either way and sends mail to a stranger, which is its
 *    own piece of work with its own abuse surface. Until then this endpoint is
 *    honest about being a mechanism rather than a feature.
 */

export interface ShareDeps {
  shares: ShareRepository;
  tags: TagRepository;
  verses: VerseRepository;
  clock: Clock;
}

const checkPermission = (permission: string): Result<SharePermission, DomainError> => {
  if (permission === 'read') return ok('read');
  if (permission === 'contribute') return err(shareNotPermitted());
  return err(shareInvalid("permission must be 'read'"));
};

export async function shareTagWith(
  input: {
    ownerId: string;
    tagId: string;
    granteeId: string;
    permission: string;
  },
  deps: Pick<ShareDeps, 'shares' | 'tags' | 'clock'>,
): Promise<Result<TagShare, DomainError>> {
  const permission = checkPermission(input.permission);
  if (!permission.ok) return permission;

  // Sharing with yourself is refused rather than being a no-op: it is always a
  // mistake, and a silent success would leave the user believing they had
  // shared with someone else.
  if (input.granteeId === input.ownerId) {
    return err(shareInvalid('you already have access to your own tag'));
  }

  const tag = await deps.tags.findById(input.tagId);
  if (!tag || tag.ownerId !== input.ownerId) return err(tagNotFound());

  const share: TagShare = {
    tagId: input.tagId,
    granteeId: input.granteeId,
    permission: permission.value,
    createdAt: deps.clock.now(),
  };

  await deps.shares.shareTag(share);
  return ok(share);
}

export async function shareVerseWith(
  input: {
    ownerId: string;
    verseId: string;
    granteeId: string;
    permission: string;
  },
  deps: Pick<ShareDeps, 'shares' | 'verses' | 'clock'>,
): Promise<Result<VerseShare, DomainError>> {
  const permission = checkPermission(input.permission);
  if (!permission.ok) return permission;

  if (input.granteeId === input.ownerId) {
    return err(shareInvalid('you already have access to your own verse'));
  }

  const verse = await deps.verses.findById(input.verseId);
  if (!verse || verse.ownerId !== input.ownerId) return err(forbidden());

  const share: VerseShare = {
    verseId: input.verseId,
    granteeId: input.granteeId,
    permission: permission.value,
    createdAt: deps.clock.now(),
  };

  await deps.shares.shareVerse(share);
  return ok(share);
}

export async function revokeTagShare(
  input: { ownerId: string; tagId: string; granteeId: string },
  deps: Pick<ShareDeps, 'shares' | 'tags'>,
): Promise<Result<null, DomainError>> {
  const tag = await deps.tags.findById(input.tagId);
  if (!tag || tag.ownerId !== input.ownerId) return err(tagNotFound());

  // Revoking a share that was never granted succeeds. The caller's intent —
  // "this person must not have access" — is satisfied either way, and a 404
  // here would tell them something about a share they are entitled to change.
  await deps.shares.unshareTag(input.tagId, input.granteeId);
  return ok(null);
}

export async function revokeVerseShare(
  input: { ownerId: string; verseId: string; granteeId: string },
  deps: Pick<ShareDeps, 'shares' | 'verses'>,
): Promise<Result<null, DomainError>> {
  const verse = await deps.verses.findById(input.verseId);
  if (!verse || verse.ownerId !== input.ownerId) return err(forbidden());

  await deps.shares.unshareVerse(input.verseId, input.granteeId);
  return ok(null);
}

export async function listTagShares(
  input: { ownerId: string; tagId: string },
  deps: Pick<ShareDeps, 'shares' | 'tags'>,
): Promise<Result<TagShare[], DomainError>> {
  const tag = await deps.tags.findById(input.tagId);
  if (!tag || tag.ownerId !== input.ownerId) return err(tagNotFound());
  return ok(await deps.shares.listTagShares(input.tagId));
}
