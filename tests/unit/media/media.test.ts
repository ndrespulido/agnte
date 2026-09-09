import { describe, expect, it } from 'vitest';
import { fixedClock } from '@/shared/kernel';
import { MediaErrorCode } from '@/modules/media/domain/errors';
import {
  ALLOWED_CONTENT_TYPES,
  MAX_DECLARED_BYTES,
  canTransition,
  createPendingMedia,
  extensionFor,
  isAllowedContentType,
  originalKeyFor,
  parseContentType,
  parseDeclaredSize,
  transition,
} from '@/modules/media/domain/media';

const AT = new Date('2026-09-09T00:00:00.000Z');

describe('parseContentType', () => {
  it.each(ALLOWED_CONTENT_TYPES)('accepts %s', (type) => {
    const result = parseContentType(type);
    expect(result.ok && result.value).toBe(type);
  });

  it.each(['image/heic', 'image/gif', 'video/mp4', 'application/pdf', 'text/plain', ''])(
    'refuses %j',
    (type) => {
      const result = parseContentType(type);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe(MediaErrorCode.ContentTypeNotAllowed);
    },
  );

  it('is case-sensitive, matching how a browser actually sends it', () => {
    // A MIME type is lowercase by convention but not by grammar; refusing an
    // unexpected case is safer than silently normalising something the
    // browser never actually sends this way.
    expect(parseContentType('IMAGE/JPEG').ok).toBe(false);
  });
});

describe('isAllowedContentType', () => {
  it('agrees with parseContentType on every case', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', '']) {
      expect(isAllowedContentType(type)).toBe(parseContentType(type).ok);
    }
  });
});

describe('parseDeclaredSize', () => {
  it('accepts a realistic downscaled photo', () => {
    expect(parseDeclaredSize(400_000).ok).toBe(true);
  });

  it('accepts exactly the cap and refuses one byte over it', () => {
    expect(parseDeclaredSize(MAX_DECLARED_BYTES).ok).toBe(true);
    expect(parseDeclaredSize(MAX_DECLARED_BYTES + 1).ok).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %p', (bytes) => {
    const result = parseDeclaredSize(bytes);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe(MediaErrorCode.TooLarge);
  });
});

describe('extensionFor', () => {
  it('is the short, common spelling for jpeg', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
  });

  it('matches every allowed content type', () => {
    for (const type of ALLOWED_CONTENT_TYPES) {
      expect(() => extensionFor(type)).not.toThrow();
    }
  });
});

describe('originalKeyFor', () => {
  it('scopes the key by owner and names it by media id', () => {
    const key = originalKeyFor('owner-1', 'media-1', 'image/jpeg');
    expect(key).toBe('media/owner-1/media-1/original.jpg');
  });

  it('gives two different owners two different keys for the same media id', () => {
    // Not a realistic collision (ids are UUIDs), but the key must be a
    // function of the owner too, not just the media id, since ownership is
    // part of what a storage-layer ACL would eventually key off.
    const a = originalKeyFor('owner-a', 'm1', 'image/png');
    const b = originalKeyFor('owner-b', 'm1', 'image/png');
    expect(a).not.toBe(b);
  });
});

describe('createPendingMedia', () => {
  it('starts pending, at version 0, with equal timestamps', () => {
    const media = createPendingMedia({
      ownerId: 'owner-1',
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      clock: fixedClock(AT),
    });

    expect(media.status).toBe('pending');
    expect(media.version).toBe(0);
    expect(media.createdAt).toEqual(media.updatedAt);
    expect(media.createdAt).toEqual(AT);
  });

  it('honours a client-generated id', () => {
    // Offline-created rows arrive with their final id (architecture.md §2), the
    // same rule Verse and Tag follow.
    const media = createPendingMedia({
      id: '0195e2c0-0000-7000-8000-000000000001',
      ownerId: 'owner-1',
      contentType: 'image/jpeg',
      declaredSizeBytes: 1,
      clock: fixedClock(AT),
    });
    expect(media.id).toBe('0195e2c0-0000-7000-8000-000000000001');
  });

  it('mints a time-sortable id when none is given', () => {
    const a = createPendingMedia({
      ownerId: 'o',
      contentType: 'image/jpeg',
      declaredSizeBytes: 1,
      clock: fixedClock(new Date('2026-01-01T00:00:00Z')),
    });
    const b = createPendingMedia({
      ownerId: 'o',
      contentType: 'image/jpeg',
      declaredSizeBytes: 1,
      clock: fixedClock(new Date('2027-01-01T00:00:00Z')),
    });
    expect(a.id < b.id).toBe(true);
  });

  it('derives the storage key from the owner, id and content type it was given', () => {
    const media = createPendingMedia({
      id: 'm1',
      ownerId: 'owner-1',
      contentType: 'image/webp',
      declaredSizeBytes: 1,
      clock: fixedClock(AT),
    });
    expect(media.storageKey).toBe(originalKeyFor('owner-1', 'm1', 'image/webp'));
  });
});

describe('the status state machine', () => {
  it('allows pending -> processing -> ready', () => {
    expect(canTransition('pending', 'processing')).toBe(true);
    expect(canTransition('processing', 'ready')).toBe(true);
  });

  it('allows pending or processing to fail', () => {
    expect(canTransition('pending', 'failed')).toBe(true);
    expect(canTransition('processing', 'failed')).toBe(true);
  });

  it('has no path out of ready or failed', () => {
    // Reprocessing a finished Media would mean a signed URL already handed to
    // a client could start pointing at different bytes.
    for (const to of ['pending', 'processing', 'ready', 'failed'] as const) {
      expect(canTransition('ready', to)).toBe(false);
      expect(canTransition('failed', to)).toBe(false);
    }
  });

  it('refuses to skip a state', () => {
    expect(canTransition('pending', 'ready')).toBe(false);
  });

  it('refuses a self-transition, including on the terminal states', () => {
    for (const state of ['pending', 'processing', 'ready', 'failed'] as const) {
      expect(canTransition(state, state)).toBe(false);
    }
  });
});

describe('transition', () => {
  const pendingMedia = () =>
    createPendingMedia({
      ownerId: 'owner-1',
      contentType: 'image/jpeg',
      declaredSizeBytes: 1,
      clock: fixedClock(AT),
    });

  it('bumps the version and moves updatedAt, leaving createdAt alone', () => {
    const media = pendingMedia();
    const later = new Date(AT.getTime() + 1000);
    const result = transition(media, 'processing', fixedClock(later));

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.version).toBe(1);
    expect(result.ok && result.value.status).toBe('processing');
    expect(result.ok && result.value.createdAt).toEqual(media.createdAt);
    expect(result.ok && result.value.updatedAt).toEqual(later);
  });

  it('does not mutate the row it was given', () => {
    const media = pendingMedia();
    transition(media, 'processing', fixedClock(AT));
    expect(media.status).toBe('pending');
    expect(media.version).toBe(0);
  });

  it('refuses an illegal transition with a specific error', () => {
    const media = pendingMedia();
    const result = transition(media, 'ready', fixedClock(AT));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe(MediaErrorCode.NotPending);
  });

  it('reports the terminal states with the "not ready" error, not "not pending"', () => {
    // The two illegal-transition errors point at different fixes: "not
    // pending" means "you already confirmed or never will"; "not ready" means
    // "this hasn't finished processing". A caller re-confirming a `ready` row
    // wants the second message, not the first.
    const media = { ...pendingMedia(), status: 'ready' as const };
    const result = transition(media, 'processing', fixedClock(AT));
    expect(!result.ok && result.error.code).toBe(MediaErrorCode.NotReady);
  });
});
