import { loadConfig } from '@/shared/infra/config';
import { LocalMediaBlobStore } from '../infrastructure/local-media-blob-store';

/**
 * The dev-only route architecture.md §7.1's local-development table calls
 * for: "Filesystem under `.local-storage/`, served by a dev-only route."
 *
 * Constructs its own `LocalMediaBlobStore` directly rather than going through
 * `getMediaBlobStore()` (which everything else in the module uses): this
 * route's entire job is to *be* the filesystem backend, and the only way a
 * client ever ends up calling it is that the factory already chose the local
 * adapter when it built the presigned URL in the first place. Going through
 * the factory here would risk silently switching to R2 mid-request if R2
 * happened to be configured alongside `APP_ENV=local` — the one case this
 * route exists to never be reached in.
 *
 * Not mounted under `/internal/*`: that prefix and its shared-secret guard
 * (`shared/infra/internal-auth.ts`) are for Cloud Tasks and Cloud Scheduler
 * callbacks, a different kind of caller than "the browser doing the upload
 * this request is about." Gated instead by environment — every handler here
 * refuses outside `local` — so the route is a dead end in any deployed copy
 * of this code, deliberately, since it has no auth of its own.
 */

const store = new LocalMediaBlobStore();

const notLocal = (): boolean => loadConfig().APP_ENV !== 'local';

export async function handleDevMediaUpload(
  request: Request,
  keyParts: readonly string[],
): Promise<Response> {
  if (notLocal()) return new Response(null, { status: 404 });

  const key = keyParts.join('/');
  const body = Buffer.from(await request.arrayBuffer());
  await store.writeBuffer(key, body);

  return new Response(null, { status: 200 });
}

export async function handleDevMediaDownload(
  keyParts: readonly string[],
): Promise<Response> {
  if (notLocal()) return new Response(null, { status: 404 });

  const key = keyParts.join('/');
  const [body, info] = await Promise.all([store.readBuffer(key), store.head(key)]);
  if (!body) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': info?.contentType ?? 'application/octet-stream',
      'cache-control': 'no-store',
    },
  });
}
