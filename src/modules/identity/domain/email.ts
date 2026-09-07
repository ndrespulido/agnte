import { err, ok, type DomainError, type Result } from '@/shared/kernel';
import { emailInvalid } from './errors';

/**
 * A validated, normalised email address.
 *
 * Branded rather than a bare string so a function that requires a *parsed*
 * address cannot be handed raw user input by mistake — the compiler asks you to
 * go through `parseEmail` first.
 */
export type Email = string & { readonly __brand: 'Email' };

/** RFC 5321 §4.5.3.1.3 caps the whole address (path) at 256 octets, of which two are angle brackets. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately loose: something, an @, something, a dot, something — with no
 * spaces and exactly one @.
 *
 * Validating email properly means implementing RFC 5322, and the famous
 * "correct" regex is several kilobytes that still rejects addresses that work
 * and accepts ones that do not. The only real proof that an address exists and
 * belongs to the person typing it is that mail sent to it arrives — which is
 * exactly what the verification token is for. So this rejects obvious typos
 * and leaves the actual proof to the mechanism designed for it.
 */
const SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Normalise, then validate.
 *
 * Normalisation is trim + lowercase and stops there. It is tempting to go
 * further — strip dots and +tags the way Gmail does — but that is a
 * provider-specific rule applied to every provider, and it silently merges
 * addresses their owners consider distinct. Two people using
 * `team+billing@` and `team+ops@` at a provider that does not treat those as
 * equal would be told the address is taken.
 */
export function parseEmail(input: string): Result<Email, DomainError> {
  const normalised = input.trim().toLowerCase();

  if (normalised.length === 0) return err(emailInvalid('it is empty'));
  if (normalised.length > MAX_EMAIL_LENGTH) {
    return err(emailInvalid(`it is longer than ${MAX_EMAIL_LENGTH} characters`));
  }
  if (!SHAPE.test(normalised))
    return err(emailInvalid('it is not shaped like an address'));

  return ok(normalised as Email);
}
