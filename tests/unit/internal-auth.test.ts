import { afterEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import { verifyInternalRequest } from '@/shared/infra/internal-auth';

/**
 * The one check that keeps `/internal/*` private on a service deployed with
 * `--allow-unauthenticated`. Getting this wrong in either direction matters: a
 * false accept lets anyone trigger deferred work (or worse, whatever a future
 * `/internal/*` route does with less care than this one), and a false reject
 * on a legitimate Cloud Tasks callback means deferred work silently never
 * completes.
 */

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'a'.repeat(32);

const request = (headers: Record<string, string> = {}) =>
  new Request('https://agnte.test/internal/media/thumbnail', { headers });

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetConfigForTests();
});

describe('verifyInternalRequest', () => {
  it('accepts the configured secret', () => {
    process.env.INTERNAL_TASKS_SECRET = SECRET;
    resetConfigForTests();

    const result = verifyInternalRequest(request({ authorization: `Bearer ${SECRET}` }));
    expect(result.ok).toBe(true);
  });

  it('refuses a missing Authorization header', () => {
    process.env.INTERNAL_TASKS_SECRET = SECRET;
    resetConfigForTests();

    const result = verifyInternalRequest(request());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.status).toBe(401);
  });

  it('refuses the wrong secret', () => {
    process.env.INTERNAL_TASKS_SECRET = SECRET;
    resetConfigForTests();

    const result = verifyInternalRequest(
      request({ authorization: `Bearer ${'b'.repeat(32)}` }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.status).toBe(401);
  });

  it('refuses a secret that is merely a prefix or suffix of the real one', () => {
    // The case a naive .startsWith or .includes check would get wrong.
    process.env.INTERNAL_TASKS_SECRET = SECRET;
    resetConfigForTests();

    expect(
      verifyInternalRequest(request({ authorization: `Bearer ${SECRET.slice(0, 16)}` }))
        .ok,
    ).toBe(false);
    expect(
      verifyInternalRequest(request({ authorization: `Bearer ${SECRET}extra` })).ok,
    ).toBe(false);
  });

  it('rejects a malformed Authorization scheme', () => {
    process.env.INTERNAL_TASKS_SECRET = SECRET;
    resetConfigForTests();

    for (const header of [`Basic ${SECRET}`, SECRET, `bearer${SECRET}`, 'Bearer ']) {
      expect(verifyInternalRequest(request({ authorization: header })).ok).toBe(false);
    }
  });

  it('answers 503, not 401, when nothing is configured', () => {
    // Distinguishing "not deployed with this feature" from "wrong credential"
    // is the same reasoning identity's access-token check applies to a
    // missing JWT_SECRET: a 503 says "come back later", a 401 says "you got
    // something wrong", and those are different messages for a caller.
    delete process.env.INTERNAL_TASKS_SECRET;
    resetConfigForTests();

    const result = verifyInternalRequest(request({ authorization: `Bearer ${SECRET}` }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.status).toBe(503);
  });
});
