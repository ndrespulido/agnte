import { getDatabase } from '@/shared/infra/database';

/** This person's reminders and quiet hours, for a data export (§8.5). */
export async function exportForUser(userId: string): Promise<{
  reminders: unknown[];
  preferences: unknown;
}> {
  const db = getDatabase();
  if (!db) throw new Error('notifications requires a database; DATABASE_URL is not set');

  const reminders = await db.$queryRaw<unknown[]>`
    SELECT id, verse_id, fire_at, start_at, occurrences, recurrence, status,
           title, body, created_at, updated_at
      FROM notifications.scheduled_notification
     WHERE user_id = ${userId}::uuid
     ORDER BY fire_at ASC
  `;

  const preferences = await db.$queryRaw<unknown[]>`
    SELECT quiet_start_minute, quiet_end_minute, time_zone
      FROM notifications.notification_preference
     WHERE user_id = ${userId}::uuid
  `;

  return { reminders, preferences: preferences[0] ?? null };
}
