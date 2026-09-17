import { handleSubscribePush, handleUnsubscribePush } from '@/modules/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = handleSubscribePush;
export const DELETE = handleUnsubscribePush;
