import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';

/**
 * Where to reach a user, for another module that needs to send them something.
 *
 * Deliberately this narrow. The notifications module needs an address to fall
 * back to when push is unavailable (§8.4), and the alternative — exporting the
 * user repository, or the `User` aggregate itself — would hand every other
 * module the password hash, the verification state and the OAuth linkage along
 * with it. A module that can reach a repository can read rows nobody decided it
 * should see, which is the same argument verse's index.ts makes for exporting
 * its visibility resolver and no repository at all.
 *
 * Null for a user who does not exist, which a caller should treat as "nothing
 * to send" rather than as an error: a reminder outliving its owner by a few
 * seconds is an ordinary race with account deletion, not a fault.
 */
export async function contactEmailFor(userId: string): Promise<string | null> {
  const user = await new PrismaUserRepository().findById(userId);
  return user?.email ?? null;
}
