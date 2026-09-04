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
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
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
