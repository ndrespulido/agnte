import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '../domain/ports';
import type { RawPassword } from '../domain/password';

/**
 * OWASP's recommended Argon2id baseline: 19 MiB of memory, 2 passes, 1 lane.
 *
 * Memory cost is the parameter that matters — it is what makes GPU and ASIC
 * cracking expensive rather than merely slow, which is the whole reason to
 * prefer Argon2id over PBKDF2.
 *
 * These are not read back when verifying: an Argon2 PHC string carries the
 * parameters it was created with, so raising the cost here re-hashes new
 * passwords while existing ones keep verifying against their old settings.
 */
/**
 * The literal 2 is `Algorithm.Argon2id`. It is spelled out because that enum is
 * an ambient *const* enum, which `verbatimModuleSyntax` refuses to import — a
 * const enum has no runtime object to import, and this project compiles each
 * module in isolation. Asserted against the real enum in the adapter's tests,
 * so a value change upstream fails there rather than silently selecting a
 * different algorithm.
 */
const ARGON2ID = 2;

const PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A syntactically valid hash of a value nobody knows, used to burn the same CPU
 * time on the "no such user" path as on a real verification.
 *
 * Without it, an attacker can tell a registered address from an unregistered
 * one by how fast the login endpoint says no — the real one spends ~40ms
 * hashing, the missing one returns immediately. Generated once at module load
 * rather than checked in, so it cannot be mistaken for a credential.
 */
let decoyHash: Promise<string> | undefined;

const getDecoyHash = (): Promise<string> => {
  decoyHash ??= hash('a password no one has', PARAMS);
  return decoyHash;
};

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: RawPassword): Promise<string> {
    return hash(password, PARAMS);
  }

  /**
   * Returns false rather than throwing on a malformed hash. A stored value we
   * cannot parse means the credential cannot be verified, which is exactly what
   * "false" says; turning it into a 500 would tell an attacker that this
   * particular account's row is unusual.
   */
  async verify(storedHash: string, candidate: string): Promise<boolean> {
    try {
      return await verify(storedHash, candidate, PARAMS);
    } catch {
      return false;
    }
  }

  /**
   * Spend the cost of a verification without having a hash to check, so a
   * caller with no matching user takes the same time as one with a match.
   */
  async burnVerificationTime(): Promise<void> {
    try {
      await verify(await getDecoyHash(), 'not the password', PARAMS);
    } catch {
      // The decoy never matches; nothing here should surface to a caller.
    }
  }
}
