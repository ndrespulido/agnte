import { handleThumbnailJob } from '@/modules/media';

export const dynamic = 'force-dynamic';
// sharp ships native bindings; this cannot run on an edge runtime.
export const runtime = 'nodejs';

export const POST = handleThumbnailJob;
