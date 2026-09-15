/**
 * The notifications module's public surface (§1.1).
 *
 * Note what is not here: no repository, and no `ScheduledNotification` write
 * path. Another module that could reach the repository could schedule a
 * reminder for a user it has no business reminding, or read one it has no
 * business seeing — the same argument verse's index.ts makes for exporting its
 * visibility resolver and nothing that bypasses it.
 *
 * `purgeForUser` is the exception, and it is the point of the boundaries: when
 * privacy publishes `user.erasure_requested` (§8.7), this module purges its own
 * data and nothing reaches into its tables to do it for it.
 */

export {
  handleCreateReminder,
  handleListReminders,
  handleGetPreferences,
  handleUpdatePreferences,
} from './api/reminder-routes';

export { handleNotificationsTick } from './api/tick-route';

export { purgeForUser } from './application/purge';

export { MAX_ATTEMPTS, MAX_PER_TICK } from './application/dispatch';
export type { TickResult } from './application/dispatch';
