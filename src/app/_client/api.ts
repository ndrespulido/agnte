'use client';

import { authedFetch } from './session';

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
  tagIds?: string[];
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

export const fetchTags = (): Promise<TagView[]> =>
  authedFetch('/v1/tags')
    .then((r) => json<{ tags: TagView[] }>(r))
    .then((body) => body.tags);

export const createTag = (name: string): Promise<TagView> =>
  authedFetch('/v1/tags', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then((r) => json<TagView>(r));

export interface NewVerse {
  tagIds: string[];
  xp?: string | null;
  location?: string | null;
  rating?: number | null;
  eventStart?: string | null;
  mediaIds?: string[];
}

export const createVerse = (input: NewVerse): Promise<VerseView> =>
  authedFetch('/v1/verses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // A phone on a flaky network retries underneath the app. Without this a
      // retry writes the verse twice (architecture.md §6).
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(input),
  }).then((r) => json<VerseView>(r));

export const searchVerses = (query: string): Promise<TimelinePage> =>
  authedFetch(`/v1/search?q=${encodeURIComponent(query)}`).then((r) =>
    json<TimelinePage>(r),
  );

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
