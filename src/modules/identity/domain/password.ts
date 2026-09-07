import { err, ok, type DomainError, type Result } from '@/shared/kernel';
import { passwordTooLong, passwordTooShort } from './errors';

/**
 * A password that has passed policy, before hashing. Branded so it cannot be
 * confused with a stored hash — the two are both strings and swapping them
 * would be catastrophic and silent.
 */
export type RawPassword = string & { readonly __brand: 'RawPassword' };

/**
 * NIST SP 800-63B rev 4 deprecates composition rules (one upper, one digit, a
 * symbol): they push people towards `Password1!`, which is weaker than three
 * random words and much harder to remember. Length is what actually buys
 * entropy, so length is the only rule here.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Not a KDF limit — Argon2id absorbs any input length, unlike bcrypt which
 * truncates at 72 bytes. This is a sanity bound so a megabyte of "password"
 * cannot be pushed through the request body and into memory.
 */
export const MAX_PASSWORD_LENGTH = 256;

export function parsePassword(input: string): Result<RawPassword, DomainError> {
  // Code points, not UTF-16 units: a passphrase of emoji or CJK characters
  // should not count double against a length limit meant to measure effort.
  // Deliberately not trimmed — a leading or trailing space is a legitimate
  // character in a password, and silently removing it would make a password
  // that was accepted at registration fail at login.
  const length = [...input].length;

  if (length < MIN_PASSWORD_LENGTH) return err(passwordTooShort(MIN_PASSWORD_LENGTH));
  if (length > MAX_PASSWORD_LENGTH) return err(passwordTooLong(MAX_PASSWORD_LENGTH));

  return ok(input as RawPassword);
}
