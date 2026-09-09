import { handleDeleteMedia } from '@/modules/media';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
): Promise<Response> {
  const { mediaId } = await context.params;
  return handleDeleteMedia(request, mediaId);
}
