import { DomainError, systemClock } from '@/shared/kernel';
import {
  claim,
  complete,
  fingerprint,
  release,
  scopeFor,
} from '@/shared/infra/idempotency';
import { jsonError } from '@/shared/infra/http';

/**
 * The Idempotency-Key dance, once (architecture.md §6).
 *
 * Every write endpoint needs the same five-branch handling — proceed, replay,
 * in-progress, mismatch, and releasing the claim when the work throws — and
 * identity spells it out inline in each route. Repeating that across the
 * verse module's writes would be four more chances to get the *release* branch
 * wrong, which is the one that matters: a claim left behind after a crash makes
 * every retry answer "in progress" forever.
 *
 * The handler returns a status and a body rather than a Response so this can
 * store what it needs to replay. A Response's body is a stream that can only be
 * read once, so recording it would consume it.
 */
export interface IdempotentResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export async function idempotently(
  request: Request,
  input: { userId: string; path: string; body: unknown },
  work: () => Promise<IdempotentResult>,
): Promise<Response> {
  const key = request.headers.get('idempotency-key');

  // No key is a valid choice — a client that does not retry does not need one.
  // Requiring it would break the simplest possible caller for no gain.
  if (!key) return respond(await work());

  const scope = scopeFor(input.userId, 'unused');
  const print = fingerprint(request.method, input.path, input.body);

  const outcome = await claim(scope, key, print, systemClock);

  if (outcome.kind === 'replay') {
    return Response.json(outcome.body, {
      status: outcome.status,
      headers: { 'cache-control': 'no-store', 'idempotent-replay': 'true' },
    });
  }

  if (outcome.kind === 'in-progress') {
    return jsonError(
      new DomainError('request_in_progress', 'That request is still being processed.'),
      409,
    );
  }

  if (outcome.kind === 'mismatch') {
    return jsonError(
      new DomainError(
        'idempotency_key_reused',
        'That Idempotency-Key was already used for a different request.',
      ),
      422,
    );
  }

  try {
    const result = await work();

    // Failures are stored too. A 422 is a real, reproducible answer to this
    // exact request; retrying it unchanged should keep giving the same 422
    // rather than starting fresh work.
    await complete(scope, key, result.status, result.body);

    return respond(result);
  } catch (error) {
    // Release rather than leave the key claimed: the work did not happen, so a
    // retry should be allowed to do it rather than be told "in progress"
    // forever.
    await release(scope, key);
    throw error;
  }
}

const respond = (result: IdempotentResult): Response =>
  Response.json(result.body, {
    status: result.status,
    headers: { 'cache-control': 'no-store', ...result.headers },
  });
