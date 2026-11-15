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

  /** The name it had where it came from, for display only. See `parseFileName`. */
  readonly fileName: string | null;

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

export type MediaKind = 'image' | 'audio' | 'video' | 'file';

/**
 * Every type that may be stored, with what it is and the extension it is kept
 * under. A closed list, mirrored by a CHECK in the migration.
 *
 * What is deliberately absent matters more than what is here: nothing a
 * browser would *run* if it were opened from a signed URL — no HTML, no SVG,
 * no JavaScript. The list is "things a person attaches to a memory", not
 * "anything".
 *
 * Only images are decoded server-side (the thumbnailer rejects one that is
 * not what it claims). The other kinds are stored as declared and served as
 * declared; nothing inspects their bytes.
 */
const TYPES = {
  'image/jpeg': { kind: 'image', extension: 'jpg' },
  'image/png': { kind: 'image', extension: 'png' },
  'image/webp': { kind: 'image', extension: 'webp' },

  // Voice notes. A browser records webm (Chrome, Firefox) or mp4 (Safari).
  // `.weba`, not `.webm`: the filesystem store reads the type back from the
  // extension, and sharing one with video made a voice note read as a video.
  'audio/webm': { kind: 'audio', extension: 'weba' },
  'audio/mp4': { kind: 'audio', extension: 'm4a' },
  'audio/mpeg': { kind: 'audio', extension: 'mp3' },
  'audio/ogg': { kind: 'audio', extension: 'ogg' },
  'audio/wav': { kind: 'audio', extension: 'wav' },

  'video/mp4': { kind: 'video', extension: 'mp4' },
  'video/webm': { kind: 'video', extension: 'webm' },
  'video/quicktime': { kind: 'video', extension: 'mov' },

  'application/pdf': { kind: 'file', extension: 'pdf' },
  'text/plain': { kind: 'file', extension: 'txt' },
  'text/csv': { kind: 'file', extension: 'csv' },
  // A calendar invitation and a contact card: the two things people forward
  // to themselves that are not documents.
  'text/calendar': { kind: 'file', extension: 'ics' },
  'text/vcard': { kind: 'file', extension: 'vcf' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'file',
    extension: 'docx',
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'file',
    extension: 'xlsx',
  },
} as const satisfies Record<string, { kind: MediaKind; extension: string }>;

export type AllowedContentType = keyof typeof TYPES;

export const ALLOWED_CONTENT_TYPES = Object.keys(TYPES) as AllowedContentType[];

export const isAllowedContentType = (value: string): value is AllowedContentType =>
  Object.hasOwn(TYPES, value);

/** A type this build does not know is treated as an opaque file, never drawn. */
export const kindOf = (contentType: string): MediaKind =>
  isAllowedContentType(contentType) ? TYPES[contentType].kind : 'file';

/**
 * The size cap, per kind.
 *
 * For an image this is generous relative to what a downscaled photo weighs
 * (§8.3: "a 4MB phone photo becomes ~400KB") — it caps the damage from a
 * client that skips downscaling. For video it *is* the limit, and a low one
 * on purpose: storage is the only thing here that grows without anyone doing
 * anything (cost discipline), and a timeline is not a video library. The real
 * backstop is `checkUpload` in application/, which checks what landed.
 */
const MAX_BYTES: Record<MediaKind, number> = {
  image: 15 * 1_000_000,
  audio: 15 * 1_000_000,
  file: 15 * 1_000_000,
  video: 50 * 1_000_000,
};

export const maxBytesFor = (contentType: string): number =>
  MAX_BYTES[kindOf(contentType)];

/** The image cap, kept by name for the callers and tests that mean exactly that. */
export const MAX_DECLARED_BYTES = MAX_BYTES.image;

export function parseContentType(value: string): Result<AllowedContentType, DomainError> {
  // A recorder reports `audio/webm;codecs=opus`. The parameters describe the
  // encoding, not the kind of thing it is, and storage keys on the bare type.
  const bare = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!isAllowedContentType(bare)) {
    return err(contentTypeNotAllowed(value, ALLOWED_CONTENT_TYPES));
  }
  return ok(bare);
}

export function parseDeclaredSize(
  bytes: number,
  contentType: AllowedContentType = 'image/jpeg',
): Result<number, DomainError> {
  const maximum = maxBytesFor(contentType);
  if (!Number.isFinite(bytes) || bytes <= 0) return err(tooLarge(maximum));
  if (bytes > maximum) return err(tooLarge(maximum));
  return ok(bytes);
}

export const MAX_FILE_NAME_LENGTH = 200;

/**
 * The name a file had on the device it came from, for showing and nothing
 * else — it is never part of a storage key or a path.
 *
 * Reduced to its last segment, because some browsers send a whole path, and
 * stripped of control characters. An empty result is "no name" rather than an
 * error: a pasted screenshot and a recorded voice note have none.
 */
export function parseFileName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const last = value.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- removing them is the point
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (clean === '') return null;
  return [...clean].slice(0, MAX_FILE_NAME_LENGTH).join('');
}

/** `jpg`, not `jpeg` — the shorter, more common spelling for a key/filename. */
export const extensionFor = (contentType: AllowedContentType): string =>
  TYPES[contentType].extension;

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
  fileName?: string | null;
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
    fileName: input.fileName ?? null,
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
