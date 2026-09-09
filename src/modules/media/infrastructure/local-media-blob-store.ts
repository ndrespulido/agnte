import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import type { MediaBlobStore, StoredObjectInfo, UploadTarget } from '../domain/ports';

/**
 * `npm run dev` has no R2 account (architecture.md §7.1). This stores blobs
 * on disk under `.local-storage/` — the same root the Phase 0 filesystem
 * adapter uses for the health check — and stands in for a presigned URL with
 * a same-origin path served by `src/app/dev/media/[...key]/route.ts`, the
 * dev-only route §7.1's local-development table calls for.
 *
 * A relative path rather than an absolute URL: this class has no request to
 * read an origin from, and a relative URL resolves against the page's own
 * origin when the browser calls `fetch`, so there is nothing to configure.
 */

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Keys come from application code, not directly from user input, but a key
 * containing `..` would still escape the storage root if one ever did — the
 * same rule `shared/infra/object-storage.ts` enforces for the same reason.
 */
function assertSafeKey(key: string): void {
  if (
    !key ||
    key.startsWith('/') ||
    normalize(key) !== key ||
    key.split('/').includes('..')
  ) {
    throw new Error(`Unsafe object key: ${JSON.stringify(key)}`);
  }
}

export class LocalMediaBlobStore implements MediaBlobStore {
  constructor(private readonly root: string = '.local-storage') {}

  private path(key: string): string {
    assertSafeKey(key);
    return join(this.root, key);
  }

  presignUpload(input: { key: string; contentType: string }): Promise<UploadTarget> {
    return Promise.resolve({
      url: `/dev/media/${input.key}`,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
    });
  }

  presignDownload(key: string): Promise<string> {
    return Promise.resolve(`/dev/media/${key}`);
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const info = await stat(this.path(key));
      return {
        sizeBytes: info.size,
        contentType: EXTENSION_CONTENT_TYPES[extname(key)] ?? null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readBuffer(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeBuffer(key: string, body: Buffer): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
