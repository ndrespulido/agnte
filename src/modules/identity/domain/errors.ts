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
