import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { getObjectStorage } from '@/shared/infra/object-storage';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import { handleCreateTag, handleCreateVerse } from '@/modules/verse';
import { handleCreateReminder } from '@/modules/notifications';
import {
  EXPORT_COOLDOWN_MS,
  buildExport,
  handleDownloadExport,
  handleExportStatus,
  handleRequestExport,
} from '@/modules/privacy';

/**
 * Data export (§8.5), which doubles as GDPR portability.
 *
 * The question worth answering here is not "does a file appear" but "does the
 * file contain what the person actually owns, and nobody else's" — which needs
 * two real accounts and a real database.
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

interface ExportDocument {
  format: string;
  account: { id: string; email: string | null };
  verses: { xp: string | null }[];
  tags: { name: string }[];
  reminders: { title: string }[];
  media: unknown[];
}

describe.skipIf(!DATABASE_URL)('data export', () => {
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

  async function populate(token: string, marker: string): Promise<void> {
    const tag = await handleCreateTag(
      json('POST', 'https://agnte.test/v1/tags', { name: marker }, bearer(token)),
    );
    const { id: tagId } = (await tag.json()) as { id: string };

    await handleCreateVerse(
      json(
        'POST',
        'https://agnte.test/v1/verses',
        {
          tagIds: [tagId],
          eventStart: '2026-01-01T00:00:00.000Z',
          xp: `note for ${marker}`,
        },
        { ...bearer(token), 'idempotency-key': crypto.randomUUID() },
      ),
    );

    await handleCreateReminder(
      json(
        'POST',
        'https://agnte.test/v1/reminders',
        { title: `remind ${marker}`, fireAt: '2027-01-01T09:00:00.000Z' },
        { ...bearer(token), 'idempotency-key': crypto.randomUUID() },
      ),
    );
  }

  const request = (token: string) =>
    handleRequestExport(
      new Request('https://agnte.test/v1/privacy/export', {
        method: 'POST',
        headers: bearer(token),
      }),
    );

  it('refuses without a token', async () => {
    const response = await handleRequestExport(
      new Request('https://agnte.test/v1/privacy/export', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
  });

  it('accepts a request and reports it as pending', async () => {
    const { token } = await signUp('exporter@example.com');

    const response = await request(token);
    const body = (await response.json()) as { status: string; queued: boolean };

    expect(response.status).toBe(202);
    expect(body.status).toBe('pending');

    const status = await handleExportStatus(
      new Request('https://agnte.test/v1/privacy/export', { headers: bearer(token) }),
    );
    expect((await status.json()) as { status: string }).toMatchObject({
      status: 'pending',
    });
  });

  /**
   * Said out loud rather than hidden behind a cheerful 202. Without deferred
   * work configured the row exists and nothing picks it up, which is the exact
   * silent failure that cost this project a day of blank thumbnails.
   */
  it('warns when nothing will ever build the export', async () => {
    const { token } = await signUp('nowhere@example.com');
    const body = (await (await request(token)).json()) as {
      queued: boolean;
      warning?: string;
    };

    // Locally there is no Cloud Tasks configuration.
    expect(body.queued).toBe(false);
    expect(body.warning).toContain('not configured');
  });

  it('allows one export per day', async () => {
    const { token } = await signUp('again@example.com');

    expect((await request(token)).status).toBe(202);
    const second = await request(token);

    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('privacy.export_too_soon');
  });

  it('allows another once the day has passed', async () => {
    const { token, userId } = await signUp('later@example.com');
    await request(token);

    // Age the request rather than the clock: the cooldown is answered from the
    // row, so the row is the honest thing to move.
    await getDatabase()!.$executeRawUnsafe(
      `UPDATE privacy.export_request
          SET requested_at = $2
        WHERE user_id = $1::uuid`,
      userId,
      new Date(Date.now() - EXPORT_COOLDOWN_MS - 60_000),
    );

    expect((await request(token)).status).toBe(202);
  });

  describe('the document', () => {
    it("contains this person's data and nobody else's", async () => {
      const mine = await signUp('mine@example.com');
      const theirs = await signUp('theirs@example.com');
      await populate(mine.token, 'barcelona');
      await populate(theirs.token, 'lisbon');

      const { id } = (await (await request(mine.token)).json()) as { id: string };
      expect(await buildExport(id, new Date())).toBe(true);

      const key = (
        await getDatabase()!.$queryRawUnsafe<{ storage_key: string }[]>(
          'SELECT storage_key FROM privacy.export_request WHERE id = $1::uuid',
          id,
        )
      )[0]!.storage_key;

      const raw = await getObjectStorage()!.get(key);
      const document = JSON.parse(raw!) as ExportDocument;

      expect(document.format).toBe('agnte.export.v1');
      expect(document.account.id).toBe(mine.userId);
      expect(document.tags.map((t) => t.name)).toEqual(['barcelona']);
      expect(document.verses[0]?.xp).toBe('note for barcelona');
      expect(document.reminders.map((r) => r.title)).toEqual(['remind barcelona']);

      // The whole document, in case anything leaked by another route.
      expect(raw).not.toContain('lisbon');
      expect(raw).not.toContain(theirs.userId);
    });

    it('is downloadable only by the person it belongs to', async () => {
      const mine = await signUp('owner@example.com');
      const other = await signUp('nosy@example.com');
      await populate(mine.token, 'barcelona');

      const { id } = (await (await request(mine.token)).json()) as { id: string };
      await buildExport(id, new Date());

      const download = (token: string) =>
        handleDownloadExport(
          new Request('https://agnte.test/v1/privacy/export/download', {
            headers: bearer(token),
          }),
        );

      const ours = await download(mine.token);
      expect(ours.status).toBe(200);
      expect(ours.headers.get('content-disposition')).toContain('agnte-export.json');
      expect(await ours.text()).toContain('note for barcelona');

      // The other account has no export of its own, and cannot reach this one:
      // the row is looked up by the authenticated user, so there is no id to
      // guess and no key to traverse.
      const theirs = await download(other.token);
      expect(theirs.status).toBe(404);

      expect(
        (
          await handleDownloadExport(
            new Request('https://agnte.test/v1/privacy/export/download'),
          )
        ).status,
      ).toBe(401);
    });

    /**
     * Cloud Tasks is at-least-once, so a second delivery must not rebuild: it
     * would bill a second set of signed URLs and overwrite a link someone may
     * already be using.
     */
    it('does nothing on a duplicate delivery', async () => {
      const { token } = await signUp('twice@example.com');
      const { id } = (await (await request(token)).json()) as { id: string };

      expect(await buildExport(id, new Date())).toBe(true);
      expect(await buildExport(id, new Date())).toBe(false);
    });
  });
});
