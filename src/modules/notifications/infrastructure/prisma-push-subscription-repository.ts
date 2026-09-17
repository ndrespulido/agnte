import { getDatabase } from '@/shared/infra/database';
import type { PushSubscriptionRecord, PushSubscriptionRepository } from '../domain/ports';

interface Row {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
}

const toSubscription = (row: Row): PushSubscriptionRecord => ({
  id: row.id,
  userId: row.user_id,
  endpoint: row.endpoint,
  p256dh: row.p256dh,
  auth: row.auth,
  userAgent: row.user_agent,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('notifications requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaPushSubscriptionRepository implements PushSubscriptionRepository {
  async listForUser(userId: string): Promise<PushSubscriptionRecord[]> {
    const rows = await requireDatabase().$queryRaw<Row[]>`
      SELECT id, user_id, endpoint, p256dh, auth, user_agent
        FROM notifications.push_subscription
       WHERE user_id = ${userId}::uuid
       ORDER BY created_at ASC
    `;
    return rows.map(toSubscription);
  }

  /**
   * Upsert on the endpoint, not the id.
   *
   * The endpoint is what identifies a subscription — the browser hands back the
   * same one with fresh keys whenever it re-subscribes — so the conflict target
   * is the endpoint and the id the caller minted is only used for a genuinely
   * new row. `user_id` is updated too: the same browser signed into a different
   * account gets the same endpoint back from the push service, and leaving the
   * old owner on it would deliver one person's reminders to another's device.
   */
  async upsert(subscription: PushSubscriptionRecord): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO notifications.push_subscription
        (id, user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
      VALUES (
        ${subscription.id}::uuid,
        ${subscription.userId}::uuid,
        ${subscription.endpoint},
        ${subscription.p256dh},
        ${subscription.auth},
        ${subscription.userAgent},
        NOW(),
        NOW()
      )
      ON CONFLICT (endpoint) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            user_agent = EXCLUDED.user_agent,
            updated_at = NOW()
    `;
  }

  async remove(userId: string, endpoint: string): Promise<boolean> {
    const deleted = await requireDatabase().$executeRaw`
      DELETE FROM notifications.push_subscription
       WHERE user_id = ${userId}::uuid AND endpoint = ${endpoint}
    `;
    return deleted > 0;
  }

  async removeByEndpoint(endpoint: string): Promise<boolean> {
    const deleted = await requireDatabase().$executeRaw`
      DELETE FROM notifications.push_subscription WHERE endpoint = ${endpoint}
    `;
    return deleted > 0;
  }

  async deleteForUser(userId: string): Promise<number> {
    return requireDatabase().$executeRaw`
      DELETE FROM notifications.push_subscription WHERE user_id = ${userId}::uuid
    `;
  }
}
