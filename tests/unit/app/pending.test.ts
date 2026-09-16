import { describe, expect, it } from 'vitest';
import type { VerseView } from '@/app/_client/api';
import { newEntry, type OutboxEntry, type OutboxOp } from '@/app/_client/outbox';
import { outboxStatus, withPending } from '@/app/_client/pending';

/**
 * What the timeline shows while writes are still queued.
 *
 * The cases here are the ones that decide whether someone trusts the app with
 * a memory: a verse written with no signal has to be on screen, a delete has to
 * look like it happened, and a write that failed has to stop looking like one
 * that is merely slow.
 */

const stored = (over: Partial<VerseView> = {}): VerseView => ({
  id: 'v-stored',
  eventStart: '2026-09-10T09:00:00.000Z',
  eventEnd: null,
  deepTimeYears: null,
  location: null,
  rating: null,
  xp: 'already saved',
  properties: {},
  visibility: 'private',
  explicitVisibility: null,
  tags: [{ id: 't1', name: 'metro', label: '.metro' }],
  mediaIds: [],
  media: [],
  createdAt: '2026-09-10T09:00:00.000Z',
  updatedAt: '2026-09-10T09:00:00.000Z',
  version: 0,
  ...over,
});

const queue = (op: OutboxOp, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  ...newEntry(op, Date.parse('2026-09-15T12:00:00.000Z')),
  ...over,
});

const creating = (verseId: string, body: Record<string, unknown> = {}): OutboxOp => ({
  kind: 'create-verse',
  verseId,
  body: { tagIds: ['t1'], xp: 'written underground', ...body },
  tags: [{ id: 't1', name: 'metro', label: '.metro' }],
});

describe('withPending', () => {
  it('leaves server rows alone when nothing is queued', () => {
    const rows = withPending([stored()], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending).toBeNull();
  });

  /** The case the phase exists for: a verse composed with no signal. */
  it('shows a verse the server has never seen', () => {
    const rows = withPending([], [queue(creating('v-new'))]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'v-new', xp: 'written underground' });
    expect(rows[0]?.pending).toMatchObject({ kind: 'new', blocked: false });
  });

  /**
   * Visibility is resolved on the server, most-restrictive-wins across a
   * verse's tags (§2). Guessing it here would be a second copy of the one rule
   * this app cannot afford to get wrong, so a queued verse reads `private`
   * whatever its tags say — under-promising rather than over-promising.
   */
  it('calls a queued verse private rather than guessing at its tags', () => {
    const rows = withPending([], [queue(creating('v-new'))]);
    expect(rows[0]?.visibility).toBe('private');
    expect(rows[0]?.explicitVisibility).toBeNull();
  });

  it('puts a queued edit on top of the stored row', () => {
    const rows = withPending(
      [stored()],
      [
        queue({
          kind: 'update-verse',
          verseId: 'v-stored',
          body: { expectedVersion: 0, xp: 'corrected' },
        }),
      ],
    );

    expect(rows[0]?.xp).toBe('corrected');
    expect(rows[0]?.pending).toMatchObject({ kind: 'edited' });
  });

  /**
   * `undefined` means "leave this field" on the wire, so it has to mean that
   * here too. A spread would overwrite every unsent field with undefined and
   * blank the row on screen for a change that touched one word.
   */
  it('leaves fields an edit did not mention', () => {
    const rows = withPending(
      [stored({ location: 'Barcelona', rating: 7 })],
      [
        queue({
          kind: 'update-verse',
          verseId: 'v-stored',
          body: { expectedVersion: 0, xp: 'corrected' },
        }),
      ],
    );

    expect(rows[0]).toMatchObject({ location: 'Barcelona', rating: 7 });
  });

  it('applies an explicit null as a clear', () => {
    const rows = withPending(
      [stored({ location: 'Barcelona' })],
      [
        queue({
          kind: 'update-verse',
          verseId: 'v-stored',
          body: { expectedVersion: 0, location: null },
        }),
      ],
    );

    expect(rows[0]?.location).toBeNull();
  });

  /** A verse edited before it has ever been stored is still new, not edited. */
  it('keeps a queued-then-edited verse marked as new', () => {
    const rows = withPending(
      [],
      [
        queue(creating('v-new')),
        queue({
          kind: 'update-verse',
          verseId: 'v-new',
          body: { expectedVersion: 0, xp: 'second thoughts' },
        }),
      ],
    );

    expect(rows[0]?.xp).toBe('second thoughts');
    expect(rows[0]?.pending?.kind).toBe('new');
  });

  it('takes a deleted verse off the timeline while the delete is queued', () => {
    const rows = withPending(
      [stored()],
      [queue({ kind: 'delete-verse', verseId: 'v-stored', expectedVersion: 0 })],
    );

    expect(rows).toHaveLength(0);
  });

  /**
   * The honest half of the same rule. A delete that will never land must not
   * leave the reader believing the verse is gone — that is a lie about their
   * own record, and the most expensive kind of silent failure here.
   */
  it('brings a verse back, marked, when its delete is blocked', () => {
    const rows = withPending(
      [stored()],
      [
        queue(
          { kind: 'delete-verse', verseId: 'v-stored', expectedVersion: 0 },
          { state: 'blocked', lastError: 'That verse changed somewhere else.' },
        ),
      ],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending).toMatchObject({
      kind: 'deleting',
      blocked: true,
      reason: 'That verse changed somewhere else.',
    });
  });

  it('ignores a queued tag: tags are not rows on the timeline', () => {
    const rows = withPending(
      [stored()],
      [queue({ kind: 'create-tag', tagId: 't2', name: 'lisbon' })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending).toBeNull();
  });

  /**
   * A queued verse sorts by the same key the server orders by, so it does not
   * jump to a different place in the column the moment it syncs — which would
   * read as the app having moved something the person wrote.
   */
  it('sorts a queued verse into position rather than onto the end', () => {
    const rows = withPending(
      [
        stored({ id: 'v-future', eventStart: '2026-12-01T09:00:00.000Z' }),
        stored({ id: 'v-old', eventStart: '2020-01-01T09:00:00.000Z' }),
      ],
      [queue(creating('v-new', { eventStart: '2026-09-15T12:00:00.000Z' }))],
    );

    expect(rows.map((row) => row.id)).toEqual(['v-future', 'v-new', 'v-old']);
  });

  it('places a verse written for the future above one written for today', () => {
    const rows = withPending(
      [],
      [
        queue(creating('v-today', { eventStart: '2026-09-15T12:00:00.000Z' })),
        queue(creating('v-flight', { eventStart: '2027-06-02T08:30:00.000Z' })),
      ],
    );

    expect(rows.map((row) => row.id)).toEqual(['v-flight', 'v-today']);
  });

  /**
   * An edit to a verse on a page the timeline has not loaded. The queue still
   * holds it and will still send it; there is simply nothing on screen to mark.
   */
  it('does not invent a row for an edit to a verse it cannot see', () => {
    const rows = withPending(
      [],
      [
        queue({
          kind: 'update-verse',
          verseId: 'v-elsewhere',
          body: { expectedVersion: 3, xp: 'changed' },
        }),
      ],
    );

    expect(rows).toHaveLength(0);
  });
});

describe('outboxStatus', () => {
  it('counts what is waiting against what has given up', () => {
    expect(
      outboxStatus([
        queue(creating('a')),
        queue(creating('b')),
        queue(creating('c'), { state: 'blocked' }),
      ]),
    ).toEqual({ queued: 2, blocked: 1 });
  });
});
