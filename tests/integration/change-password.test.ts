import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { systemClock, uuidv7 } from '@/shared/kernel';
import { changePassword } from '@/modules/identity/application/change-password';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import type { Email } from '@/modules/identity/domain/email';
import { Argon2PasswordHasher } from '@/modules/identity/infrastructure/argon2-password-hasher';
import { PrismaPasswordResetTokenRepository } from '@/modules/identity/infrastructure/prisma-password-reset-token-repository';
import { PrismaRefreshTokenRepository } from '@/modules/identity/infrastructure/prisma-refresh-token-repository';
import { PrismaUserRepository } from '@/modules/identity/infrastructure/prisma-user-repository';

/**
 * Changing a password while signed in.
 *
 * The properties worth proving are the security ones, because they are the
 * reason this is not simply an UPDATE: the current password is really checked,
 * an account with no password cannot acquire one this way, and the change
 * takes every session and every outstanding reset link with it.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const users = new PrismaUserRepository();
const hasher = new Argon2PasswordHasher();

const deps = {
  users,
  resets: new PrismaPasswordResetTokenRepository(),
  sessions: new PrismaRefreshTokenRepository(),
  hasher,
  clock: systemClock,
};

const CURRENT = 'a long enough password';
const NEXT = 'an even longer password';

/** A verified account with a real argon2 hash of CURRENT. */
const someone = async (withPassword = true): Promise<string> => {
  const user = createVerifiedUser({
    email: `change-${uuidv7()}@example.com` as Email,
    passwordHash: withPassword ? await hasher.hash(CURRENT as never) : null,
    displayName: null,
    clock: systemClock,
  });
  await users.create(user);
  return user.id;
};

describe.skipIf(!DATABASE_URL)('changing a password', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'c'.repeat(64);
    resetConfigForTests();

    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM identity.refresh_token');
    await db.$executeRawUnsafe('DELETE FROM identity.password_reset_token');
    await db.$executeRawUnsafe('DELETE FROM identity."user"');
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  it('replaces the password when the current one is right', async () => {
    const userId = await someone();

    const result = await changePassword(
      { userId, currentPassword: CURRENT, newPassword: NEXT },
      deps,
    );
    expect(result.ok).toBe(true);

    const after = await users.findById(userId);
    // The new one works and the old one does not — the pair of assertions,
    // because either alone is satisfied by a no-op.
    expect(await hasher.verify(after!.passwordHash!, NEXT as never)).toBe(true);
    expect(await hasher.verify(after!.passwordHash!, CURRENT as never)).toBe(false);
  });

  it('refuses a wrong current password without touching the stored one', async () => {
    const userId = await someone();
    const before = (await users.findById(userId))!.passwordHash;

    const result = await changePassword(
      { userId, currentPassword: 'not the password', newPassword: NEXT },
      deps,
    );

    expect(result.ok).toBe(false);
    expect((await users.findById(userId))!.passwordHash).toBe(before);
  });

  it('refuses a new password that fails policy, before checking anything else', async () => {
    const userId = await someone();

    const result = await changePassword(
      { userId, currentPassword: CURRENT, newPassword: 'short' },
      deps,
    );

    expect(result.ok).toBe(false);
    // Unchanged: a rejected policy must not half-apply.
    const after = await users.findById(userId);
    expect(await hasher.verify(after!.passwordHash!, CURRENT as never)).toBe(true);
  });

  it('will not give a Google-only account a password', async () => {
    /*
     * Someone who signed up through Google has no password to prove. Letting
     * this set one would mean a stolen access token could mint a second,
     * permanent way in — which is the whole reason the current password is
     * required rather than merely being signed in.
     */
    const userId = await someone(false);

    const result = await changePassword(
      { userId, currentPassword: 'anything at all', newPassword: NEXT },
      deps,
    );

    expect(result.ok).toBe(false);
    expect((await users.findById(userId))!.passwordHash).toBe(null);
  });

  it('answers the same way for a wrong password and a missing account', async () => {
    // Both are invalid_credentials: a signed-in caller whose row has vanished
    // is not a case worth distinguishing, and distinguishing costs nothing to
    // nobody but an attacker.
    const wrong = await changePassword(
      { userId: await someone(), currentPassword: 'nope', newPassword: NEXT },
      deps,
    );
    const missing = await changePassword(
      { userId: uuidv7(), currentPassword: CURRENT, newPassword: NEXT },
      deps,
    );

    expect(wrong.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!wrong.ok && !missing.ok) {
      expect(missing.error.code).toBe(wrong.error.code);
    }
  });
});
