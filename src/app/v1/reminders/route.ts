import { handleCreateReminder, handleListReminders } from '@/modules/notifications';

export const dynamic = 'force-dynamic';

export const GET = handleListReminders;
export const POST = handleCreateReminder;
