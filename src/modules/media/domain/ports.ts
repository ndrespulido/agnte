import type { Media } from './media';
import type { MediaVariant, VariantKind } from './variant';

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

  /**
   * `pending` rows created before a cutoff — uploads nobody ever confirmed.
   *
   * Returns the rows rather than deleting them, because their storage keys
   * are needed to clean up the bytes and the row is the only record of where
   * those live.
   */
  findAbandonedPending(before: Date): Promise<Media[]>;

  /**
   * `processing` rows that have sat there past a cutoff — a thumbnail job
   * that was never enqueued, or enqueued and never run.
   *
   * `confirmUpload` treats a failed enqueue as a missing convenience rather
   * than a failed upload, and deliberately swallows it. Without this, that
   * choice is terminal: the row is left `processing` forever, its photo shows
   * as a blank tile forever, and nothing anywhere ever looks at it again.
   * This is what makes the swallow recoverable instead.
   *
   * Cut on `updatedAt`, not `createdAt`: the row entered `processing` when
   * its upload was confirmed, which may be long after it was requested.
   */
  findStalledProcessing(before: Date): Promise<Media[]>;

  /** Unconditional, unlike `delete`: the pruner has no version to check. */
  deleteMany(ids: readonly string[]): Promise<number>;
}

/**
 * An upload target: where to send the bytes, and what the client must send
 * alongside them.
 *
 * `headers` carries `content-type`, which the R2 adapter signs into the URL —
 * a PUT sent with a different one is rejected by R2 itself. It does *not*
 * carry a content-length: a browser's `fetch` computes and sends that header
 * itself from the body's real length and refuses to let calling code override
 * it, which is exactly what makes signing it a genuine size restriction on a
 * real client — but it is also not something this codebase has verified,
 * because the local S3-compatible test double (s3rver) does not enforce
 * signed headers at all; a request signed for one content-length and sent
 * with another round-trips successfully in the test harness. So this is
 * documented as defence-in-depth, not relied on: the actual, tested boundary
 * against an oversized or mislabelled upload is `head()`, called after the
 * client confirms — see `application/confirm-upload.ts`.
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
  presignUpload(input: { key: string; contentType: string }): Promise<UploadTarget>;

  /**
   * A short-lived signed URL for reading.
   *
   * Does not check the key exists first — that would be a live request to R2
   * on every call, and every caller already knows from Postgres (a Media or
   * MediaVariant row) that the key it is asking about should exist before it
   * ever reaches this port.
   */
  presignDownload(key: string, expiresInSeconds: number): Promise<string>;

  /**
   * What actually landed at a key — the real check behind `presignUpload`'s
   * declared content type and size, called once the client confirms an
   * upload is done. Null if nothing is there yet, which on confirm means the
   * client is lying about having finished.
   */
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

export interface GeneratedVariant {
  readonly kind: VariantKind;
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Turns an original's bytes into its variants (architecture.md §8.3).
 *
 * Named for what it does in media's vocabulary, not "image processor" or
 * "resizer" — those describe the library behind `infrastructure/sharp-
 * thumbnail-generator.ts`, not the job this module asks of it. Takes only the
 * bytes: the original's declared content type is not needed because the
 * implementation reads the real format from the bytes themselves, the same
 * "trust what is actually there, not what was declared" rule `head()` above
 * follows for size.
 */
export interface ThumbnailGenerator {
  generate(original: Buffer): Promise<GeneratedVariant[]>;
}
