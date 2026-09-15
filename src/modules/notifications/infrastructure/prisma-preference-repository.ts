import { getDatabase } from '@/shared/infra/database';
import type { NotificationPreference, PreferenceRepository } from '../domain/ports';

interface Row {
  user_id: string;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  time_zone: string | null;
  version: number;
}

/**
 * Quiet hours are all-or-nothing in the database (see the migration's CHECK),
 * so reading them back is a single test rather than three: a row either has the
 * whole window or none of it, and there is no half-configured case to decide
 * what to do about.
 */
const toPreference = (row: Row): NotificationPreference => ({
  userId: row.user_id,
  quietHours:
    row.quiet_start_minute !== null &&
    row.quiet_end_minute !== null &&
    row.time_zone !== null
      ? {
          startMinute: row.quiet_start_minute,
          endMinute: row.quiet_end_minute,
          timeZone: row.time_zone,
        }
      : null,
  version: row.version,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('notifications requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaPreferenceRepository implements PreferenceRepository {
  async find(userId: string): Promise<NotificationPreference | null> {
    const rows = await requireDatabase().$queryRaw<Row[]>`
      SELECT user_id, quiet_start_minute, quiet_end_minute, time_zone, version
        FROM notifications.notification_preference
       WHERE user_id = ${userId}::uuid
    `;
    const row = rows[0];
    return row ? toPreference(row) : null;
  }

  /**
   * Upsert rather than insert-or-update.
   *
   * The row is created on demand the first time someone opens their settings,
   * and "has this person ever had preferences" is not a question any caller
   * needs to ask — absent and default mean the same thing to the dispatcher.
   */
  async upsert(preference: NotificationPreference): Promise<void> {
    const quiet = preference.quietHours;
    await requireDatabase().$executeRaw`
      INSERT INTO notifications.notification_preference
        (user_id, quiet_start_minute, quiet_end_minute, time_zone,
         created_at, updated_at, version)
      VALUES
        (${preference.userId}::uuid, ${quiet?.startMinute ?? null},
         ${quiet?.endMinute ?? null}, ${quiet?.timeZone ?? null},
         NOW(), NOW(), 0)
      ON CONFLICT (user_id) DO UPDATE
        SET quiet_start_minute = EXCLUDED.quiet_start_minute,
            quiet_end_minute = EXCLUDED.quiet_end_minute,
            time_zone = EXCLUDED.time_zone,
            updated_at = NOW(),
            version = notifications.notification_preference.version + 1
    `;
  }

  async deleteForUser(userId: string): Promise<number> {
    return requireDatabase().$executeRaw`
      DELETE FROM notifications.notification_preference WHERE user_id = ${userId}::uuid
    `;
  }
}
