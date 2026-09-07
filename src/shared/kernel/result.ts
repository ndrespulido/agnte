/**
 * A value that is either a success or a failure.
 *
 * Domain operations return this instead of throwing. An expected failure — an
 * email already registered, a token expired — is a value the caller must
 * handle, and TypeScript will not let it be ignored. Exceptions stay for the
 * genuinely exceptional: a database that is unreachable, a bug.
 *
 * The discriminant is `ok`, so narrowing works without a helper:
 *
 *   const result = register(input);
 *   if (!result.ok) return respondWith(result.error);
 *   use(result.value);
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;

/** Transforms the success value, leaving a failure untouched. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Transforms the failure, leaving a success untouched. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Chains an operation that can itself fail, so a sequence of fallible steps
 * reads as a pipeline rather than a ladder of early returns.
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** The success value, or a fallback. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * The success value, or throws.
 *
 * For code that has already established the result is a success — a test, or a
 * branch guarded by isOk. Using it to avoid handling a failure defeats the
 * point of Result.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(`Called unwrap on a failure: ${JSON.stringify(result.error)}`);
}

/**
 * Collects many results into one. Fails on the first failure, which is what
 * validation wants: the caller gets every value or the first reason it could
 * not have them.
 */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
