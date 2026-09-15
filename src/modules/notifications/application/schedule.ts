import { DomainError, type Clock, type Result, err, ok } from '@/shared/kernel';
import { parseRecurrence, nextOccurrence } from '../domain/recurrence';
import type { NotificationRepository, ScheduledNotification } from '../domain/ports';

export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 2000;

/** How far ahead a reminder may be set. */
export const MAX_LEAD_YEARS = 50;

export interface ScheduleInput {
  readonly id: string;
  readonly userId: string;
  readonly verseId?: string | null;
  readonly fireAt: Date;
  readonly title: string;
  readonly body?: string | null;
  readonly recurrence?: string | null;
}

const invalid = (detail: string) =>
  new DomainError('notifications.invalid_reminder', detail);

/**
 * Creates a reminder.
 *
 * `fireAt` doubles as the recurrence anchor: "every 3 months" means every three
 * months *from the first one*, so the two cannot be set independently without
 * inviting a rule that counts from somewhere nobody chose.
 */
export function scheduleReminder(
  input: ScheduleInput,
  clock: Clock,
): Result<ScheduledNotification, DomainError> {
  const title = input.title.trim();
  if (title === '') return err(invalid('A reminder needs a title.'));
  if (title.length > MAX_TITLE_LENGTH) {
    return err(invalid(`A title may be at most ${MAX_TITLE_LENGTH} characters.`));
  }

  const body = input.body?.trim() ?? null;
  if (body !== null && body.length > MAX_BODY_LENGTH) {
    return err(invalid(`A body may be at most ${MAX_BODY_LENGTH} characters.`));
  }

  if (Number.isNaN(input.fireAt.getTime())) {
    return err(invalid('That is not a valid time.'));
  }

  const now = clock.now();

  /*
   * A reminder in the past is refused rather than fired immediately.
   *
   * Firing it would be defensible, but it makes a typo indistinguishable from
   * an intention — and the timeline runs into the past freely (CLAUDE.md), so
   * picking a past date is an easy slip to make on this app in particular.
   */
  if (input.fireAt <= now) {
    return err(invalid('That time has already passed.'));
  }

  const horizon = new Date(now);
  horizon.setUTCFullYear(horizon.getUTCFullYear() + MAX_LEAD_YEARS);
  if (input.fireAt > horizon) {
    return err(invalid(`A reminder can be set at most ${MAX_LEAD_YEARS} years ahead.`));
  }

  // Parsed at write time, not only at dispatch: a rule that will never fire
  // should fail while someone is looking at the form, not silently at 03:00
  // three weeks later.
  if (input.recurrence) {
    const rule = parseRecurrence(input.recurrence);
    if (!rule.ok) return err(rule.error);

    // A rule whose first step is already past its own UNTIL would be stored,
    // fire once, and retire — which is a one-off wearing a recurrence, and
    // almost certainly not what was meant.
    if (rule.value.until && rule.value.until < input.fireAt) {
      return err(invalid('That rule ends before the first reminder would fire.'));
    }
    if (nextOccurrence(rule.value, input.fireAt, input.fireAt, 1) === null) {
      return err(invalid('That rule would never repeat.'));
    }
  }

  return ok({
    id: input.id,
    userId: input.userId,
    verseId: input.verseId ?? null,
    fireAt: input.fireAt,
    startAt: input.fireAt,
    occurrences: 0,
    recurrence: input.recurrence ?? null,
    status: 'pending',
    title,
    body,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
}

export async function saveReminder(
  notification: ScheduledNotification,
  repository: NotificationRepository,
): Promise<void> {
  await repository.create(notification);
}
