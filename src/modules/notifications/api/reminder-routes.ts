import { z } from 'zod';
import { DomainError, systemClock, uuidv7 } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { idempotently } from '@/shared/infra/idempotent-write';
import { authenticate } from '@/modules/identity';
import { PrismaNotificationRepository } from '../infrastructure/prisma-notification-repository';
import { PrismaPreferenceRepository } from '../infrastructure/prisma-preference-repository';
import { scheduleReminder } from '../application/schedule';
import { parseQuietHours } from '../domain/quiet-hours';
import type { ScheduledNotification } from '../domain/ports';

const MAX_LIST = 100;

const body = (n: ScheduledNotification) => ({
  id: n.id,
  verseId: n.verseId,
  fireAt: n.fireAt.toISOString(),
  title: n.title,
  body: n.body,
  recurrence: n.recurrence,
  status: n.status,
  occurrences: n.occurrences,
  attempts: n.attempts,
  lastError: n.lastError,
  createdAt: n.createdAt.toISOString(),
  updatedAt: n.updatedAt.toISOString(),
  version: n.version,
});

const CreateBody = z.object({
  /** Client-generated UUIDv7, like every other write here (§2). */
  id: z.uuid().optional(),
  verseId: z.uuid().nullish(),
  fireAt: z.string(),
  title: z.string(),
  body: z.string().nullish(),
  recurrence: z.string().nullish(),
});

export async function handleCreateReminder(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      new DomainError('bad_request', 'That is not a valid reminder.'),
      422,
      rateLimitHeaders(decision),
    );
  }

  // A phone on a flaky network retries underneath the app; without this a
  // retry sets the same reminder twice (§6).
  return idempotently(
    request,
    { userId: auth.userId, path: '/v1/reminders', body: parsed.data },
    async () => {
      const reminder = scheduleReminder(
        {
          id: parsed.data.id ?? uuidv7(),
          userId: auth.userId,
          verseId: parsed.data.verseId ?? null,
          fireAt: new Date(parsed.data.fireAt),
          title: parsed.data.title,
          body: parsed.data.body ?? null,
          recurrence: parsed.data.recurrence ?? null,
        },
        systemClock,
      );

      if (!reminder.ok) {
        return {
          status: 422,
          body: { error: reminder.error.toJSON() },
          headers: rateLimitHeaders(decision),
        };
      }

      await new PrismaNotificationRepository().create(reminder.value);

      return {
        status: 201,
        body: body(reminder.value),
        headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
      };
    },
  );
}

export async function handleListReminders(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const reminders = await new PrismaNotificationRepository().listForUser(
    auth.userId,
    MAX_LIST,
  );

  return Response.json(
    { reminders: reminders.map(body) },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

const PreferenceBody = z.object({
  /** All three together, or all three null — the migration's CHECK agrees. */
  quietStartMinute: z.number().int().nullish(),
  quietEndMinute: z.number().int().nullish(),
  timeZone: z.string().nullish(),
});

export async function handleUpdatePreferences(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const parsed = PreferenceBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      new DomainError('bad_request', 'That is not a valid preference.'),
      422,
      rateLimitHeaders(decision),
    );
  }

  const { quietStartMinute, quietEndMinute, timeZone } = parsed.data;
  const clearing = quietStartMinute == null && quietEndMinute == null && timeZone == null;

  if (!clearing) {
    if (quietStartMinute == null || quietEndMinute == null || timeZone == null) {
      return jsonError(
        new DomainError(
          'notifications.invalid_quiet_hours',
          'Quiet hours need a start, an end and a time zone, or none of the three.',
        ),
        422,
        rateLimitHeaders(decision),
      );
    }

    const quiet = parseQuietHours({
      startMinute: quietStartMinute,
      endMinute: quietEndMinute,
      timeZone,
    });
    if (!quiet.ok) return jsonError(quiet.error, 422, rateLimitHeaders(decision));

    await new PrismaPreferenceRepository().upsert({
      userId: auth.userId,
      quietHours: quiet.value,
      version: 0,
    });

    return Response.json(
      { quietHours: quiet.value },
      {
        status: 200,
        headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
      },
    );
  }

  await new PrismaPreferenceRepository().upsert({
    userId: auth.userId,
    quietHours: null,
    version: 0,
  });

  return Response.json(
    { quietHours: null },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

export async function handleGetPreferences(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const preference = await new PrismaPreferenceRepository().find(auth.userId);

  return Response.json(
    { quietHours: preference?.quietHours ?? null },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
