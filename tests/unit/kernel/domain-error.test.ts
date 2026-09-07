import { describe, expect, it } from 'vitest';
import { DomainError, isDomainError } from '@/shared/kernel/domain-error';

describe('DomainError', () => {
  it('carries a machine-readable code alongside a human message', () => {
    const error = new DomainError('EMAIL_ALREADY_REGISTERED', 'That email is taken');
    expect(error.code).toBe('EMAIL_ALREADY_REGISTERED');
    expect(error.message).toBe('That email is taken');
  });

  it('is an Error, so it carries a stack if thrown', () => {
    const error = new DomainError('X', 'y');
    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeTruthy();
    expect(error.name).toBe('DomainError');
  });

  it('preserves a cause', () => {
    const cause = new Error('underlying');
    expect(new DomainError('X', 'y', { cause }).cause).toBe(cause);
  });

  it('freezes details, so a caller cannot mutate a logged error', () => {
    const error = new DomainError('X', 'y', { details: { attempts: 3 } });
    expect(() => {
      (error.details as Record<string, unknown>).attempts = 99;
    }).toThrow();
    expect(error.details.attempts).toBe(3);
  });

  it("copies details rather than holding the caller's object", () => {
    const details = { attempts: 1 };
    const error = new DomainError('X', 'y', { details });
    details.attempts = 2;
    expect(error.details.attempts).toBe(1);
  });

  it('serialises to JSON for logs and responses', () => {
    expect(new DomainError('X', 'y', { details: { a: 1 } }).toJSON()).toEqual({
      code: 'X',
      message: 'y',
      details: { a: 1 },
    });
  });

  it('omits empty details from JSON rather than emitting {}', () => {
    expect(new DomainError('X', 'y').toJSON()).toEqual({ code: 'X', message: 'y' });
  });
});

describe('isDomainError', () => {
  it.each([
    ['a plain Error', new Error('x')],
    ['an object that looks like one', { code: 'X', message: 'y' }],
    ['null', null],
    ['a string', 'DomainError'],
  ])('rejects %s', (_label, value) => {
    expect(isDomainError(value)).toBe(false);
  });

  it('accepts a DomainError', () => {
    expect(isDomainError(new DomainError('X', 'y'))).toBe(true);
  });
});
