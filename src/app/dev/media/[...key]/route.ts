import { handleDevMediaDownload, handleDevMediaUpload } from '@/modules/media';

export const dynamic = 'force-dynamic';

/**
 * Stands in for R2 locally (architecture.md §7.1): `LocalMediaBlobStore`
 * hands out same-origin `/dev/media/<key>` URLs instead of presigned ones,
 * and this route is what makes those URLs resolve to something. Both
 * handlers 404 outside `APP_ENV=local` on their own, so this file carries no
 * environment check of its own.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key } = await context.params;
  return handleDevMediaUpload(request, key);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { key } = await context.params;
  return handleDevMediaDownload(key);
}
