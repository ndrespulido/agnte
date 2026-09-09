import type { Media } from './media';
import type { MediaVariant } from './variant';

/**
 * The ports the media module needs (hexagonal architecture, architecture.md
 * §1). Stated in the domain's vocabulary; infrastructure/ implements them
 * against Prisma, R2, and Cloud Tasks.
 */

export interface MediaRepository {
  findById(id: string): Promise<Media | null>;

  /** Scoped to the owner, for the same reason verse's `TagRepository` scopes
   * by owner: this is what turns request-supplied ids into rows, and a
   * request naming someone else's media must come back short rather than
   * handing back a row the caller can then act on. */
  findManyByIds(ownerId: string, ids: readonly string[]): Promise<Media[]>;

  create(media: Media): Promise<void>;

  /**
   * @returns false when `expectedVersion` no longer matches — the caller turns
   * that into 409 with server state (architecture.md §2) — or when the status
   * transition itself is not one the state machine in domain/media.ts allows.
   * Both failure modes are folded into one boolean here because both mean the
   * same thing to a caller: the write it asked for did not happen, go re-read
   * and decide again.
   */
  update(media: Media, expectedVersion: number): Promise<boolean>;

  delete(id: string, expectedVersion: number): Promise<boolean>;

  createVariant(variant: MediaVariant): Promise<void>;

  variantsFor(mediaId: string): Promise<MediaVariant[]>;

  /** The timeline's N+1 guard, same shape as verse's `tagsOfMany`. */
  variantsForMany(mediaIds: readonly string[]): Promise<Map<string, MediaVariant[]>>;
}

/**
 * An upload target: where to send the bytes, and what the client must send
 * alongside them.
 *
 * `headers` exists because the R2 adapter signs `Content-Type` and
 * `Content-Length` into the URL — a PUT sent without matching headers is
 * rejected by R2 itself, which is the first (imperfect but free) layer against
 * an upload that lies about what it is. The local adapter returns an empty
 * object; its dev-only route trusts whatever arrives.
 */
export interface UploadTarget {
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
}

export interface StoredObjectInfo {
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

export interface MediaBlobStore {
  presignUpload(input: {
    key: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<UploadTarget>;

  /** A short-lived signed URL for reading, or null if nothing is at that key. */
  presignDownload(key: string, expiresInSeconds: number): Promise<string | null>;

  /** What actually landed at a key — the check that makes `presignUpload`'s
   * declared size and content type more than an honor system. Null if nothing
   * is there yet. */
  head(key: string): Promise<StoredObjectInfo | null>;

  readBuffer(key: string): Promise<Buffer | null>;

  writeBuffer(key: string, body: Buffer, contentType: string): Promise<void>;

  delete(key: string): Promise<void>;
}

/**
 * Deferred thumbnail generation.
 *
 * Named in media's own vocabulary — "enqueue a thumbnail job" — rather than as
 * a generic "publish an event" or "create a task", which are shared/infra
 * concepts the domain has no business knowing the name of. infrastructure/
 * implements this against `shared/infra/deferred-jobs`.
 */
export interface ThumbnailQueue {
  enqueueThumbnailJob(mediaId: string): Promise<void>;
}
