import { loadConfig } from '@/shared/infra/config';
import { runChecks } from '@/shared/infra/checks';

// The whole point of this page is live runtime state, so it must be rendered
// per request rather than baked into the build.
export const dynamic = 'force-dynamic';

const ENVIRONMENT_LABEL: Record<string, string> = {
  local: 'Local development',
  preview: 'Preview',
  production: 'Production',
};

export default async function StatusPage() {
  const config = loadConfig();
  const checks = await runChecks();

  return (
    <main>
      <h1>Agnte</h1>
      <p className="lede">
        Deployment status. No application features yet — this page exists to prove the
        path from a commit to a URL you can open.
      </p>

      <h2>Build</h2>
      <dl>
        <div className="row">
          <dt>Environment</dt>
          <dd>{ENVIRONMENT_LABEL[config.APP_ENV] ?? config.APP_ENV}</dd>
        </div>
        {config.PREVIEW_LABEL ? (
          <div className="row">
            <dt>Preview</dt>
            <dd>{config.PREVIEW_LABEL}</dd>
          </div>
        ) : null}
        <div className="row">
          <dt>Commit</dt>
          <dd>{config.GIT_SHA}</dd>
        </div>
        <div className="row">
          <dt>Neon branch</dt>
          <dd>{config.NEON_BRANCH ?? '—'}</dd>
        </div>
        <div className="row">
          <dt>Server time</dt>
          <dd>{new Date().toISOString()}</dd>
        </div>
      </dl>

      <h2>Dependencies</h2>
      <div>
        {checks.map((check) => (
          <div className="check" key={check.name}>
            <span className="dot" data-status={check.status} aria-hidden="true" />
            <span className="check-name">{check.name}</span>
            <span className="check-detail">{check.detail}</span>
          </div>
        ))}
      </div>

      <footer>
        Machine-readable at <a href="/v1/health">/v1/health</a>.
      </footer>
    </main>
  );
}
