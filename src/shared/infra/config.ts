import { z } from 'zod';

/**
 * Environment schema.
 *
 * Parsing is lazy and memoised rather than run at module load. `next build`
 * imports every route module to collect routes, and a config that throws at
 * import time would make the build depend on runtime secrets being present —
 * which would break both local development and the CI build step.
 */
const schema = z.object({
  /** Which deployment this process is. Drives adapter selection (architecture.md §7.1). */
  APP_ENV: z.enum(['local', 'preview', 'production']).default('local'),

  /** Commit the image was built from. Injected at build time; see the Dockerfile. */
  GIT_SHA: z.string().default('unknown'),

  /** Neon branch this process is talking to. Set by the preview deploy workflow. */
  NEON_BRANCH: z.string().optional(),

  /** Human label for a preview environment, e.g. "pr-12". */
  PREVIEW_LABEL: z.string().optional(),

  /**
   * Cloudflare R2 (architecture.md §7.1). All four are required together —
   * see the refinement below. Unset means the filesystem adapter locally, and
   * no object storage at all in a deployed environment.
   */
  R2_ENDPOINT: z.url().optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  /**
   * Key prefix, so preview environments share one bucket instead of creating
   * one per pull request. A lifecycle rule expires these.
   */
  R2_PREFIX: z.string().default(''),

  /**
   * Resend (architecture.md §3). Both are required together — see the
   * refinement below. Unset means the console transport locally, and no email
   * at all in a deployed environment.
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),

  /**
   * Origin used to build links that go into emails, e.g.
   * "https://agnte.example.com".
   *
   * When unset the origin is taken from the incoming request. That is
   * convenient — a preview URL needs no configuration — but it means a request
   * carrying a forged Host header would produce a verification link pointing at
   * the attacker's domain, with the victim's token in it. So it is derived only
   * as a fallback, and production sets it explicitly.
   */
  APP_BASE_URL: z.url().optional(),
});

/**
 * Partial R2 configuration is always a mistake — three of four variables set
 * would silently fall back to no object storage at all, which in production
 * reads as "not configured yet" rather than "someone dropped a secret".
 */
const R2_KEYS = [
  'R2_ENDPOINT',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

/** Same reasoning as R2: half-configured email is a dropped secret, not a choice. */
const EMAIL_KEYS = ['RESEND_API_KEY', 'EMAIL_FROM'] as const;

const schemaWithChecks = schema.superRefine((value, ctx) => {
  const present = R2_KEYS.filter((key) => value[key] !== undefined);
  if (present.length > 0 && present.length < R2_KEYS.length) {
    const missing = R2_KEYS.filter((key) => value[key] === undefined);
    ctx.addIssue({
      code: 'custom',
      path: [missing[0] ?? 'R2_ENDPOINT'],
      message: `R2 is partially configured. Missing: ${missing.join(', ')}`,
    });
  }

  const emailPresent = EMAIL_KEYS.filter((key) => value[key] !== undefined);
  if (emailPresent.length > 0 && emailPresent.length < EMAIL_KEYS.length) {
    const missing = EMAIL_KEYS.filter((key) => value[key] === undefined);
    ctx.addIssue({
      code: 'custom',
      path: [missing[0] ?? 'RESEND_API_KEY'],
      message: `Email is partially configured. Missing: ${missing.join(', ')}`,
    });
  }
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const parsed = schemaWithChecks.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: forget the memoised config so a test can vary process.env. */
export function resetConfigForTests(): void {
  cached = undefined;
}
