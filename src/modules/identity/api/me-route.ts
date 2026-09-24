import { DomainError, systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError } from '@/shared/infra/http';
import { isLocale, LOCALES } from '@/shared/i18n';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import { authenticate } from './authenticate';
import { rateLimitHeaders, tooManyRequests } from './http';

/**
 * The signed-in user.
 *
 * Deliberately narrow: id, email, display name, timestamps. Not the password
 * hash, not the version, not the row. A response shape that starts as "the user
 * record" grows into one by default, and the first field nobody meant to
 * publish arrives without a decision being made.
 */
export async function handleMe(request: Request): Promise<Response> {
  const authenticated = await authenticate(request);
  if (!authenticated.ok) return authenticated.response;

  // §8.6's general authenticated limit: 1000/hour per user. Applied after
  // authentication so the bucket is the user, not the address they came from —
  // a shared network should not have its members competing against each other.
  const decision = await consume('authenticated', { user: authenticated.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const { user } = authenticated;

  return Response.json(
    {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

/**
 * Changes the language this account reads in.
 *
 * On `/v1/me` rather than a settings endpoint of its own, because it is a
 * field of the user and this is the user. A PATCH so it stays a partial
 * update: the day a display name becomes editable, it joins this body instead
 * of arriving as a second route.
 *
 * **No `expectedVersion`, unlike every other write in this codebase.** That is
 * deliberate and narrow. Optimistic concurrency exists so a stale write cannot
 * silently discard someone's change (architecture.md §2); here the two racing
 * writes are the same person on two devices, the field is a preference with no
 * prior state to lose, and "last one wins" is what they would ask for. A 409
 * would mean telling somebody their language could not be changed because they
 * had already changed it — which is not a conflict worth reporting.
 *
 * The browser keeps its own copy in localStorage and does not wait for this:
 * the language switches on tap, and this call is what makes the choice follow
 * them to another device and into their reminder emails.
 */
export async function handleUpdateMe(request: Request): Promise<Response> {
  const authenticated = await authenticate(request);
  if (!authenticated.ok) return authenticated.response;

  const decision = await consume('authenticated', { user: authenticated.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const body: unknown = await request.json().catch(() => null);
  const locale = (body as { locale?: unknown } | null)?.locale;

  /*
   * Validated against the locales this build actually has a string table for,
   * not merely "is a string". An unchecked value would be written to the row
   * and read back by the email sender, where it would silently fall through to
   * English for the rest of that account's life — a setting that appears to
   * save and does nothing.
   */
  if (!isLocale(locale)) {
    return jsonError(
      new DomainError(
        'bad_request',
        `locale must be one of: ${LOCALES.map((l) => l.code).join(', ')}.`,
      ),
      400,
      rateLimitHeaders(decision),
    );
  }

  await new PrismaUserRepository().updateLocale({
    userId: authenticated.userId,
    locale,
    now: systemClock.now(),
  });

  return Response.json(
    { locale },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}
