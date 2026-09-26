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
export interface Contact {
  readonly email: string;
  /**
   * The language to write to them in.
   *
   * Why it is stored rather than read from a request: the caller that needs it
   * most is the nightly reminder tick, which runs from a Cloud Scheduler
   * callback with no browser and no `Accept-Language` to consult. Without a
   * stored preference every scheduled email would be in English regardless of
   * what the person had chosen on screen.
   *
   * A raw string, resolved against the string tables by the caller. Identity
   * has no list of supported languages and should not grow one — that list
   * changes whenever a translation is added, and this module would have no way
   * to know.
   */
  readonly locale: string;
}

export async function contactFor(userId: string): Promise<Contact | null> {
  const user = await new PrismaUserRepository().findById(userId);
  return user ? { email: user.email, locale: user.locale } : null;
}

/** Just the address, for a caller with nothing to say in a language. */
export async function contactEmailFor(userId: string): Promise<string | null> {
  return (await contactFor(userId))?.email ?? null;
}
