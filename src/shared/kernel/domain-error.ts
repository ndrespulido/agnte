/**
 * A failure the domain understands and names.
 *
 * `code` is the stable, machine-readable identity — `EMAIL_ALREADY_REGISTERED`,
 * not "That email is taken". The API layer maps codes to HTTP statuses and the
 * client maps them to messages; neither parses prose. That mapping lives at the
 * edge, because a status code is a transport concern and the domain has no
 * business knowing about HTTP.
 *
 * It extends Error so it carries a stack when something does go wrong
 * unexpectedly, but it is normally returned inside a Result rather than thrown.
 */
export class DomainError extends Error {
  readonly code: string;

  /**
   * Context for logs and for the client — never anything secret. Structured
   * logging redacts by allowlist (architecture.md §8.7), and details that
   * travel to the client must assume the client is hostile.
   */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.details = Object.freeze({ ...options.details });
  }

  /** Serialisable form, for logs and API responses. */
  toJSON(): { code: string; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(Object.keys(this.details).length > 0 ? { details: { ...this.details } } : {}),
    };
  }
}

export const isDomainError = (value: unknown): value is DomainError =>
  value instanceof DomainError;
