import { createECDH } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { isHealthy, runChecks, type CheckResult } from '@/shared/infra/checks';
import { resetConfigForTests } from '@/shared/infra/config';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetConfigForTests();
});

const result = (status: CheckResult['status']): CheckResult => ({
  name: 'x',
  status,
  detail: '',
  durationMs: 0,
});

describe('runChecks', () => {
  it('reports every dependency separately', async () => {
    const results = await runChecks();

    expect(results.map((r) => r.name)).toEqual([
      'runtime',
      'database',
      'object-storage',
      'email',
      'access-tokens',
      'google-sign-in',
      'backups',
      'place-suggestions',
      'web-push',
      'deferred-jobs',
    ]);
    expect(results.every((r) => typeof r.durationMs === 'number')).toBe(true);
  });

  it('reports the runtime as healthy', async () => {
    const results = await runChecks();
    expect(results.find((r) => r.name === 'runtime')?.status).toBe('ok');
  });

  /**
   * The check that exists because its absence hid a day-long outage: every
   * upload's thumbnail silently never generated while this endpoint reported
   * every other dependency ok. Locally the in-process queue really does run
   * the job, so `ok` here is the truth rather than a pass given for free.
   */
  it('reports the local in-process queue as a working pipeline', async () => {
    const results = await runChecks();
    const jobs = results.find((r) => r.name === 'deferred-jobs');

    expect(jobs?.status).toBe('ok');
    expect(jobs?.detail).toBe('in-process queue');
  });

  /**
   * The branch that matters, and the one the local case above cannot reach:
   * deployed, with the Cloud Tasks configuration absent. This is the exact
   * state production sat in for a day — and it must name what is missing,
   * because "not configured" without the variable's name is another round of
   * the same guessing.
   */
  it('names the missing configuration when deployed without Cloud Tasks', async () => {
    process.env.APP_ENV = 'production';
    process.env.JWT_SECRET = 'a'.repeat(64);
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GCP_REGION;
    delete process.env.INTERNAL_TASKS_SECRET;
    resetConfigForTests();

    const jobs = (await runChecks()).find((r) => r.name === 'deferred-jobs');

    expect(jobs?.status).toBe('not-configured');
    expect(jobs?.detail).toContain('thumbnails will not generate');
    expect(jobs?.detail).toContain('GCP_PROJECT_ID');
    expect(jobs?.detail).toContain('INTERNAL_TASKS_SECRET');
  });
  /**
   * The state production is in whenever the key has not been mounted — and the
   * one worth naming, because the client swallows the failure by design and
   * the field just quietly stays plain text.
   */
  it('names the variable when place suggestions are switched off', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    resetConfigForTests();

    const places = (await runChecks()).find((r) => r.name === 'place-suggestions');

    expect(places?.status).toBe('not-configured');
    expect(places?.detail).toContain('GOOGLE_PLACES_API_KEY');
  });

  /**
   * Deliberately asserts that the check does *not* prove suggestions work: a
   * mounted key Google rejects still reads ok here, and saying so in a test is
   * what stops the next person treating this as an end-to-end signal.
   */
  it('reports a mounted key without spending money to prove it works', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'a-key';
    resetConfigForTests();

    const places = (await runChecks()).find((r) => r.name === 'place-suggestions');

    expect(places?.status).toBe('ok');
    expect(places?.detail).toContain('not called');
  });

  it('does not check backups outside production', async () => {
    const backups = (await runChecks()).find((r) => r.name === 'backups');

    // A preview has no backups by design, and R2 is not even reachable from a
    // local run. Reporting red everywhere would teach someone to ignore the row
    // that exists precisely to be noticed.
    expect(backups?.status).toBe('not-configured');
    expect(backups?.detail).toContain('production only');
  });
});

