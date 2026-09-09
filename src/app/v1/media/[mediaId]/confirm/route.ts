import { handleConfirmUpload } from '@/modules/media';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
): Promise<Response> {
  const { mediaId } = await context.params;
  return handleConfirmUpload(request, mediaId);
}
