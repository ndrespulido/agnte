import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { getObjectStorage } from '@/shared/infra/object-storage';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import { handleCreateTag, handleCreateVerse } from '@/modules/verse';
import { buildExport, handleImport, handleRequestExport } from '@/modules/privacy';
import { MAX_ROWS } from '@/modules/verse/application/import';

/**
 * Importing an export back in (Phase 9's foundation).
 *
 * The test that matters most is the round trip: export from one account, import
 * into another, and get the same writing back. That is what makes a v1
 * migration a converter script rather than a bespoke pipeline — if this holds,
 * anything that can produce an `agnte.export.v1` document can become an Agnte
 * timeline.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const PASSWORD = 'a sufficiently long password';

let emailed: string[] = [];
let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

const json = (
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

interface Summary {
  tags: number;
  verses: number;
  skipped: number;
  rejected: { what: string; why: string }[];
  mediaImported: false;
}

describe.skipIf(!DATABASE_URL)('import', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'a'.repeat(64);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    resetConfigForTests();
    resetEmailTransportForTests();

    emailed = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      emailed.push(args.join(' '));
    });

    const db = getDatabase()!;
    for (const table of [
      'privacy.export_request',
      'notifications.scheduled_notification',
      'verse.verse',
      'verse.tag',
      'identity.refresh_token',
      'identity.pending_registration',
      'identity."user"',
      'platform.rate_limit_window',
      'platform.idempotency_key',
    ]) {
      await db.$executeRawUnsafe(`DELETE FROM ${table}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetEmailTransportForTests();
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  async function signUp(email: string): Promise<{ token: string; userId: string }> {
    const ip = freshIp();
    await handleRegister(
      json(
        'POST',
        'https://agnte.test/v1/auth/register',
        { email, password: PASSWORD },
        {
          'x-forwarded-for': ip,
        },
      ),
    );
    const match = (emailed.at(-1) ?? '').match(/verify-email\?token=([^\s]+)/);
    if (!match?.[1]) throw new Error('no verification link');
    const verified = await handleVerifyEmail(
      new Request(`https://agnte.test/v1/auth/verify-email?token=${match[1]}`),
    );
    const { user } = (await verified.json()) as { user: { id: string } };

    const logged = await handleLogin(
      json(
        'POST',
        'https://agnte.test/v1/auth/login',
        { email, password: PASSWORD },
        {
          'x-forwarded-for': ip,
        },
      ),
    );
    const { accessToken } = (await logged.json()) as { accessToken: string };
    return { token: accessToken, userId: user.id };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const importDocument = (token: string, document: unknown) =>
    handleImport(
      json('POST', 'https://agnte.test/v1/privacy/import', document, bearer(token)),
    );

  /** Produces a real export document by going through the real export path. */
  async function exportedFrom(token: string): Promise<Record<string, unknown>> {
    const requested = await handleRequestExport(
      new Request('https://agnte.test/v1/privacy/export', {
        method: 'POST',
        headers: bearer(token),
      }),
    );
    const { id } = (await requested.json()) as { id: string };
    await buildExport(id, new Date());

    const key = (
      await getDatabase()!.$queryRawUnsafe<{ storage_key: string }[]>(
        'SELECT storage_key FROM privacy.export_request WHERE id = $1::uuid',
        id,
      )
    )[0]!.storage_key;

    return JSON.parse((await getObjectStorage()!.get(key))!) as Record<string, unknown>;
  }

  it('refuses without a token', async () => {
    const response = await handleImport(
      json('POST', 'https://agnte.test/v1/privacy/import', { format: 'agnte.export.v1' }),
    );
    expect(response.status).toBe(401);
  });

  /**
   * Checked by name rather than sniffed. A document from somewhere else might
   * happen to have `verses` and `tags` arrays, and guessing would write
   * half-understood rows into someone's timeline.
   */
  it('refuses a document that is not one of ours', async () => {
    const { token } = await signUp('stranger@example.com');

    const response = await importDocument(token, {
      format: 'someone.else.v3',
      verses: [{ xp: 'hello' }],
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('privacy.unknown_import_format');
  });

  /** The round trip Phase 9 rests on. */
  it('carries a timeline from one account to another', async () => {
    const source = await signUp('source@example.com');
    const target = await signUp('target@example.com');

    const tag = await handleCreateTag(
      json(
        'POST',
        'https://agnte.test/v1/tags',
        { name: 'barcelona' },
        bearer(source.token),
      ),
    );
    const { id: tagId } = (await tag.json()) as { id: string };

    await handleCreateVerse(
      json(
        'POST',
        'https://agnte.test/v1/verses',
        {
          tagIds: [tagId],
          eventStart: '2025-06-02T08:30:00.000Z',
          xp: 'Early flight, worth it',
          location: 'Barcelona',
          rating: 7,
          properties: { amount: '184.20' },
        },
        { ...bearer(source.token), 'idempotency-key': crypto.randomUUID() },
      ),
    );

    const document = await exportedFrom(source.token);
    const response = await importDocument(target.token, document);
    const summary = (await response.json()) as Summary;

    expect(response.status).toBe(200);
    expect(summary).toMatchObject({ tags: 1, verses: 1, rejected: [] });
    // Said outright: an export links to photos rather than carrying them.
    expect(summary.mediaImported).toBe(false);

    const rows = await getDatabase()!.$queryRawUnsafe<
      { xp: string; location: string; rating: number; properties: unknown }[]
    >(
      'SELECT xp, location, rating, properties FROM verse.verse WHERE owner_id = $1::uuid',
      target.userId,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      xp: 'Early flight, worth it',
      location: 'Barcelona',
      rating: 7,
    });
    expect(rows[0]?.properties).toEqual({ amount: '184.20' });
  });

  /**
   * Idempotent by content rather than by an idempotency key: rows are matched
   * by id and skipped, which is a stronger guarantee than a 24-hour window and
   * makes "run it, fix the file, run it again" the natural way to use this.
   */
  it('is a no-op when run twice', async () => {
    const source = await signUp('twice-source@example.com');
    const target = await signUp('twice-target@example.com');

    const tag = await handleCreateTag(
      json(
        'POST',
        'https://agnte.test/v1/tags',
        { name: 'lisbon' },
        bearer(source.token),
      ),
    );
    const { id: tagId } = (await tag.json()) as { id: string };
    await handleCreateVerse(
      json(
        'POST',
        'https://agnte.test/v1/verses',
        { tagIds: [tagId], xp: 'once' },
        { ...bearer(source.token), 'idempotency-key': crypto.randomUUID() },
      ),
    );

    const document = await exportedFrom(source.token);

    const first = (await (
      await importDocument(target.token, document)
    ).json()) as Summary;
    const second = (await (
      await importDocument(target.token, document)
    ).json()) as Summary;

    expect(first).toMatchObject({ tags: 1, verses: 1 });
    expect(second).toMatchObject({ tags: 0, verses: 0, skipped: 2 });

    const count = await getDatabase()!.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM verse.verse WHERE owner_id = $1::uuid',
      target.userId,
    );
    expect(Number(count[0]!.n)).toBe(1);
  });

  /**
   * The document is not trusted about whose tags it names. Without this a
   * hand-edited file could file a verse into a stranger's tag — and since tag
   * visibility drives verse visibility, that is a disclosure route, not just
   * untidy data.
   */
  it('refuses a verse that names a tag belonging to someone else', async () => {
    const stranger = await signUp('stranger-tags@example.com');
    const attacker = await signUp('attacker@example.com');

    const tag = await handleCreateTag(
      json(
        'POST',
        'https://agnte.test/v1/tags',
        { name: 'private-trip' },
        bearer(stranger.token),
      ),
    );
    const { id: strangerTagId } = (await tag.json()) as { id: string };

    const response = await importDocument(attacker.token, {
      format: 'agnte.export.v1',
      tags: [],
      verses: [{ xp: 'smuggled in', tag_ids: [strangerTagId] }],
    });
    const summary = (await response.json()) as Summary;

    expect(summary.verses).toBe(0);
    expect(summary.rejected).toHaveLength(1);
    expect(summary.rejected[0]?.why).toContain('not yours');
  });

  it('reports what it refused rather than dropping it', async () => {
    const { token } = await signUp('messy@example.com');

    const response = await importDocument(token, {
      format: 'agnte.export.v1',
      tags: [
        { name: 'good' },
        { name: '' },
        { name: 'wrong-visibility', visibility: 'everyone' },
      ],
      verses: [{ xp: 'no tags on me', tag_ids: [] }],
    });
    const summary = (await response.json()) as Summary;

    expect(summary.tags).toBe(1);
    expect(summary.rejected).toHaveLength(3);
    // The refused visibility names itself rather than being silently defaulted.
    expect(summary.rejected.some((r) => r.why.includes('not a visibility'))).toBe(true);
  });

  /**
   * The shape a v1 converter will actually emit. v1's ids are not UUIDs, so
   * nothing in the file can be kept as a primary key — and a converter that had
   * to renumber its rows between runs would make a second run duplicate
   * everything. The ids are derived instead, which is what keeps "run it, fix
   * the file, run it again" safe.
   */
  it('accepts ids that are not UUIDs, and still runs twice cleanly', async () => {
    const { token, userId } = await signUp('v1@example.com');

    const document = {
      format: 'agnte.export.v1',
      tags: [{ id: 'clh3x8k2p0000qwer1234asdf', name: 'lisbon' }],
      verses: [
        {
          id: 'clh3x8k2p0001qwer5678hjkl',
          xp: 'converted from v1',
          tag_ids: ['clh3x8k2p0000qwer1234asdf'],
        },
      ],
    };

    const first = (await (await importDocument(token, document)).json()) as Summary;
    expect(first).toMatchObject({ tags: 1, verses: 1, rejected: [] });

    const second = (await (await importDocument(token, document)).json()) as Summary;
    expect(second).toMatchObject({ tags: 0, verses: 0, skipped: 2 });

    const count = await getDatabase()!.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM verse.verse WHERE owner_id = $1::uuid',
      userId,
    );
    expect(Number(count[0]!.n)).toBe(1);
  });

  /**
   * A verse naming a tag the document does not carry and this account does not
   * have. Passing it to the ownership query would fail the cast and take the
   * whole import down with it, so it is refused as a row like any other.
   */
  it('refuses a verse naming a tag id it cannot resolve', async () => {
    const { token } = await signUp('dangling@example.com');

    const response = await importDocument(token, {
      format: 'agnte.export.v1',
      tags: [{ name: 'kept' }],
      verses: [{ xp: 'orphan', tag_ids: ['some-v1-id-that-is-not-here'] }],
    });
    const summary = (await response.json()) as Summary;

    expect(response.status).toBe(200);
    expect(summary).toMatchObject({ tags: 1, verses: 0 });
    expect(summary.rejected).toHaveLength(1);
  });

  /**
   * Cloud Run has a finite request deadline and kills the container once the
   * response returns (§1.3), so an import that cannot finish inside one request
   * is refused up front rather than cut off partway through writing.
   */
  it('refuses a document with more rows than one request can finish', async () => {
    const { token } = await signUp('huge@example.com');

    const response = await importDocument(token, {
      format: 'agnte.export.v1',
      tags: Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ name: `tag-${i}` })),
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('too large');

    const tags = await getDatabase()!.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM verse.tag',
    );
    // Refused before anything was written, not partway through.
    expect(Number(tags[0]!.n)).toBe(0);
  });

  it('refuses a body too large to hold, before parsing it', async () => {
    const { token } = await signUp('fat@example.com');

    const response = await handleImport(
      new Request('https://agnte.test/v1/privacy/import', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(50_000_000),
          ...bearer(token),
        },
        body: JSON.stringify({ format: 'agnte.export.v1', tags: [{ name: 'small' }] }),
      }),
    );

    expect(response.status).toBe(413);
  });

  it('files into an existing tag of the same name rather than making a second', async () => {
    const source = await signUp('same-name-source@example.com');
    const target = await signUp('same-name-target@example.com');

    for (const who of [source, target]) {
      await handleCreateTag(
        json(
          'POST',
          'https://agnte.test/v1/tags',
          { name: 'barcelona' },
          bearer(who.token),
        ),
      );
    }

    const sourceTags = await getDatabase()!.$queryRawUnsafe<{ id: string }[]>(
      'SELECT id FROM verse.tag WHERE owner_id = $1::uuid',
      source.userId,
    );
    await handleCreateVerse(
      json(
        'POST',
        'https://agnte.test/v1/verses',
        { tagIds: [sourceTags[0]!.id], xp: 'from the trip' },
        { ...bearer(source.token), 'idempotency-key': crypto.randomUUID() },
      ),
    );

    const document = await exportedFrom(source.token);
    const summary = (await (
      await importDocument(target.token, document)
    ).json()) as Summary;

    // The tag was skipped, not duplicated — and the verse still landed.
    expect(summary).toMatchObject({ tags: 0, verses: 1 });

    const tags = await getDatabase()!.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM verse.tag WHERE owner_id = $1::uuid',
      target.userId,
    );
    expect(Number(tags[0]!.n)).toBe(1);
  });
});
