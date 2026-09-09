import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import {
  handleConfirmUpload,
  handleDeleteMedia,
  handleRequestUpload,
} from '@/modules/media';
import { resetMediaBlobStoreForTests } from '@/modules/media/infrastructure/blob-store';
import { LocalMediaBlobStore } from '@/modules/media/infrastructure/local-media-blob-store';

/**
 * `/v1/media` end to end, over the filesystem blob-store adapter (real
 * Postgres, real auth, real routes) — the presigned-URL specifics already
 * have their own coverage in tests/integration/{request-upload,confirm-
 * upload}.test.ts against R2/s3rver. What this file is for is the wiring:
 * does the route parse the body, call the application layer, and shape the
 * response the way a client actually sees it.
 *
 * Writes bytes with the same default-rooted `LocalMediaBlobStore` the
 * confirm route's own `getMediaBlobStore()` factory constructs — not a test-
 * local temp directory — since the whole point of this suite is exercising
 * that exact wiring; a separate root would silently talk to a different
 * filesystem location than the route itself reads from. See tests/
 * integration/dev-media-routes.test.ts for the same convention.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const PASSWORD = 'a sufficiently long password';
const localStore = new LocalMediaBlobStore();
const uploadedKeys: string[] = [];

let emailed: string[] = [];
let ipCounter = 0;
const freshIp = () => `192.0.2.${(ipCounter += 1) % 250}`;

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

describe.skipIf(!DATABASE_URL)('media routes', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'b'.repeat(64);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.R2_ENDPOINT;
    resetConfigForTests();
    resetEmailTransportForTests();
    resetMediaBlobStoreForTests();

    emailed = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      emailed.push(args.join(' '));
    });

    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM media.media');
    await db.$executeRawUnsafe('DELETE FROM identity.refresh_token');
    await db.$executeRawUnsafe('DELETE FROM identity.pending_registration');
    await db.$executeRawUnsafe('DELETE FROM identity."user"');
    await db.$executeRawUnsafe('DELETE FROM platform.rate_limit_window');
    await db.$executeRawUnsafe('DELETE FROM platform.idempotency_key');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetEmailTransportForTests();
    resetMediaBlobStoreForTests();
    await Promise.all(uploadedKeys.splice(0).map((key) => localStore.delete(key)));
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
        { 'x-forwarded-for': ip },
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
        { 'x-forwarded-for': ip },
      ),
    );
    const tokens = (await logged.json()) as { accessToken: string };

    return { token: tokens.accessToken, userId: user.user.id };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const requestUpload = (
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    handleRequestUpload(
      json('POST', 'https://agnte.test/v1/media', body, { ...bearer(token), ...headers }),
    );

  const confirm = (token: string, mediaId: string, body: unknown) =>
    handleConfirmUpload(
      json('POST', `https://agnte.test/v1/media/${mediaId}/confirm`, body, bearer(token)),
      mediaId,
    );

  const del = (token: string, mediaId: string, expectedVersion: number) =>
    handleDeleteMedia(
      new Request(
        `https://agnte.test/v1/media/${mediaId}?expectedVersion=${expectedVersion}`,
        { method: 'DELETE', headers: bearer(token) },
      ),
      mediaId,
    );

  it('401s an upload request with no token', async () => {
    const response = await handleRequestUpload(
      json('POST', 'https://agnte.test/v1/media', {
        contentType: 'image/jpeg',
        declaredSizeBytes: 400_000,
      }),
    );
    expect(response.status).toBe(401);
  });

  it('400s a body missing the required fields', async () => {
    const { token } = await signUp('a@example.com');
    const response = await requestUpload(token, { contentType: 'image/jpeg' });
    expect(response.status).toBe(400);
  });

  it('walks an upload from request through confirm to delete', async () => {
    const { token } = await signUp('b@example.com');

    const requested = await requestUpload(token, {
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
    });
    expect(requested.status).toBe(201);
    const created = (await requested.json()) as {
      media: { id: string; status: string; version: number };
      upload: { url: string; method: string; headers: Record<string, string> };
    };
    expect(created.media.status).toBe('pending');
    expect(created.upload.method).toBe('PUT');

    // A real, tiny JPEG rather than placeholder bytes: locally, confirming
    // runs the thumbnail job synchronously in-process to completion
    // (architecture.md §7.1) before this response is even sent, so by the
    // time it comes back the row may already be `ready` — this is the case
    // that exercises that path honestly instead of a mismatch/failed one.
    const key = created.upload.url.replace('/dev/media/', '');
    uploadedKeys.push(key);
    const jpeg = await sharp({
      create: { width: 40, height: 30, channels: 3, background: 'teal' },
    })
      .jpeg()
      .toBuffer();
    await localStore.writeBuffer(key, jpeg);

    const confirmed = await confirm(token, created.media.id, {
      expectedVersion: created.media.version,
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as { status: string; version: number };
    expect(confirmedBody.status).toBe('ready');

    const deleted = await del(token, created.media.id, confirmedBody.version);
    expect(deleted.status).toBe(204);
  });

  it('replays the same response for a repeated Idempotency-Key rather than creating a second row', async () => {
    const { token } = await signUp('c@example.com');
    const body = { contentType: 'image/jpeg', declaredSizeBytes: 400_000 };
    const headers = { 'idempotency-key': 'fixed-key-1' };

    const first = await requestUpload(token, body, headers);
    const second = await requestUpload(token, body, headers);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { media: { id: string } };
    const secondBody = (await second.json()) as { media: { id: string } };
    expect(secondBody.media.id).toBe(firstBody.media.id);

    const rows = await getDatabase()!.$queryRawUnsafe<unknown[]>(
      'SELECT id FROM media.media WHERE id = $1::uuid',
      firstBody.media.id,
    );
    expect(rows).toHaveLength(1);
  });

  it('404s confirming a media id belonging to another user', async () => {
    const { token: ownerToken } = await signUp('owner@example.com');
    const { token: otherToken } = await signUp('other@example.com');

    const requested = await requestUpload(ownerToken, {
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
    });
    const created = (await requested.json()) as {
      media: { id: string; version: number };
    };

    const response = await confirm(otherToken, created.media.id, { expectedVersion: 0 });
    expect(response.status).toBe(404);
  });

  it('404s deleting a media id that does not exist', async () => {
    const { token } = await signUp('d@example.com');
    const response = await del(token, '01970000-0000-7000-8000-000000000000', 0);
    expect(response.status).toBe(404);
  });
});
