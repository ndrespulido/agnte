import { handleCreateTag, handleListTags } from '@/modules/verse';

export const dynamic = 'force-dynamic';

export const GET = handleListTags;
export const POST = handleCreateTag;
