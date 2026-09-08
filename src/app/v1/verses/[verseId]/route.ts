import { handleDeleteVerse, handleGetVerse, handleUpdateVerse } from '@/modules/verse';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ verseId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { verseId } = await context.params;
  return handleGetVerse(request, verseId);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { verseId } = await context.params;
  return handleUpdateVerse(request, verseId);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { verseId } = await context.params;
  return handleDeleteVerse(request, verseId);
}
