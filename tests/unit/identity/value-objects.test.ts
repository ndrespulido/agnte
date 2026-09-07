import { describe, expect, it } from 'vitest';
import { MAX_EMAIL_LENGTH, parseEmail } from '@/modules/identity/domain/email';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  parsePassword,
} from '@/modules/identity/domain/password';
import { IdentityErrorCode } from '@/modules/identity/domain/errors';

const value = <T>(result: { ok: boolean; value?: T }): T => {
  if (!result.ok) throw new Error('expected ok');
  return result.value as T;
};
const code = (result: { ok: boolean; error?: { code: string } }): string => {
  if (result.ok) throw new Error('expected err');
  return result.error?.code ?? '';
};

describe('parseEmail', () => {
  it('normalises case and surrounding whitespace', () => {
    expect(value(parseEmail('  Andres@Example.COM  '))).toBe('andres@example.com');
  });

  it('keeps plus tags and dots, which providers do not all treat as equal', () => {
    expect(value(parseEmail('a.b+billing@example.com'))).toBe('a.b+billing@example.com');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['no at sign', 'nope'],
    ['no domain dot', 'a@localhost'],
    ['two at signs', 'a@b@c.com'],
    ['internal space', 'a b@example.com'],
  ])('rejects %s', (_label, input) => {
    expect(code(parseEmail(input))).toBe(IdentityErrorCode.EmailInvalid);
  });

  it(`rejects an address longer than ${MAX_EMAIL_LENGTH} characters`, () => {
    const long = `${'a'.repeat(MAX_EMAIL_LENGTH)}@example.com`;
    expect(code(parseEmail(long))).toBe(IdentityErrorCode.EmailInvalid);
  });

  it('accepts an address exactly at the limit', () => {
    const local = 'a'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length);
    expect(value(parseEmail(`${local}@example.com`))).toHaveLength(MAX_EMAIL_LENGTH);
  });
});

describe('parsePassword', () => {
  it('accepts a passphrase at the minimum length', () => {
    const at = 'x'.repeat(MIN_PASSWORD_LENGTH);
    expect(value(parsePassword(at))).toBe(at);
  });

  it('rejects one character short', () => {
    expect(code(parsePassword('x'.repeat(MIN_PASSWORD_LENGTH - 1)))).toBe(
      IdentityErrorCode.PasswordTooShort,
    );
  });

  it('rejects one character over the maximum', () => {
    expect(code(parsePassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)))).toBe(
      IdentityErrorCode.PasswordTooLong,
    );
  });

  it('does not trim, because a trailing space is a real character', () => {
    // Trimming here would accept a password at registration and then reject the
    // same keystrokes at login.
    const padded = `${'x'.repeat(MIN_PASSWORD_LENGTH)} `;
    expect(value(parsePassword(padded))).toBe(padded);
  });

  it('counts code points, so an emoji passphrase is not penalised twice', () => {
    // 12 astral-plane characters are 24 UTF-16 units. Measuring the wrong one
    // would accept this while rejecting 12 latin letters, or vice versa.
    const emoji = '😀'.repeat(MIN_PASSWORD_LENGTH);
    expect(emoji.length).toBe(MIN_PASSWORD_LENGTH * 2);
    expect(value(parsePassword(emoji))).toBe(emoji);
  });

  it('imposes no composition rules (NIST SP 800-63B)', () => {
    expect(value(parsePassword('all lower case words'))).toBeTruthy();
  });
});
