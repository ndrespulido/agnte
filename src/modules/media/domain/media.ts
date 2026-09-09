import {
  uuidv7,
  type Clock,
  type DomainError,
  type Result,
  err,
  ok,
} from '@/shared/kernel';
import { contentTypeNotAllowed, notPending, notReady, tooLarge } from './errors';

/**
 * A single uploaded photo (architecture.md §8.3).
 *
 * Scoped to images only. Neither CLAUDE.md's verticals nor §8.3 mention video
 * or audio, and the whole pipeline this phase builds — canvas downscale in the
 * browser, sharp variants on the server — is image-specific. Widening to other
 * media kinds is a real piece of future work, not an oversight.
 *
 * A Media row exists before the bytes do: `requestUpload` (application layer)
 * creates it in `pending` the moment a client asks for a place to put a file,
 * because the client needs the id immediately to attach it to a Verse composed
 * offline (architecture.md §8.1) — the same reason Verse ids are client-
 * generated rather than assigned on save.
 */
export interface Media {
  readonly id: string;
  readonly ownerId: string;

  readonly status: MediaStatus;

  /** The content type declared at upload time, and the object's extension. */
  readonly contentType: string;

  /** Declared at upload time; verified against the real object on confirm. */
  readonly declaredSizeBytes: number;

  /** Where the original lives in object storage. Never listed in an API response. */
  readonly storageKey: string;

  readonly createdAt: Date;
  readonly updatedAt: Date;

  /** Optimistic concurrency (architecture.md §2). */
  readonly version: number;
}

/**
 * `pending` → `processing` → `ready`, or `failed` from either of the middle
 * two. There is no path back from `failed`: a client that hits it uploads
 * again as a new Media rather than retrying the same row, which is simpler
 * than re-opening a closed upload window and costs nothing — ids are cheap.
 */
export type MediaStatus = 'pending' | 'processing' | 'ready' | 'failed';

/** Kept in one place so the state machine can be asserted on rather than restated. */
const TRANSITIONS: Record<MediaStatus, readonly MediaStatus[]> = {
  pending: ['processing', 'failed'],
  processing: ['ready', 'failed'],
  ready: [],
  failed: [],
};

export const canTransition = (from: MediaStatus, to: MediaStatus): boolean =>
  TRANSITIONS[from].includes(to);

/**
 * Accepted originals.
 *
 * Deliberately not HEIC: the browser-side downscale re-encodes through a
 * canvas before upload (§8.3), and `canvas.toBlob` only ever produces one of
 * these three — a phone's native HEIC never reaches the network. Accepting it
 * server-side would mean carrying libheif for a path nothing takes.
 */
export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const isAllowedContentType = (value: string): value is AllowedContentType =>
  (ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);

/**
 * Generous relative to what a downscaled photo actually weighs (§8.3: "a 4MB
 * phone photo becomes ~400KB"). This is not the size control — it exists to
 * cap the damage from a client that skips downscaling, not to enforce the
 * target. The real backstop is `assertUploadMatches` in application/, which
 * checks what actually landed in storage.
 */
export const MAX_DECLARED_BYTES = 15 * 1_000_000;

export function parseContentType(value: string): Result<AllowedContentType, DomainError> {
  if (!isAllowedContentType(value)) {
    return err(contentTypeNotAllowed(value, ALLOWED_CONTENT_TYPES));
  }
  return ok(value);
}

export function parseDeclaredSize(bytes: number): Result<number, DomainError> {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return err(tooLarge(MAX_DECLARED_BYTES));
  }
  if (bytes > MAX_DECLARED_BYTES) return err(tooLarge(MAX_DECLARED_BYTES));
  return ok(bytes);
}

/** `jpg`, not `jpeg` — the shorter, more common spelling for a key/filename. */
export function extensionFor(contentType: AllowedContentType): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
  }
}

/**
 * The object key an original is stored under.
 *
 * Scoped by owner so a per-user prefix could gate access at the storage layer
 * later, and named by the media id so it never collides and never needs a
 * lookup to find. Kept in the domain because the *shape* of the key is a rule
 * every adapter must agree on, even though no adapter lives here.
 */
export const originalKeyFor = (
  ownerId: string,
  mediaId: string,
  contentType: AllowedContentType,
): string => `media/${ownerId}/${mediaId}/original.${extensionFor(contentType)}`;

export function createPendingMedia(input: {
  id?: string;
  ownerId: string;
  contentType: AllowedContentType;
  declaredSizeBytes: number;
  clock: Clock;
}): Media {
  const now = input.clock.now();
  const id = input.id ?? uuidv7(now.getTime());

  return {
    id,
    ownerId: input.ownerId,
    status: 'pending',
    contentType: input.contentType,
    declaredSizeBytes: input.declaredSizeBytes,
    storageKey: originalKeyFor(input.ownerId, id, input.contentType),
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

/**
 * Moves a Media to a new status, bumping its version.
 *
 * Refuses a transition the state machine does not allow — the guard that
 * makes `TRANSITIONS` load-bearing rather than decorative. A confirm request
 * replayed against an already-`ready` row hits this and is rejected upstream
 * with a specific error, not silently reprocessed.
 */
export function transition(
  media: Media,
  to: MediaStatus,
  clock: Clock,
): Result<Media, DomainError> {
  if (!canTransition(media.status, to)) {
    return err(media.status === 'pending' ? notPending() : notReady());
  }

  return ok({ ...media, status: to, updatedAt: clock.now(), version: media.version + 1 });
}
