import { handleTagDashboard } from '@/modules/verse';

export const dynamic = 'force-dynamic';

/**
 * Params arrive as a promise in Next 16, and the id is passed to the handler
 * rather than re-derived from the URL — see the sibling route for why.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ tagId: string }> },
): Promise<Response> {
  const { tagId } = await context.params;
  return handleTagDashboard(request, tagId);
}
