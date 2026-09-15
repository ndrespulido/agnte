import { handleGetPreferences, handleUpdatePreferences } from '@/modules/notifications';

export const dynamic = 'force-dynamic';

export const GET = handleGetPreferences;
export const PUT = handleUpdatePreferences;
