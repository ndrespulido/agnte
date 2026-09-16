'use client';

import type { VerseView } from './api';
import { timelinePosition } from './format';
import type { OutboxEntry } from './outbox';

/**
 * What the timeline shows while the outbox still holds a write (§8.1).
 *
 * > The UI must show pending state honestly — a Verse that hasn't synced should
 * > look different from one that has. Silent queuing is how people lose trust
 * > in an app that holds their memories.
 *
 * This file is the "honestly" part, and it is pure: server rows in, rows plus
 * marks out. Keeping it away from React and from the network is what lets the
 * awkward cases — an edit queued on top of a create, a delete that failed and
 * has to reappear — be written down as tests rather than found by scrolling.
 */

export interface PendingMark {
  /**
   * `new` has never reached the server. `edited` is a stored verse with a
   * queued change on top. `deleting` is a delete that did *not* go through —
   * a queued one simply removes the row, because that is what was asked for.
   */
  readonly kind: 'new' | 'edited' | 'deleting';
  /** True once the queue has given up: this needs a person, not more waiting. */
  readonly blocked: boolean;
  readonly reason: string | null;
  /** So the row can offer to retry or discard the write it is waiting on. */
  readonly entryId: string;
}

export type TimelineVerse = VerseView & { readonly pending: PendingMark | null };

const markOf = (kind: PendingMark['kind'], entry: OutboxEntry): PendingMark => ({
  kind,
  blocked: entry.state === 'blocked',
  reason: entry.lastError,
  entryId: entry.id,
});

/**
 * A verse the server has never seen, drawn from what was queued.
 *
 * Two fields are deliberately not guessed:
 *
 * `visibility` shows `private` rather than whatever the tags would resolve to.
 * Resolution is most-restrictive-wins across a verse's tags and lives in one
 * place on the server (§2); reimplementing it here to draw a badge would be a
 * second copy of the one rule this app cannot afford to get wrong, and the
 * direction of the error matters — guessing `private` under-promises, guessing
 * anything else would tell someone their medical note is shared when it is not.
 *
 * `media` is empty even when `mediaIds` is not. The URLs are signed by the
 * server and there are none yet; showing a broken tile would be worse than
 * showing the photo a moment later.
 */
function asVerse(entry: OutboxEntry): VerseView | null {
  if (entry.op.kind !== 'create-verse') return null;
  const { body, tags, verseId } = entry.op;
  const at = new Date(entry.queuedAt).toISOString();

  return {
    id: verseId,
    eventStart: body.eventStart ?? null,
    eventEnd: body.eventEnd ?? null,
    deepTimeYears: null,
    location: body.location ?? null,
    rating: body.rating ?? null,
    xp: body.xp ?? null,
    properties: body.properties ?? {},
    visibility: 'private',
    explicitVisibility: null,
    tags,
    mediaIds: body.mediaIds ?? [],
    media: [],
    createdAt: at,
    updatedAt: at,
    version: 0,
  };
}

/**
 * Applies the queue on top of what the server returned.
 *
 * Entries are walked in order, so a create followed by two edits ends at the
 * second edit — the same sequence the server will replay, which is what stops
 * the screen and the database from disagreeing about the result.
 */
export function withPending(
  server: readonly VerseView[],
  entries: readonly OutboxEntry[],
): TimelineVerse[] {
  const rows = new Map<string, TimelineVerse>();
  for (const verse of server) rows.set(verse.id, { ...verse, pending: null });

  for (const entry of entries) {
    const op = entry.op;
    // Tags are not rows on the timeline; a queued one shows up in the tag list
    // instead, and a verse queued behind it already carries its label.
    if (op.kind === 'create-tag') continue;

    if (op.kind === 'create-verse') {
      const drawn = asVerse(entry);
      if (drawn) rows.set(op.verseId, { ...drawn, pending: markOf('new', entry) });
      continue;
    }

    if (op.kind === 'delete-verse') {
      // A queued delete has been honoured as far as the reader is concerned.
      // A blocked one has not, and pretending otherwise would be the silent
      // failure this whole file exists to avoid — so the row comes back, marked.
      if (entry.state === 'blocked') {
        const current = rows.get(op.verseId);
        if (current)
          rows.set(op.verseId, { ...current, pending: markOf('deleting', entry) });
      } else {
        rows.delete(op.verseId);
      }
      continue;
    }

    const current = rows.get(op.verseId);
    // An edit to a verse this page did not load: nothing to draw, and the
    // queue will still send it. Dropping it here is a display decision only.
    if (!current) continue;

    const { body } = op;
    rows.set(op.verseId, {
      ...current,
      // `undefined` means "leave it" on the wire, so it has to mean that here
      // too — `??` rather than a spread, which would overwrite with undefined.
      xp: body.xp === undefined ? current.xp : body.xp,
      location: body.location === undefined ? current.location : body.location,
      rating: body.rating === undefined ? current.rating : body.rating,
      eventStart: body.eventStart === undefined ? current.eventStart : body.eventStart,
      eventEnd: body.eventEnd === undefined ? current.eventEnd : body.eventEnd,
      properties: body.properties ?? current.properties,
      // A verse that is still new stays new: it has never been stored, so
      // calling it edited would imply there is a stored version to compare to.
      pending: markOf(current.pending?.kind === 'new' ? 'new' : 'edited', entry),
    });
  }

  return [...rows.values()].sort(compare);
}

/**
 * Newest first, matching the order the API pages arrive in.
 *
 * The id breaks a tie for the same reason the server's keyset cursor includes
 * it: two verses can sit at exactly the same position, and an unstable order
 * there makes rows jump as pages load.
 */
function compare(a: TimelineVerse, b: TimelineVerse): number {
  const byPosition = timelinePosition(b) - timelinePosition(a);
  if (byPosition !== 0) return byPosition;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Whether anything at all is waiting, for the shell's one-line status. */
export function outboxStatus(entries: readonly OutboxEntry[]): {
  queued: number;
  blocked: number;
} {
  let queued = 0;
  let blocked = 0;
  for (const entry of entries) {
    if (entry.state === 'blocked') blocked += 1;
    else queued += 1;
  }
  return { queued, blocked };
}
