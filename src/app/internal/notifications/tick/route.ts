import { handleNotificationsTick } from '@/modules/notifications';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The reminder dispatcher's entry point (architecture.md §8.4).
 *
 * Called by a wake-up at each reminder's own fire time, and the daily sweep
 * runs the same tick as a safety net. It used to be polled by a five-minute
 * Cloud Scheduler job; `WakeUps` says why that was retired.
 */
export const POST = handleNotificationsTick;