describe('the web-push check', () => {
  const keypair = () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const raw = ecdh.getPrivateKey();
    const d =
      raw.length === 32 ? raw : Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
    return {
      publicKey: ecdh.getPublicKey().toString('base64url'),
      privateKey: d.toString('base64url'),
    };
  };

  const webPush = async () => (await runChecks()).find((r) => r.name === 'web-push');

  it('reports email-only when no keypair is configured', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    resetConfigForTests();

    const check = await webPush();

    expect(check?.status).toBe('not-configured');
    expect(check?.detail).toContain('email');
  });

  it('reports a matching keypair as ok', async () => {
    const keys = keypair();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:ops@agnte.app';
    resetConfigForTests();

    const check = await webPush();

    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('mailto:ops@agnte.app');
  });

  /**
   * Two of three is the state the application treats as no push at all, and
   * silently emails instead. The check has to name the missing one, because
   * nothing else in the system will.
   */
  it('names the variable that is missing when only some are set', async () => {
    const keys = keypair();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    delete process.env.VAPID_SUBJECT;
    resetConfigForTests();

    const check = await webPush();

    expect(check?.status).toBe('stale');
    expect(check?.detail).toContain('VAPID_SUBJECT');
  });

  /**
   * The one this check exists for. Rotating one half and not the other signs
   * every push with a key the browser's subscription does not name; the push
   * service answers 403 and explains nothing, so it reads as a bug in the
   * encryption rather than a mismatched pair.
   */
  it('catches a public key that does not belong to the private key', async () => {
    process.env.VAPID_PUBLIC_KEY = keypair().publicKey;
    process.env.VAPID_PRIVATE_KEY = keypair().privateKey;
    process.env.VAPID_SUBJECT = 'mailto:ops@agnte.app';
    resetConfigForTests();

    const check = await webPush();

    expect(check?.status).toBe('stale');
    expect(check?.detail).toContain('does not belong');
  });

  /**
   * Garbage that happens to be a *valid* scalar reports as a mismatch rather
   * than as malformed, because that is what it is: `setPrivateKey` accepts any
   * number below the curve order, so a truncated or mistyped key derives a
   * perfectly good public point that is simply the wrong one. Asserted so the
   * wording of the two branches does not get swapped later.
   */
  it('reports a mistyped private key as a mismatch', async () => {
    process.env.VAPID_PUBLIC_KEY = keypair().publicKey;
    process.env.VAPID_PRIVATE_KEY = 'not-a-key';
    process.env.VAPID_SUBJECT = 'mailto:ops@agnte.app';
    resetConfigForTests();

    const check = await webPush();

    expect(check?.status).toBe('stale');
    expect(check?.detail).toContain('does not belong');
  });

  /** A scalar outside the curve order is the case that actually throws. */
  it('survives a private key the curve rejects outright', async () => {
    process.env.VAPID_PUBLIC_KEY = keypair().publicKey;
    process.env.VAPID_PRIVATE_KEY = Buffer.alloc(32, 0xff).toString('base64url');
    process.env.VAPID_SUBJECT = 'mailto:ops@agnte.app';
    resetConfigForTests();

    const check = await webPush();

    expect(check?.status).toBe('stale');
    expect(check?.detail).toContain('P-256');
  });

  /**
   * A broken keypair must not stop a deploy: it is fixed by re-running
   * ./infra/set-secrets.sh, not by shipping code, so a fatal status would
   * wedge the pipeline for every unrelated change.
   */
  it('never blocks a deploy, however broken it is', async () => {
    process.env.VAPID_PUBLIC_KEY = keypair().publicKey;
    process.env.VAPID_PRIVATE_KEY = keypair().privateKey;
    process.env.VAPID_SUBJECT = 'mailto:ops@agnte.app';
    resetConfigForTests();

    expect(isHealthy(await runChecks())).toBe(true);
  });
});

describe('isHealthy', () => {
  it('treats a not-yet-wired dependency as healthy', () => {
    expect(isHealthy([result('ok'), result('not-configured')])).toBe(true);
  });

  /**
   * The reason `stale` is its own status rather than `failed`.
   *
   * The production deploy's smoke test gates promotion on this endpoint
   * reporting ok. If a backup that had not run marked the app unhealthy, the
   * deploy carrying the fix for it would be the one thing that could not ship —
   * the same trap the email check documents. Red on the status page, not red in
   * the pipeline.
   */
  it('does not let a stale backup block a deploy', () => {
    expect(isHealthy([result('ok'), result('stale')])).toBe(true);
  });

  it('treats a broken dependency as unhealthy', () => {
    expect(isHealthy([result('ok'), result('failed')])).toBe(false);
  });
});
