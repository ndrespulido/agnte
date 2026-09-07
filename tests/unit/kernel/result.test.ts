import { describe, expect, it } from 'vitest';
import {
  all,
  andThen,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unwrap,
  unwrapOr,
} from '@/shared/kernel/result';

describe('construction and narrowing', () => {
  it('narrows to the value on success', () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('narrows to the error on failure', () => {
    const result = err('boom');
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toBe('boom');
  });

  it('treats a falsy success value as a success', () => {
    // The discriminant is `ok`, not truthiness — ok(0) and ok(null) are wins.
    expect(isOk(ok(0))).toBe(true);
    expect(isOk(ok(null))).toBe(true);
    expect(isOk(ok(false))).toBe(true);
  });
});

describe('map / mapErr', () => {
  it('map transforms a success', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
  });

  it('map leaves a failure untouched and does not call the function', () => {
    let called = false;
    const result = map(err('bad'), () => {
      called = true;
      return 1;
    });
    expect(result).toEqual(err('bad'));
    expect(called).toBe(false);
  });

  it('mapErr transforms a failure', () => {
    expect(mapErr(err('bad'), (e) => `${e}!`)).toEqual(err('bad!'));
  });

  it('mapErr leaves a success untouched', () => {
    expect(mapErr(ok(1), () => 'x')).toEqual(ok(1));
  });
});

describe('andThen', () => {
  const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err('odd'));

  it('chains through successes', () => {
    expect(andThen(ok(8), half)).toEqual(ok(4));
  });

  it('short-circuits on the first failure', () => {
    expect(andThen(err<string>('earlier'), half)).toEqual(err('earlier'));
  });

  it('surfaces a failure from the chained step', () => {
    expect(andThen(ok(7), half)).toEqual(err('odd'));
  });
});

describe('unwrapOr / unwrap', () => {
  it('unwrapOr returns the value on success', () => {
    expect(unwrapOr(ok(1), 99)).toBe(1);
  });

  it('unwrapOr returns the fallback on failure', () => {
    expect(unwrapOr(err('x'), 99)).toBe(99);
  });

  it('unwrap throws on failure rather than returning undefined', () => {
    expect(() => unwrap(err({ code: 'NOPE' }))).toThrowError(/NOPE/);
  });
});

describe('all', () => {
  it('collects every value when all succeed', () => {
    expect(all([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
  });

  it('returns the first failure', () => {
    expect(all([ok(1), err('first'), err('second')])).toEqual(err('first'));
  });

  it('an empty list succeeds with nothing', () => {
    expect(all([])).toEqual(ok([]));
  });
});
