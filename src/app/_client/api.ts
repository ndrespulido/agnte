'use client';

import { uuidv7 } from '@/shared/kernel/id';
import { authedFetch } from './session';
import { tagLabelOf, type TagLabel } from './outbox';
import { enqueue, outboxSnapshot } from './sync';

/** The API's verse shape, as the routes actually return it. */
export interface VerseView {
  id: string;
  eventStart: string | null;
  eventEnd: string | null;
  deepTimeYears: number | null;
  location: string | null;
  rating: number | null;
  xp: string | null;
  properties: Record<string, string>;
  visibility: 'private' | 'shared' | 'public';
  explicitVisibility: 'private' | 'shared' | 'public' | null;
  tags: { id: string; name: string; label: string }[];
  mediaIds: string[];
  media: {
    id: string;
    status: string;
    originalUrl: string | null;
    thumbUrl: string | null;
    mediumUrl: string | null;
  }[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TagView {
  id: string;
  name: string;
  label: string;
  visibility: 'private' | 'shared' | 'public';
  shortcut: string | null;
  vertical: string | null;
  suggestedProperties: string[];
  version: number;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

export interface TimelinePage {
  verses: VerseView[];
  nextCursor: string | null;
}

export function fetchTimeline(options: {
  anchor: Date;
  direction: 'past' | 'future';
  cursor?: string | null;
  tagIds?: readonly string[];
  limit?: number;
}): Promise<TimelinePage> {
  const params = new URLSearchParams({
    anchor: options.anchor.toISOString(),
    direction: options.direction,
    limit: String(options.limit ?? 20),
  });
  if (options.cursor) params.set('cursor', options.cursor);
  for (const tag of options.tagIds ?? []) params.append('tag', tag);

  return authedFetch(`/v1/timeline?${params.toString()}`).then((r) =>
    json<TimelinePage>(r),
  );
}

/**
 * Every tag, including the ones still in the outbox.
 *
 * Merged here rather than in each component so there is one answer to "what
 * tags do I have". Without it a tag created with no signal disappears from the
 * list on the next reload and reappears when it syncs, which reads as data
 * loss — and would let someone create it a second time, which the server would
 * then refuse as a duplicate name, blocking the queue behind it.
 *
 * Queued tags come last and the sort in the callers puts them back in place;
 * a server row of the same id wins, because it is the one with the real
 * shortcut and visibility on it.
 */
export async function fetchTags(): Promise<TagView[]> {
  const body = await authedFetch('/v1/tags').then((r) => json<{ tags: TagView[] }>(r));

  const byId = new Map(body.tags.map((tag) => [tag.id, tag]));
  for (const entry of outboxSnapshot()) {
    if (entry.op.kind !== 'create-tag') continue;
    if (!byId.has(entry.op.tagId)) byId.set(entry.op.tagId, tagLabelOf(entry.op));
  }

  return [...byId.values()];
}

/**
 * Creates a tag by queueing it (§8.1), answering with the tag it will become.
 *
 * The id is minted here rather than by the server, which is what makes the
 * answer immediate and what lets a verse queued a moment later already name the
 * tag. Everything else is the server's to fill in: `shortcut` in particular is
 * chosen there, against the shortcuts already taken, so the local copy says
 * null rather than guessing at a letter that may go to a different tag.
 */
export function createTag(name: string): Promise<TagView> {
  const tagId = uuidv7();
  const normalised = name.replace(/^\.+/, '').toLowerCase();

  return enqueue({ kind: 'create-tag', tagId, name }).then(() => ({
    id: tagId,
    name: normalised,
    label: `.${normalised}`,
    visibility: 'private' as const,
    shortcut: null,
    vertical: null,
    suggestedProperties: [],
    version: 0,
  }));
}

export interface NewVerse {
  tagIds: string[];
  xp?: string | null;
  location?: string | null;
  rating?: number | null;
  eventStart?: string | null;
  eventEnd?: string | null;
  visibility?: string | null;
  properties?: Record<string, string>;
  mediaIds?: string[];
}

/**
 * Writes a verse to the outbox and answers once it is stored, not once it is
 * sent (§8.1).
 *
 * `tags` is what the timeline needs to draw the row before the server has ever
 * seen it — the ids in `input` are the truth, these are the labels. It is
 * passed in rather than looked up because the sheet already has them, and a
 * lookup is exactly the network call this path exists to avoid.
 *
 * Returns the id so the caller can point at the row it just made.
 */
export async function createVerse(input: NewVerse, tags: TagLabel[]): Promise<string> {
  const verseId = uuidv7();
  await enqueue({ kind: 'create-verse', verseId, body: input, tags });
  return verseId;
}

/**
 * The shared deep-time catalogue: what the past runs into once a person's own
 * past runs out (CLAUDE.md).
 *
 * A second request rather than something the timeline folds in, because it is
 * a different module's data with a different lifetime — identical for every
 * user, cacheable for an hour, and owned by nobody. Merging it server-side
 * would mean a cross-schema read that architecture.md §1.1 forbids.
 */
export interface DeepTimeEventView {
  id: string;
  slug: string;
  timelineYears: number;
  title: string;
  detail: string | null;
  category: string;
}

export interface CataloguePage {
  events: DeepTimeEventView[];
  nextCursor: string | null;
}

export function fetchDeepTime(options: {
  before: number;
  cursor?: string | null;
  limit?: number;
}): Promise<CataloguePage> {
  const params = new URLSearchParams({
    before: String(options.before),
    limit: String(options.limit ?? 10),
  });
  if (options.cursor) params.set('cursor', options.cursor);

  return authedFetch(`/v1/deep-time?${params.toString()}`).then((r) =>
    json<CataloguePage>(r),
  );
}

export interface PlaceSuggestion {
  description: string;
  primary: string;
  secondary: string | null;
}

/**
 * Place suggestions for the location field.
 *
 * Answers an empty list rather than throwing when suggestions are switched
 * off (501) or the provider is unreachable (502). A location field is a
 * convenience on an optional field — it should degrade to plain text, not put
 * an error in front of someone mid-sentence.
 */
let placesDisabled = false;

export async function fetchPlaces(query: string): Promise<PlaceSuggestion[]> {
  // Asked once, answered for the session. Suggestions being switched off is a
  // deployment fact, not a per-request one — and without this the field logs a
  // failed request on every debounce for the whole time someone is typing.
  if (placesDisabled) return [];

  const response = await authedFetch(`/v1/places?q=${encodeURIComponent(query)}`);

  if (response.status === 501) {
    placesDisabled = true;
    return [];
  }
  if (!response.ok) return [];

  const body = (await response.json()) as { suggestions?: PlaceSuggestion[] };
  return body.suggestions ?? [];
}

export const fetchVerse = (id: string): Promise<VerseView> =>
  authedFetch(`/v1/verses/${id}`).then((r) => json<VerseView>(r));

/**
 * A patch, with the version the editor was opened on.
 *
 * Every field is optional and the server reads an omitted one as "leave it",
 * an explicit `null` as "clear it" — so a sheet that manages a field must send
 * it on every save, including when it was emptied. `expectedVersion` is what
 * turns a save on stale data into a 409 rather than a silent overwrite of
 * whatever changed underneath (architecture.md §2).
 */
export interface VerseEdit {
  expectedVersion: number;
  tagIds?: string[];
  xp?: string | null;
  location?: string | null;
  rating?: number | null;
  eventStart?: string | null;
  eventEnd?: string | null;
  visibility?: string | null;
  properties?: Record<string, string>;
  mediaIds?: string[];
}

/**
 * Queues an edit.
 *
 * ---------------------------------------------------------------------------
 * A version conflict no longer lands in the sheet, and that is a real change.
 *
 * This used to send the PATCH and throw on a 409 while the editor was still
 * open, so the message arrived exactly where the change had been typed. Queuing
 * every write means the answer comes back after the sheet has closed, so a
 * conflict surfaces on the row instead — marked, with what the server said and
 * the choice to retry or discard.
 *
 * The trade is deliberate: the alternative is an editor that blocks on the
 * network, which is the thing a person composing a verse underground cannot
 * afford. See `sync.ts` for why a conflict is never retried.
 * ---------------------------------------------------------------------------
 */
export async function updateVerse(id: string, input: VerseEdit): Promise<void> {
  await enqueue({ kind: 'update-verse', verseId: id, body: input });
}

export async function deleteVerse(id: string, expectedVersion: number): Promise<void> {
  await enqueue({ kind: 'delete-verse', verseId: id, expectedVersion });
}

/**
 * Full-text search (§8.2).
 *
 * Ranked, not chronological, which is why it has its own surface rather than
 * being another way to filter the timeline: the timeline's whole shape is a
 * date column you scroll in two directions, and a relevance order has no
 * place in it.
 *
 * Text only for now. The route also takes `from`, `to`, `ratingAtLeast`,
 * `hasMedia` and tags — none of them surfaced yet, deliberately, so the first
 * version is small enough to judge on screen.
 */
export const searchVerses = (
  query: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<TimelinePage> => {
  const params = new URLSearchParams({ q: query });
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);

  return authedFetch(`/v1/search?${params.toString()}`).then((r) =>
    json<TimelinePage>(r),
  );
};

export interface MediaView {
  id: string;
  status: string;
  originalUrl: string | null;
  thumbUrl: string | null;
  mediumUrl: string | null;
  version: number;
}

interface UploadTargetView {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

/**
 * The three-step upload (architecture.md §8.3): ask where to put it, put it
 * there, say it landed.
 *
 * Bytes never pass through the app server — the middle step goes straight to
 * object storage with a URL the server signed. That is what keeps a Cloud Run
 * instance from having to hold a photo in memory, and what makes the upload
 * cost nothing but the storage it ends in.
 */
export async function uploadImage(image: {
  blob: Blob;
  contentType: string;
}): Promise<string> {
  const requested = await authedFetch('/v1/media', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Same reason createVerse carries one: a retry underneath the app must
      // not mint a second pending Media row for the same picture.
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      contentType: image.contentType,
      declaredSizeBytes: image.blob.size,
    }),
  }).then((r) => json<{ media: MediaView; upload: UploadTargetView }>(r));

  /**
   * A plain `fetch`, deliberately not `authedFetch`.
   *
   * This request goes to object storage, not to this app — in production, to
   * a Cloudflare R2 host. Attaching the app's bearer token would hand a
   * third-party origin a credential it has no business seeing, and the signed
   * URL already carries its own authorisation. The only headers sent are the
   * ones the server said to send.
   */
  const put = await fetch(requested.upload.url, {
    method: requested.upload.method,
    headers: requested.upload.headers,
    body: image.blob,
  });
  if (!put.ok) throw new Error(`Could not upload the image (${put.status}).`);

  const confirmed = await authedFetch(`/v1/media/${requested.media.id}/confirm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ expectedVersion: requested.media.version }),
  }).then((r) => json<MediaView>(r));

  return confirmed.id;
}

/**
 * A tag's dashboard — the "query it like a database" half of the pitch.
 *
 * Every number here was computed over rows the server had already filtered to
 * what this viewer may see, which is why the aggregation happens in the app and
 * not in SQL (see the module's domain/summary.ts).
 */
export interface PropertySummaryView {
  key: string;
  verseCount: number;
  /** How many of those values were numbers. Below `verseCount` means `sum` is partial. */
  numericCount: number;
  sum: number | null;
}

export interface CoTagView {
  id: string;
  name: string;
  label: string;
  count: number;
}

export interface DashboardView {
  tag: {
    id: string;
    name: string;
    label: string;
    visibility: 'private' | 'shared' | 'public';
    vertical: string | null;
    suggestedProperties: string[];
  };
  summary: {
    verseCount: number;
    firstEvent: string | null;
    lastEvent: string | null;
    undatedCount: number;
    deepTimeCount: number;
    ratedCount: number;
    averageRating: number | null;
    ratingHistogram: number[];
    withMediaCount: number;
    mediaCount: number;
    coTags: CoTagView[];
    properties: PropertySummaryView[];
  };
  /** The tag holds more verses than one dashboard reads; the numbers are partial. */
  truncated: boolean;
}

export const fetchTagDashboard = (tagId: string): Promise<DashboardView> =>
  authedFetch(`/v1/tags/${tagId}/dashboard`).then((r) => json<DashboardView>(r));

/**
 * Reminders (§8.4).
 *
 * `recurrence` is an RRULE string. The server parses a documented subset and
 * refuses what it does not implement, so an unsupported rule fails here with a
 * message rather than silently firing on the wrong day.
 */
export interface ReminderView {
  id: string;
  verseId: string | null;
  fireAt: string;
  title: string;
  body: string | null;
  recurrence: string | null;
  status: 'pending' | 'sent' | 'failed';
  occurrences: number;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export const fetchReminders = (): Promise<ReminderView[]> =>
  authedFetch('/v1/reminders')
    .then((r) => json<{ reminders: ReminderView[] }>(r))
    .then((body) => body.reminders);

export const createReminder = (input: {
  fireAt: string;
  title: string;
  body?: string | null;
  recurrence?: string | null;
  verseId?: string | null;
}): Promise<ReminderView> =>
  authedFetch('/v1/reminders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // A retry underneath the app must not set the same reminder twice.
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(input),
  }).then((r) => json<ReminderView>(r));

export interface QuietHoursView {
  startMinute: number;
  endMinute: number;
  timeZone: string;
}

export const fetchQuietHours = (): Promise<QuietHoursView | null> =>
  authedFetch('/v1/notifications/preferences')
    .then((r) => json<{ quietHours: QuietHoursView | null }>(r))
    .then((body) => body.quietHours);

export const saveQuietHours = (
  quiet: QuietHoursView | null,
): Promise<QuietHoursView | null> =>
  authedFetch('/v1/notifications/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      quiet
        ? {
            quietStartMinute: quiet.startMinute,
            quietEndMinute: quiet.endMinute,
            timeZone: quiet.timeZone,
          }
        : { quietStartMinute: null, quietEndMinute: null, timeZone: null },
    ),
  })
    .then((r) => json<{ quietHours: QuietHoursView | null }>(r))
    .then((body) => body.quietHours);

/* -------------------------------------------------------------------------
 * Privacy: a copy of everything, reading one back, and leaving (§8.5, §8.7).
 * ---------------------------------------------------------------------- */

export interface ExportStatusView {
  id: string;
  /** pending → ready, or failed. Built by a Cloud Task, not by the request. */
  status: 'pending' | 'ready' | 'failed' | string;
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
}

/** The last export request, or null if one was never made. */
export const fetchExportStatus = (): Promise<ExportStatusView | null> =>
  authedFetch('/v1/privacy/export').then((r) => json<ExportStatusView | null>(r));

export interface ExportRequested {
  id: string;
  /**
   * False when deferred work is not configured, which means the row exists and
   * nothing will ever build it. Surfaced rather than swallowed: waiting for an
   * export that is not coming is the silent failure §8.5 calls out.
   */
  queued: boolean;
  warning?: string;
}

/**
 * Asks for a copy of everything.
 *
 * A 429 here is not the shared rate limiter — it is the one-per-24h rule in
 * §8.6, expressed in the export table. Told apart because the two deserve
 * different words: "you already asked today" is a fact about the request, not
 * about traffic.
 */
export class ExportTooSoon extends Error {}

export async function requestExport(): Promise<ExportRequested> {
  const response = await authedFetch('/v1/privacy/export', { method: 'POST' });

  if (response.status === 429) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ExportTooSoon(
      body?.error?.message ?? 'You can ask for one copy a day. Try again tomorrow.',
    );
  }

  return json<ExportRequested>(response);
}

/**
 * Downloads the finished export.
 *
 * Fetched with the access token and handed to the browser as a blob rather than
 * linked to directly: the endpoint authenticates (§8.5's deviation — no signed
 * URL in an email), and an `<a href>` carries no Authorization header.
 */
export async function downloadExport(): Promise<{ blob: Blob; filename: string }> {
  const response = await authedFetch('/v1/privacy/export/download');
  if (!response.ok) await json<unknown>(response);

  return { blob: await response.blob(), filename: 'agnte-export.json' };
}

export interface ImportSummaryView {
  tags: number;
  verses: number;
  skipped: number;
  rejected: { what: string; why: string }[];
  mediaImported: false;
  note: string;
}

/** Reads an `agnte.export.v1` document back in. Never batched or retried here. */
export const importDocument = (document: unknown): Promise<ImportSummaryView> =>
  authedFetch('/v1/privacy/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(document),
  }).then((r) => json<ImportSummaryView>(r));

export interface ErasureView {
  status: string;
  modulesPurged: number;
  /** Not zero means a module could not purge; the sweep retries before removal. */
  modulesFailed: number;
  alreadyRequested: boolean;
}

/** Asks for the account to be erased. 202: marked now, removed after the grace window. */
export const eraseAccount = (): Promise<ErasureView> =>
  authedFetch('/v1/me', { method: 'DELETE' }).then((r) => json<ErasureView>(r));

/* -------------------------------------------------------------------------
 * Web Push (§8.4).
 * ---------------------------------------------------------------------- */

/** The VAPID public key, or null when this deployment has push switched off. */
export const fetchPushKey = (): Promise<string | null> =>
  authedFetch('/v1/push/key')
    .then((r) => json<{ publicKey: string | null }>(r))
    .then((body) => body.publicKey);

export const subscribeToPush = (subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<void> =>
  authedFetch('/v1/push/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subscription),
  }).then((r) => json<unknown>(r).then(() => undefined));

export const unsubscribeFromPush = (endpoint: string): Promise<void> =>
  authedFetch('/v1/push/subscriptions', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).then((r) => json<unknown>(r).then(() => undefined));
