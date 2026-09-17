/**
 * A reminder is a Verse (§8.4).
 *
 * The alternative was a reminder that merely *looks* like one — a second kind
 * of row the timeline would have to fetch separately, interleave by date, and
 * then teach about tags, media and visibility one feature at a time. Every one
 * of those already works for a Verse.
 *
 * So scheduling a reminder writes two things: a Verse carrying what it says,
 * when it is for, and whatever tags it was given, and a `ScheduledNotification`
 * carrying only the schedule and pointing at that Verse. The timeline shows it
 * because it is a verse with a future `eventStart`; it can be tagged because it
 * is a verse; tapping the notification opens it because the dispatcher already
 * puts `verseId` in the push payload.
 *
 * What is deliberately *not* shared is the text. The notification keeps its own
 * `title`, a copy taken when the reminder was made, rather than the dispatcher
 * reading the verse at fire time — that would be a cross-schema read, which
 * §1.1 forbids outright. The cost is real and worth naming: editing the verse's
 * note later does not change what the notification will say.
 */

/** The tag every reminder verse carries. */
export const REMINDER_TAG = 'reminder';

/** A tag as the client knows it — the two fields this file needs, nothing more. */
export interface KnownTag {
  readonly id: string;
  readonly name: string;
}

/**
 * Normalised the way the domain does it: leading dots stripped, lowercased.
 *
 * Duplicated from `parseTagName` rather than imported, because that lives in
 * the verse module's domain and this is the app layer — and a shared *domain*
 * helper across that line is the coupling §1.1 exists to prevent. Three lines
 * is the right price for that.
 */
export const normaliseTagName = (raw: string): string =>
  raw.trim().replace(/^\.+/, '').toLowerCase();

export interface TagPlan {
  /** Tags that already exist and can be used as they are. */
  readonly ids: readonly string[];
  /** Names with no tag behind them yet, in the order they were asked for. */
  readonly create: readonly string[];
}

/**
 * Sorts wanted tag names into "already have it" and "needs making".
 *
 * Separated from the making so the decision can be tested without a network or
 * an outbox behind it. The caller creates what comes back in `create` and
 * appends those ids.
 *
 * Takes names, not a field: a comma-separated box is split by `splitTagNames`
 * in format.ts, which is also what the verse sheet uses. This still normalises
 * and de-duplicates, because `.reminder` is prepended after that split and
 * asking for it twice must not try to create it twice — the server refuses a
 * duplicate name, and a refused write blocks the queue behind it.
 */
export function planTags(
  wanted: readonly string[],
  known: readonly KnownTag[],
  selected: readonly string[] = [],
): TagPlan {
  const ids = [...selected];
  const create: string[] = [];
  const seen = new Set<string>();

  for (const raw of wanted) {
    const name = normaliseTagName(raw);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);

    const existing = known.find((tag) => tag.name === name);
    if (!existing) {
      create.push(name);
      continue;
    }

    // Already selected by chip is not a second membership.
    if (!ids.includes(existing.id)) ids.push(existing.id);
  }

  return { ids, create };
}

/**
 * The verse fields a reminder stands for.
 *
 * Mutable `tagIds` rather than `readonly`, to match `NewVerse` in api.ts: the
 * outbox stores this and a readonly array cannot be assigned to a mutable one.
 */
export interface ReminderVerseFields {
  tagIds: string[];
  xp: string;
  eventStart: string;
}

/**
 * What the Verse behind a reminder looks like.
 *
 * `eventStart` is the moment it is for, not the moment it was written, which
 * is what puts it in the future half of the timeline rather than at today.
 * The text goes in `xp`: a Verse has no title field, by design — `xp` is the
 * free-text note and this is free text.
 */
export function reminderVerseFields(input: {
  title: string;
  fireAt: string;
  tagIds: readonly string[];
}): ReminderVerseFields {
  return {
    tagIds: [...input.tagIds],
    xp: input.title.trim(),
    eventStart: input.fireAt,
  };
}
