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
