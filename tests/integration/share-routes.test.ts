import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import {
  handleCreateTag,
  handleCreateVerse,
  handleGetVerse,
  handleListTagShares,
  handleRevokeTagShare,
  handleRevokeVerseShare,
  handleShareTag,
  handleShareVerse,
  handleUpdateVerse,
} from '@/modules/verse';

/** Sharing: who it reaches, what it does not open, and what is refused. */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const PASSWORD = 'a sufficiently long password';

let emailed: string[] = [];
let ipCounter = 0;
const freshIp = () => `198.19.0.${(ipCounter += 1) % 250}`;

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

describe.skipIf(!DATABASE_URL)('share routes', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'd'.repeat(64);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    resetConfigForTests();
    resetEmailTransportForTests();

    emailed = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      emailed.push(args.join(' '));
    });

    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM verse.verse');
    await db.$executeRawUnsafe('DELETE FROM verse.tag');
    await db.$executeRawUnsafe('DELETE FROM identity.refresh_token');
    await db.$executeRawUnsafe('DELETE FROM identity.pending_registration');
    await db.$executeRawUnsafe('DELETE FROM identity."user"');
    await db.$executeRawUnsafe('DELETE FROM platform.rate_limit_window');
    await db.$executeRawUnsafe('DELETE FROM platform.idempotency_key');
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

  async function signUp(email: string) {
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
    const user = (await verified.json()) as { user: { id: string } };
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
    const tokens = (await logged.json()) as { accessToken: string };
    return { token: tokens.accessToken, userId: user.user.id };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const makeTag = async (token: string, name: string, visibility?: string) => {
    const response = await handleCreateTag(
      json(
        'POST',
        'https://agnte.test/v1/tags',
        visibility === undefined ? { name } : { name, visibility },
        bearer(token),
      ),
    );
    return (await response.json()) as { id: string };
  };

  const makeVerse = async (token: string, body: Record<string, unknown>) => {
    const response = await handleCreateVerse(
      json('POST', 'https://agnte.test/v1/verses', body, bearer(token)),
    );
    return (await response.json()) as { id: string };
  };

  const shareTag = (token: string, tagId: string, body: unknown) =>
    handleShareTag(
      json('POST', `https://agnte.test/v1/tags/${tagId}/shares`, body, bearer(token)),
      tagId,
    );

  const get = (token: string, id: string) =>
    handleGetVerse(
      new Request(`https://agnte.test/v1/verses/${id}`, { headers: bearer(token) }),
      id,
    );

  it('a share on a shared tag reaches its verses', async () => {
    const owner = await signUp('a@example.com');
    const friend = await signUp('b@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');
    const verse = await makeVerse(owner.token, { tagIds: [tag.id] });

    expect((await get(friend.token, verse.id)).status).toBe(404);

    const shared = await shareTag(owner.token, tag.id, { granteeId: friend.userId });
    expect(shared.status).toBe(201);

    expect((await get(friend.token, verse.id)).status).toBe(200);
  });

  it('a verse-level share reaches only that verse', async () => {
    const owner = await signUp('c@example.com');
    const friend = await signUp('d@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');
    const shownVerse = await makeVerse(owner.token, { tagIds: [tag.id] });
    const otherVerse = await makeVerse(owner.token, { tagIds: [tag.id] });

    await handleShareVerse(
      json(
        'POST',
        `https://agnte.test/v1/verses/${shownVerse.id}/shares`,
        { granteeId: friend.userId },
        bearer(owner.token),
      ),
      shownVerse.id,
    );

    expect((await get(friend.token, shownVerse.id)).status).toBe(200);
    expect((await get(friend.token, otherVerse.id)).status).toBe(404);
  });

  it('a share never opens a private verse', async () => {
    // Sharing grants nothing the visibility rule does not already allow: a
    // second private tag still buries the verse.
    const owner = await signUp('e@example.com');
    const friend = await signUp('f@example.com');
    const trip = await makeTag(owner.token, 'trip', 'shared');
    const medical = await makeTag(owner.token, 'medical', 'private');
    const verse = await makeVerse(owner.token, { tagIds: [trip.id, medical.id] });

    await shareTag(owner.token, trip.id, { granteeId: friend.userId });

    expect((await get(friend.token, verse.id)).status).toBe(404);
  });

  it('sharing is read-only: the grantee cannot write', async () => {
    const owner = await signUp('g@example.com');
    const friend = await signUp('h@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');
    const verse = await makeVerse(owner.token, { tagIds: [tag.id] });

    await shareTag(owner.token, tag.id, { granteeId: friend.userId });
    expect((await get(friend.token, verse.id)).status).toBe(200);

    // Readable, and still not writable.
    const attempt = await handleUpdateVerse(
      json(
        'PATCH',
        `https://agnte.test/v1/verses/${verse.id}`,
        { xp: 'not yours', expectedVersion: 0 },
        bearer(friend.token),
      ),
      verse.id,
    );
    expect(attempt.status).toBe(404);
  });

  it('refuses contribute with 501 rather than silently granting read', async () => {
    // CLAUDE.md open decision 1. Accepting it as read-only would leave the
    // owner believing they had given access they had not.
    const owner = await signUp('i@example.com');
    const friend = await signUp('j@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');

    const response = await shareTag(owner.token, tag.id, {
      granteeId: friend.userId,
      permission: 'contribute',
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { code: 'verse.share_not_permitted' },
    });

    // And nothing was recorded.
    const listed = await handleListTagShares(
      new Request(`https://agnte.test/v1/tags/${tag.id}/shares`, {
        headers: bearer(owner.token),
      }),
      tag.id,
    );
    expect((await listed.json()) as { shares: unknown[] }).toMatchObject({ shares: [] });
  });

  it('refuses an unknown permission', async () => {
    const owner = await signUp('k@example.com');
    const friend = await signUp('l@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');

    const response = await shareTag(owner.token, tag.id, {
      granteeId: friend.userId,
      permission: 'admin',
    });
    expect(response.status).toBe(422);
  });

  it('refuses sharing with yourself instead of quietly succeeding', async () => {
    const owner = await signUp('m@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');

    const response = await shareTag(owner.token, tag.id, { granteeId: owner.userId });
    expect(response.status).toBe(422);
  });

  it('refuses to share a tag that is not yours, with 404', async () => {
    const owner = await signUp('n@example.com');
    const stranger = await signUp('o@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');

    const response = await shareTag(stranger.token, tag.id, {
      granteeId: stranger.userId,
    });
    expect(response.status).toBe(404);
  });

  it('revoking removes access', async () => {
    const owner = await signUp('p@example.com');
    const friend = await signUp('q@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');
    const verse = await makeVerse(owner.token, { tagIds: [tag.id] });

    await shareTag(owner.token, tag.id, { granteeId: friend.userId });
    expect((await get(friend.token, verse.id)).status).toBe(200);

    const revoked = await handleRevokeTagShare(
      new Request(
        `https://agnte.test/v1/tags/${tag.id}/shares?granteeId=${friend.userId}`,
        { method: 'DELETE', headers: bearer(owner.token) },
      ),
      tag.id,
    );
    expect(revoked.status).toBe(204);
    expect((await get(friend.token, verse.id)).status).toBe(404);
  });

  it('revoking a share that never existed still succeeds', async () => {
    // The caller's intent — "this person must not have access" — is satisfied
    // either way, and a 404 would disclose something about a share they are
    // entitled to change.
    const owner = await signUp('r@example.com');
    const stranger = await signUp('s@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');

    const response = await handleRevokeTagShare(
      new Request(
        `https://agnte.test/v1/tags/${tag.id}/shares?granteeId=${stranger.userId}`,
        { method: 'DELETE', headers: bearer(owner.token) },
      ),
      tag.id,
    );
    expect(response.status).toBe(204);
  });

  it('revoking a verse share needs a granteeId', async () => {
    const owner = await signUp('t@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');
    const verse = await makeVerse(owner.token, { tagIds: [tag.id] });

    const response = await handleRevokeVerseShare(
      new Request(`https://agnte.test/v1/verses/${verse.id}/shares`, {
        method: 'DELETE',
        headers: bearer(owner.token),
      }),
      verse.id,
    );
    expect(response.status).toBe(400);
  });

  it('lists who a tag is shared with, to its owner only', async () => {
    const owner = await signUp('u@example.com');
    const friend = await signUp('v@example.com');
    const stranger = await signUp('w@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');

    await shareTag(owner.token, tag.id, { granteeId: friend.userId });

    const mine = await handleListTagShares(
      new Request(`https://agnte.test/v1/tags/${tag.id}/shares`, {
        headers: bearer(owner.token),
      }),
      tag.id,
    );
    expect((await mine.json()) as { shares: { granteeId: string }[] }).toMatchObject({
      shares: [{ granteeId: friend.userId, permission: 'read' }],
    });

    const theirs = await handleListTagShares(
      new Request(`https://agnte.test/v1/tags/${tag.id}/shares`, {
        headers: bearer(stranger.token),
      }),
      tag.id,
    );
    expect(theirs.status).toBe(404);
  });

  it('re-sharing the same person twice is not an error', async () => {
    const owner = await signUp('x@example.com');
    const friend = await signUp('y@example.com');
    const tag = await makeTag(owner.token, 'trip', 'shared');

    expect(
      (await shareTag(owner.token, tag.id, { granteeId: friend.userId })).status,
    ).toBe(201);
    expect(
      (await shareTag(owner.token, tag.id, { granteeId: friend.userId })).status,
    ).toBe(201);

    const listed = await handleListTagShares(
      new Request(`https://agnte.test/v1/tags/${tag.id}/shares`, {
        headers: bearer(owner.token),
      }),
      tag.id,
    );
    expect(((await listed.json()) as { shares: unknown[] }).shares).toHaveLength(1);
  });
});
