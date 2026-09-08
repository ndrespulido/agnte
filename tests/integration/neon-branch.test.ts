import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script, no types
import { findOrphans } from '../../infra/neon-branch.mjs';

const run = promisify(execFile);

/**
 * Driven against a stand-in Neon API rather than mocked at the module level:
 * this exercises the real HTTP calls, the real JSON shapes and the real CLI,
 * which is where the mistakes live. Neon itself is only reachable from CI.
 */

let server: Server;
let port: number;
let branches: { id: string; name: string }[];
let requests: { method: string; url: string; body?: unknown }[];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({
        method: req.method!,
        url,
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.setHeader('content-type', 'application/json');

      if (req.method === 'GET' && url.endsWith('/branches')) {
        res.end(JSON.stringify({ branches }));
      } else if (req.method === 'POST' && url.endsWith('/branches')) {
        const created = {
          id: `br-${branches.length + 1}`,
          name: JSON.parse(raw).branch.name,
        };
        branches.push(created);
        res.end(JSON.stringify({ branch: created }));
      } else if (req.method === 'DELETE' && url.includes('/branches/')) {
        const id = url.split('/branches/')[1]!;
        branches = branches.filter((b) => b.id !== id);
        res.end('{}');
      } else if (url.startsWith('/projects/p1/connection_uri')) {
        const pooled = url.includes('pooled=true');
        const host = pooled
          ? 'ep-x-pooler.eu-central-1.aws.neon.tech'
          : 'ep-x.eu-central-1.aws.neon.tech';
        res.end(
          JSON.stringify({ uri: `postgresql://u:secret@${host}/neondb?sslmode=require` }),
        );
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'not found' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
}, 20_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  // `main` is the project's default branch — the one holding production data.
  // `preview-base` is the empty branch previews are actually cut from.
  branches = [
    { id: 'br-main', name: 'main' },
    { id: 'br-base', name: 'preview-base' },
  ];
  requests = [];
});

const cli = (...args: string[]) =>
  run('node', ['infra/neon-branch.mjs', ...args], {
    env: {
      ...process.env,
      NEON_API_URL: `http://127.0.0.1:${port}`,
      NEON_PROJECT_ID: 'p1',
      NEON_API_KEY: 'secret-key',
      GITHUB_OUTPUT: '',
    },
  });

describe('create', () => {
  /**
   * The important one.
   *
   * Neon has no empty branch, and omitting `parent_id` is not a neutral
   * default — it means "the project's default branch", which is production. So
   * every preview URL, which is publicly reachable with no access gate, used to
   * be backed by a copy of live accounts.
   */
  it('branches from preview-base, never from the default branch', async () => {
    await cli('create', '--pr', '12');

    const created = requests.find(
      (r) => r.method === 'POST' && r.url.endsWith('/branches'),
    );
    const body = created?.body as { branch?: { parent_id?: string } } | undefined;

    expect(body?.branch?.parent_id).toBe('br-base');
    expect(body?.branch?.parent_id).not.toBe('br-main');
  });

  it('refuses to create a preview when preview-base is missing', async () => {
    // Fails rather than falling back. A preview with no data is an
    // inconvenience; a preview with production's data is an incident.
    branches = [{ id: 'br-main', name: 'main' }];

    await expect(cli('create', '--pr', '12')).rejects.toThrow();
    expect(branches.map((b) => b.name)).not.toContain('pr-12');
  });

  it('says how to fix a missing preview-base', async () => {
    branches = [{ id: 'br-main', name: 'main' }];

    const failure = await cli('create', '--pr', '12').catch((error: unknown) => error);
    const stderr = (failure as { stderr?: string }).stderr ?? '';

    expect(stderr).toContain('preview-base');
    expect(stderr).toContain('ensure-base');
  });

  it('creates a branch named after the pull request', async () => {
    const { stdout } = await cli('create', '--pr', '12');
    expect(branches.map((b) => b.name)).toContain('pr-12');
    expect(stdout).toContain('branch_name=pr-12');
  });

  it('emits both connection URIs, pooled and direct', async () => {
    const { stdout } = await cli('create', '--pr', '12');
    expect(stdout).toMatch(/database_url=postgresql:\/\/.*-pooler\./);
    expect(stdout).toMatch(/direct_url=postgresql:\/\/(?!.*-pooler)/);
  });

  it('masks both URIs so they cannot surface in a later log line', async () => {
    const { stdout } = await cli('create', '--pr', '12');
    const masks = stdout.split('\n').filter((line) => line.startsWith('::add-mask::'));
    expect(masks).toHaveLength(2);
  });

  it('reuses an existing branch rather than recreating it', async () => {
    await cli('create', '--pr', '12');
    requests = [];
    const { stdout } = await cli('create', '--pr', '12');

    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(branches.filter((b) => b.name === 'pr-12')).toHaveLength(1);
    expect(stdout).toContain('branch_name=pr-12');
  });
});

describe('delete', () => {
  it('deletes the branch for the pull request', async () => {
    await cli('create', '--pr', '12');
    await cli('delete', '--pr', '12');
    expect(branches.map((b) => b.name)).not.toContain('pr-12');
  });

  it('leaves other branches alone', async () => {
    await cli('create', '--pr', '12');
    await cli('create', '--pr', '13');
    await cli('delete', '--pr', '12');
    expect(branches.map((b) => b.name)).toEqual(['main', 'preview-base', 'pr-13']);
  });

  it('succeeds when the branch is already gone, so teardown can re-run', async () => {
    await expect(cli('delete', '--pr', '99')).resolves.toBeTruthy();
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });
});

describe('findOrphans', () => {
  const list = (...names: string[]) => names.map((name, i) => ({ id: `br-${i}`, name }));

  it('finds branches whose pull request is closed', () => {
    expect(findOrphans(list('main', 'pr-1', 'pr-2', 'pr-3'), ['1', '3'])).toEqual([
      'pr-2',
    ]);
  });

  it('never touches branches outside the pr- prefix', () => {
    expect(findOrphans(list('main', 'staging', 'production'), [])).toEqual([]);
  });

  it('treats every pr- branch as orphaned when nothing is open', () => {
    expect(findOrphans(list('main', 'pr-1', 'pr-2'), [])).toEqual(['pr-1', 'pr-2']);
  });

  it('does not confuse pr-1 with pr-12', () => {
    expect(findOrphans(list('pr-1', 'pr-12'), ['12'])).toEqual(['pr-1']);
  });
});

describe('failure handling', () => {
  it('exits non-zero on an API error rather than continuing', async () => {
    await expect(
      run('node', ['infra/neon-branch.mjs', 'create', '--pr', '1'], {
        env: {
          ...process.env,
          NEON_API_URL: `http://127.0.0.1:${port}/wrong`,
          NEON_PROJECT_ID: 'p1',
          NEON_API_KEY: 'k',
          GITHUB_OUTPUT: '',
        },
      }),
    ).rejects.toThrow();
  });

  it('does not print the API key in an error', async () => {
    try {
      await run('node', ['infra/neon-branch.mjs', 'create', '--pr', '1'], {
        env: {
          ...process.env,
          NEON_API_URL: `http://127.0.0.1:${port}/wrong`,
          NEON_PROJECT_ID: 'p1',
          NEON_API_KEY: 'super-secret-key',
          GITHUB_OUTPUT: '',
        },
      });
      throw new Error('should have failed');
    } catch (error) {
      const text = String((error as { stderr?: string }).stderr ?? error);
      expect(text).not.toContain('super-secret-key');
    }
  });
});
