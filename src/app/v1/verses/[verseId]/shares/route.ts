import { handleRevokeVerseShare, handleShareVerse } from '@/modules/verse';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ verseId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { verseId } = await context.params;
  return handleShareVerse(request, verseId);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { verseId } = await context.params;
  return handleRevokeVerseShare(request, verseId);
}
