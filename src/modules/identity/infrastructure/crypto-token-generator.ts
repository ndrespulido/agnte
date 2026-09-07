import { createHash, randomBytes } from 'node:crypto';
import type { IssuedToken, VerificationTokenGenerator } from '../domain/ports';

/** 256 bits. Guessing one is not a threat model, it is a fantasy. */
const TOKEN_BYTES = 32;

/**
 * base64url, so the token drops straight into a URL with no escaping — and no
 * chance of a mail client mangling a `+` into a space and breaking the link.
 */
const encode = (bytes: Buffer): string => bytes.toString('base64url');

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * One generator for every single-use secret identity hands out: email
 * verification, refresh tokens, password reset.
 *
 * They are the same thing — 256 bits from a CSPRNG, stored as a SHA-256 hash,
 * looked up by value — and giving each its own class would have been three
 * copies of the same twelve lines, with three chances to get one of them
 * subtly wrong. The *policies* differ (lifetime, single-use rules, what
 * revocation means) and those live with each use case, where they can be read.
 */
export class CryptoTokenGenerator implements VerificationTokenGenerator {
  issue(): IssuedToken {
    const token = encode(randomBytes(TOKEN_BYTES));
    return { token, tokenHash: sha256Hex(token) };
  }

  hashOf(token: string): string {
    return sha256Hex(token);
  }
}
