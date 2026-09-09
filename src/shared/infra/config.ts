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

  /**
   * HMAC key for signing access tokens (architecture.md §4).
   *
   * 32 bytes minimum, which is the output size of the SHA-256 that HS256 uses —
   * a shorter key adds no security and a longer one adds none either, since
   * HMAC folds it back to the block size.
   *
   * Unset in local development means a throwaway key generated per process, so
   * `npm run dev` needs no configuration (§7.1). Unset in a deployed
   * environment means sign-in answers 503: signing with a value that vanishes
   * on the next cold start would log everyone out at random.
   */
  JWT_SECRET: z.string().min(32).optional(),

  /**
   * Google OAuth (architecture.md §4). Both required together.
   *
   * Unset means Google sign-in is simply not offered — which is the normal
   * state for every preview environment, because Google does not accept
   * wildcard redirect URIs and a per-pull-request URL cannot be registered in
   * advance. Previews use the email and password path.
   */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  /**
   * Deferred work (architecture.md §1.3): Cloud Tasks in a deployed
   * environment, an in-process loopback locally.
   *
   * `GCP_PROJECT_ID` and `GCP_REGION` are not required together with each
   * other in the schema sense — both are needed to create a task, but neither
   * on its own is a dropped secret the way half of R2 would be, and requiring
   * the pair here would duplicate a check the Cloud Tasks adapter already has
   * to make (it needs a queue name too, and three-way refinements read worse
   * than they save).
   */
  GCP_PROJECT_ID: z.string().min(1).optional(),
  GCP_REGION: z.string().min(1).optional(),
  CLOUD_TASKS_QUEUE: z.string().min(1).default('agnte-media-thumbnails'),

  /**
   * Shared secret for `/internal/*` routes (architecture.md §1.3).
   *
   * Cloud Run runs this service with `--allow-unauthenticated` — required
   * because previews need a URL reachable from a phone with no Google account
   * — so Cloud Run's own IAM cannot be the thing that keeps `/internal/*`
   * private. This header is: the enqueuing code reads it from the same place
   * the route checks it, so a task Cloud Tasks delivers carries a value only
   * this deployment could have produced.
   *
   * Unset locally means the in-process adapter calls the route directly over
   * loopback with no header at all, and the route's local-environment check
   * (identical in spirit to the JWT and email "no config needed for `npm run
   * dev`" rule, §7.1) accepts that. Unset in a deployed environment means
   * deferred work cannot run: the status page says so, and the routes that
   * would enqueue a job answer 503 rather than queuing work nothing can ever
   * authorize.
   */
  INTERNAL_TASKS_SECRET: z.string().min(32).optional(),
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

const GOOGLE_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;

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

  const googlePresent = GOOGLE_KEYS.filter((key) => value[key] !== undefined);
  if (googlePresent.length > 0 && googlePresent.length < GOOGLE_KEYS.length) {
    const missing = GOOGLE_KEYS.filter((key) => value[key] === undefined);
    ctx.addIssue({
      code: 'custom',
      path: [missing[0] ?? 'GOOGLE_CLIENT_ID'],
      message: `Google OAuth is partially configured. Missing: ${missing.join(', ')}`,
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
