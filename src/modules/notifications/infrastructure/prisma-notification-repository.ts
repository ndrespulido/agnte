import { getDatabase } from '@/shared/infra/database';
import type {
  DispatchOutcome,
  NotificationRepository,
  NotificationStatus,
  ScheduledNotification,
} from '../domain/ports';

interface Row {
  id: string;
  user_id: string;
  verse_id: string | null;
  fire_at: Date;
  start_at: Date;
  occurrences: number;
  recurrence: string | null;
  status: string;
  title: string;
  body: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

/**
 * The cast is safe because the migration constrains `status` to a closed set —
 * the same reasoning media's repository documents for its own status column.
 */
const toNotification = (row: Row): ScheduledNotification => ({
  id: row.id,
  userId: row.user_id,
  verseId: row.verse_id,
  fireAt: row.fire_at,
  startAt: row.start_at,
  occurrences: row.occurrences,
  recurrence: row.recurrence,
  status: row.status as NotificationStatus,
  title: row.title,
  body: row.body,
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

const COLUMNS = `id, user_id, verse_id, fire_at, start_at, occurrences,
                 recurrence, status, title, body, attempts, last_error,
                 created_at, updated_at, version`;

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('notifications requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaNotificationRepository implements NotificationRepository {
  async create(n: ScheduledNotification): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO notifications.scheduled_notification
        (id, user_id, verse_id, fire_at, start_at, occurrences, recurrence,
         status, title, body, attempts, last_error, created_at, updated_at, version)
      VALUES
        (${n.id}::uuid, ${n.userId}::uuid, ${n.verseId}::uuid, ${n.fireAt},
         ${n.startAt}, ${n.occurrences}, ${n.recurrence}, ${n.status}, ${n.title},
         ${n.body}, ${n.attempts}, ${n.lastError}, ${n.createdAt}, ${n.updatedAt},
         ${n.version})
    `;
  }

  async findById(id: string): Promise<ScheduledNotification | null> {
    const rows = await requireDatabase().$queryRawUnsafe<Row[]>(
      `SELECT ${COLUMNS} FROM notifications.scheduled_notification WHERE id = $1::uuid`,
      id,
    );
    const row = rows[0];
    return row ? toNotification(row) : null;
  }

  async listForUser(userId: string, limit: number): Promise<ScheduledNotification[]> {
    const rows = await requireDatabase().$queryRawUnsafe<Row[]>(
      `SELECT ${COLUMNS} FROM notifications.scheduled_notification
       WHERE user_id = $1::uuid
       ORDER BY fire_at ASC
       LIMIT $2`,
      userId,
      limit,
    );
    return rows.map(toNotification);
  }

  /**
   * Claims due reminders for this dispatcher and nobody else.
   *
   * `FOR UPDATE SKIP LOCKED` is what §8.4 asks for by name, and the `SKIP
   * LOCKED` half is the important one: a plain `FOR UPDATE` would make a second
   * instance *block* behind the first until it committed, so two ticks landing
   * together would serialise into one long request — and Cloud Run kills a
   * container when its response returns, so the blocked one risks being killed
   * mid-wait. Skipping instead lets the second instance take the next fifty.
   *
   * The lock is held only for the life of this transaction. That is deliberate
   * and it is why the dispatcher settles each row as it goes rather than
   * sending everything and writing at the end: the rows are unavailable to any
   * other instance for exactly as long as this statement's transaction runs.
   */
  async claimDue(now: Date, limit: number): Promise<ScheduledNotification[]> {
    const rows = await requireDatabase().$queryRawUnsafe<Row[]>(
      `SELECT ${COLUMNS}
         FROM notifications.scheduled_notification
        WHERE status = 'pending' AND fire_at <= $1
        ORDER BY fire_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      now,
      limit,
    );
    return rows.map(toNotification);
  }

  /**
   * Writes back what the dispatcher decided.
   *
   * `fire_at` is only moved when there is a next occurrence; a retired reminder
   * keeps the time it last fired, which is more useful to read than a null and
   * costs nothing — `status` is what takes it out of the dispatcher's query.
   */
  async settle(outcome: DispatchOutcome): Promise<void> {
    await requireDatabase().$executeRaw`
      UPDATE notifications.scheduled_notification
         SET status = ${outcome.status},
             occurrences = ${outcome.occurrences},
             attempts = ${outcome.attempts},
             last_error = ${outcome.lastError},
             fire_at = COALESCE(${outcome.nextFireAt}, fire_at),
             updated_at = NOW(),
             version = version + 1
       WHERE id = ${outcome.id}::uuid
    `;
  }

  async deleteForUser(userId: string): Promise<number> {
    return requireDatabase().$executeRaw`
      DELETE FROM notifications.scheduled_notification WHERE user_id = ${userId}::uuid
    `;
  }
}

/** Null when there is no database at all, for the health check's benefit. */
export const notificationsAvailable = (): boolean => getDatabase() !== null;
