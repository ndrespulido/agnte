import {
  handleListTagShares,
  handleRevokeTagShare,
  handleShareTag,
} from '@/modules/verse';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ tagId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { tagId } = await context.params;
  return handleListTagShares(request, tagId);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { tagId } = await context.params;
  return handleShareTag(request, tagId);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { tagId } = await context.params;
  return handleRevokeTagShare(request, tagId);
}
