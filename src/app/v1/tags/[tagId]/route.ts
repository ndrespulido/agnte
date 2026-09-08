import { handleDeleteTag, handleUpdateTag } from '@/modules/verse';

export const dynamic = 'force-dynamic';

/**
 * Next 16 hands route params as a promise, so they are awaited rather than
 * destructured. The handlers take the id as an argument instead of re-parsing
 * the URL — a route that derives its own id from the path is one refactor away
 * from disagreeing with the router about which resource it is acting on.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ tagId: string }> },
): Promise<Response> {
  const { tagId } = await context.params;
  return handleUpdateTag(request, tagId);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ tagId: string }> },
): Promise<Response> {
  const { tagId } = await context.params;
  return handleDeleteTag(request, tagId);
}
