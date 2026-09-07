import type { Clock } from '@/shared/kernel';
import type { Email } from './email';

/**
 * A registration that has been started but not yet proven (architecture.md §4).
 *
 * The account does not exist until the address is verified, and the candidate
 * password lives here rather than on a placeholder user row. That closes an
 * account pre-hijacking hole — see the model comment in prisma/schema.prisma
 * for the attack it prevents.
 *
 * The domain only ever sees the token's *hash*. The token itself exists for the
 * length of one request — long enough to put in an email — and is never stored,
 * logged or returned. There is no `token` field here to accidentally persist.
 */
export interface PendingRegistration {
  readonly tokenHash: string;
  readonly email: Email;
  readonly passwordHash: string;
  readonly displayName: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** 24 hours (architecture.md §4). */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function startRegistration(input: {
  tokenHash: string;
  email: Email;
  passwordHash: string;
  displayName?: string | null;
  clock: Clock;
}): PendingRegistration {
  const now = input.clock.now();
  return {
    tokenHash: input.tokenHash,
    email: input.email,
    passwordHash: input.passwordHash,
    displayName: input.displayName ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS),
  };
}

export const hasExpired = (registration: PendingRegistration, clock: Clock): boolean =>
  registration.expiresAt.getTime() <= clock.now().getTime();
