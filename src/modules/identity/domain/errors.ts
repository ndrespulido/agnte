import { DomainError } from '@/shared/kernel';

/**
 * Identity's error codes.
 *
 * Codes are the contract; messages are for humans and may be reworded freely.
 * A client switching on `code` keeps working when the prose changes, which is
 * the whole reason DomainError carries both (architecture.md §6).
 */
export const IdentityErrorCode = {
  EmailInvalid: 'identity.email_invalid',
  PasswordTooShort: 'identity.password_too_short',
  PasswordTooLong: 'identity.password_too_long',
  VerificationTokenInvalid: 'identity.verification_token_invalid',
  VerificationTokenExpired: 'identity.verification_token_expired',
  VerificationTokenAlreadyUsed: 'identity.verification_token_already_used',
  InvalidCredentials: 'identity.invalid_credentials',
  RefreshTokenInvalid: 'identity.refresh_token_invalid',
  SessionRevoked: 'identity.session_revoked',
  ResetTokenInvalid: 'identity.reset_token_invalid',
  ResetTokenExpired: 'identity.reset_token_expired',
  ResetTokenAlreadyUsed: 'identity.reset_token_already_used',
} as const;

export type IdentityErrorCode =
  (typeof IdentityErrorCode)[keyof typeof IdentityErrorCode];

export const emailInvalid = (reason: string): DomainError =>
  new DomainError(IdentityErrorCode.EmailInvalid, `Email is not valid: ${reason}.`);

export const passwordTooShort = (minimum: number): DomainError =>
  new DomainError(
    IdentityErrorCode.PasswordTooShort,
    `Password must be at least ${minimum} characters.`,
    { details: { minimum } },
  );

export const passwordTooLong = (maximum: number): DomainError =>
  new DomainError(
    IdentityErrorCode.PasswordTooLong,
    `Password must be at most ${maximum} characters.`,
    { details: { maximum } },
  );

export const verificationTokenInvalid = (): DomainError =>
  new DomainError(
    IdentityErrorCode.VerificationTokenInvalid,
    'This verification link is not valid.',
  );

export const verificationTokenExpired = (): DomainError =>
  new DomainError(
    IdentityErrorCode.VerificationTokenExpired,
    'This verification link has expired. Request a new one.',
  );

export const verificationTokenAlreadyUsed = (): DomainError =>
  new DomainError(
    IdentityErrorCode.VerificationTokenAlreadyUsed,
    'This verification link has already been used.',
  );

/**
 * One error for "no such account" and for "wrong password", deliberately.
 *
 * Distinguishing them turns sign-in into an account-enumeration oracle: ask
 * with any password, and a "wrong password" reply confirms the address is
 * registered. The caller also has to spend the same time on both paths — see
 * PasswordHasher.burnVerificationTime — since a response that returns before
 * any hashing happened says the same thing more quietly.
 */
export const invalidCredentials = (): DomainError =>
  new DomainError(
    IdentityErrorCode.InvalidCredentials,
    'Email or password is incorrect.',
  );

export const refreshTokenInvalid = (): DomainError =>
  new DomainError(
    IdentityErrorCode.RefreshTokenInvalid,
    'That session is no longer valid. Sign in again.',
  );

/**
 * Distinct from the above because it is worth surfacing differently: this is
 * what a client sees when its whole family was revoked by reuse detection, and
 * a client that can say "you were signed out for security reasons" is more
 * useful than one that just bounces to a login form.
 */
export const sessionRevoked = (): DomainError =>
  new DomainError(
    IdentityErrorCode.SessionRevoked,
    'This session was ended for security reasons. Sign in again.',
  );

export const resetTokenInvalid = (): DomainError =>
  new DomainError(IdentityErrorCode.ResetTokenInvalid, 'This reset link is not valid.');

export const resetTokenExpired = (): DomainError =>
  new DomainError(
    IdentityErrorCode.ResetTokenExpired,
    'This reset link has expired. Request a new one.',
  );

/**
 * Covers both "already used" and "superseded by a password change".
 *
 * They are the same news to the person holding the link — the password has
 * already moved on without them — and separating them would only tell someone
 * replaying an old link whether the account has changed since.
 */
export const resetTokenAlreadyUsed = (): DomainError =>
  new DomainError(
    IdentityErrorCode.ResetTokenAlreadyUsed,
    'This reset link has already been used. Request a new one if you still need it.',
  );
