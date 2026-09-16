'use client';

import { uuidv7 } from '@/shared/kernel/id';
import type { NewVerse, TagView, VerseEdit } from './api';

/**
 * The outbox: every write is stored locally before it is sent (§8.1).
 *
 * ---------------------------------------------------------------------------
 * Why every write, and not only the ones made offline.
 *
 * The obvious design is "try the network, fall back to a queue". It has two
 * code paths for every mutation, and the rare one — the queue — is the one
 * nobody exercises, so it is the one that is broken. Worse, "offline" is not a
 * state a browser reliably knows: `navigator.onLine` is true on a train with a
 * captive portal and true in a basement with one bar, and the request simply
 * hangs until it times out.
 *
 * So there is one path. A write is written here, the caller is answered
 * immediately, and a drain sends it. Being offline stops being a special case
 * and becomes an ordinary slow send.
 * ---------------------------------------------------------------------------
 *
 * What this file is not: it holds entries and hands them out in order. Deciding
 * when to send, what a failure means, and when to give up is `sync.ts`.
 */

/** A tag as the timeline needs to draw it, carried so a queued verse can render. */
export interface TagLabel {
  id: string;
  name: string;
  label: string;
}

export type OutboxOp =
  | {
      kind: 'create-tag';
      /** Client-minted, so a verse queued behind it can name it already. */
      tagId: string;
      name: string;
    }
  | {
      kind: 'create-verse';
      verseId: string;
      body: NewVerse;
      /**
       * Enough to draw the row before the server has ever seen it. The ids in
       * `body` are the truth; these are what the reader looks at meanwhile, and
       * keeping them here rather than re-deriving from a tag list means a queued
       * verse still renders after a reload, with no network at all.
       */
      tags: TagLabel[];
    }
  | { kind: 'update-verse'; verseId: string; body: VerseEdit }
  | { kind: 'delete-verse'; verseId: string; expectedVersion: number };

/**
 * `queued` is on its way; `blocked` needs a person.
 *
 * Two states rather than a retry count the UI has to interpret. Blocked means
 * no amount of waiting will help — a conflict, a rejection, a request the
 * server will refuse every time — and the distinction matters because the two
 * deserve different words: "sending" is reassurance, "this one didn't go" is a
 * request for attention.
 */
export type OutboxState = 'queued' | 'blocked';

export interface OutboxEntry {
  /** UUIDv7: also the replay order, which is why it is not a random id. */
  readonly id: string;
  readonly op: OutboxOp;
  /**
   * Stable across every retry of this entry — that is the entire point.
   * A fresh key per attempt would let a retry after a lost response write the
   * same verse twice (§6).
   */
  readonly idempotencyKey: string;
  readonly queuedAt: number;
  readonly attempts: number;
  /** Epoch ms; the backoff lives here rather than in a timer that a reload loses. */
  readonly nextAttemptAt: number;
  readonly lastError: string | null;
  readonly state: OutboxState;
}

/**
 * Where entries live.
 *
 * A port, so the queue's behaviour can be driven in a test without IndexedDB —
 * and so a browser that refuses IndexedDB (a private window, blocked site data)
 * degrades to an in-memory queue rather than failing every write. That
 * degradation is real and worth naming: writes then survive a network blip but
 * not a reload.
 */
export interface OutboxStore {
  all(): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'agnte';
const DB_VERSION = 1;
const STORE = 'outbox';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Could not open the local database.'));
    };
  });
}

const run = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('The local database refused that.'));
    };
  });

export function indexedDbStore(): OutboxStore {
  // Opened once and shared: a database handle per operation makes a queue drain
  // of ten entries ten open requests, each of which can block on an upgrade.
  let opening: Promise<IDBDatabase> | null = null;
  const db = () => (opening ??= openDatabase());

  const tx = async (mode: IDBTransactionMode) =>
    (await db()).transaction(STORE, mode).objectStore(STORE);

  return {
    async all() {
      return (await run((await tx('readonly')).getAll())) as OutboxEntry[];
    },
    async put(entry) {
      await run((await tx('readwrite')).put(entry));
    },
    async remove(id) {
      await run((await tx('readwrite')).delete(id));
    },
  };
}

export function memoryStore(): OutboxStore {
  const entries = new Map<string, OutboxEntry>();
  return {
    all: async () => [...entries.values()],
    put: async (entry) => {
      entries.set(entry.id, entry);
    },
    remove: async (id) => {
      entries.delete(id);
    },
  };
}

/**
 * The store this browser can actually use.
 *
 * IndexedDB's absence is checked by touching it rather than by sniffing the
 * user agent, and the open is not awaited here — a browser that has the API but
 * refuses the open surfaces that on the first read, where `sync.ts` can fall
 * back. Anything that throws lands in memory, which keeps the app working.
 */
export function defaultStore(): OutboxStore {
  try {
    if (typeof indexedDB === 'undefined') return memoryStore();
    return indexedDbStore();
  } catch {
    return memoryStore();
  }
}

/** A new entry, ready to be stored. `at` is injectable so tests can hold time. */
export function newEntry(op: OutboxOp, at: number = Date.now()): OutboxEntry {
  return {
    id: uuidv7(at),
    op,
    idempotencyKey: crypto.randomUUID(),
    queuedAt: at,
    attempts: 0,
    nextAttemptAt: at,
    lastError: null,
    state: 'queued',
  };
}

/**
 * Oldest first, by id.
 *
 * Order is not a nicety here: a verse's update is queued behind its create, and
 * a create-tag behind neither. UUIDv7 sorts lexicographically by mint time, so
 * the ids the entries already carry are the ordering — no separate sequence to
 * keep consistent, and it survives a reload because it is in the id itself.
 */
export const inOrder = (entries: readonly OutboxEntry[]): OutboxEntry[] =>
  [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** The verse ids a set of entries is holding writes for. */
export function pendingVerseIds(entries: readonly OutboxEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.op.kind !== 'create-tag') ids.add(entry.op.verseId);
  }
  return ids;
}

/** A tag queued for creation, shaped like the ones the API returns. */
export function tagLabelOf(op: Extract<OutboxOp, { kind: 'create-tag' }>): TagView {
  const name = op.name.replace(/^\.+/, '').toLowerCase();
  return {
    id: op.tagId,
    name,
    label: `.${name}`,
    visibility: 'private',
    shortcut: null,
    vertical: null,
    suggestedProperties: [],
    version: 0,
  };
}
