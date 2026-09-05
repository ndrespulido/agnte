import { loadConfig } from '@/shared/infra/config';
import { isHealthy, runChecks } from '@/shared/infra/checks';

// Health reflects live process state, so it must never be prerendered or cached.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const config = loadConfig();
  const checks = await runChecks();
  const healthy = isHealthy(checks);

  return Response.json(
    {
      status: healthy ? 'ok' : 'failed',
      environment: config.APP_ENV,
      commit: config.GIT_SHA,
      neonBranch: config.NEON_BRANCH ?? null,
      preview: config.PREVIEW_LABEL ?? null,
      time: new Date().toISOString(),
      checks,
    },
    {
      status: healthy ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
