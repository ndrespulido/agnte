/**
 * Neon branch lifecycle for preview environments (docs/architecture.md §7).
 *
 * A script rather than inline curl in the workflow, so the parts that can be
 * wrong — reusing an existing branch, extracting both connection URIs, deciding
 * which branches are orphaned — are testable against a mock API. See
 * tests/integration/neon-branch.test.ts.
 *
 * Commands:
 *   create --pr 12     create or reuse pr-12, emit its connection URIs
 *   delete --pr 12     delete pr-12 if it exists
 *   orphans --open 1,4 list pr-* branches with no matching open pull request
 *
 * Environment: NEON_API_KEY, NEON_PROJECT_ID, optionally NEON_API_URL.
 */

const API = process.env.NEON_API_URL ?? 'https://console.neon.tech/api/v2';
const PROJECT = process.env.NEON_PROJECT_ID;
const KEY = process.env.NEON_API_KEY;

const BRANCH_PREFIX = 'pr-';
const DATABASE = process.env.NEON_DATABASE ?? 'neondb';
const ROLE = process.env.NEON_ROLE ?? 'neondb_owner';

function fail(message) {
  console.error(`neon-branch: ${message}`);
  process.exit(1);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...options.headers,
    },
  });

  const body = await response.text();
  if (!response.ok) {
    // The key itself must never reach the log; the status and Neon's own
    // message are enough to act on.
    fail(
      `${options.method ?? 'GET'} ${path} -> ${response.status}: ${body.slice(0, 400)}`,
    );
  }
  return body ? JSON.parse(body) : {};
}

const listBranches = async () =>
  (await api(`/projects/${PROJECT}/branches`)).branches ?? [];

async function connectionUris(branchId) {
  const query = (pooled) =>
    `/projects/${PROJECT}/connection_uri?branch_id=${encodeURIComponent(branchId)}` +
    `&database_name=${encodeURIComponent(DATABASE)}&role_name=${encodeURIComponent(ROLE)}` +
    `&pooled=${pooled}`;

  const [pooled, direct] = await Promise.all([api(query(true)), api(query(false))]);

  return { pooled: pooled.uri, direct: direct.uri };
}

/**
 * Reuses an existing branch rather than failing. A pull request is pushed to
 * repeatedly, and every push re-runs this; recreating the branch each time
 * would discard the database the previous run migrated.
 */
async function create(pr) {
  const name = `${BRANCH_PREFIX}${pr}`;
  const existing = (await listBranches()).find((branch) => branch.name === name);

  let branchId;
  if (existing) {
    branchId = existing.id;
    console.error(`neon-branch: reusing ${name} (${branchId})`);
  } else {
    const created = await api(`/projects/${PROJECT}/branches`, {
      method: 'POST',
      body: JSON.stringify({
        branch: { name },
        endpoints: [{ type: 'read_write' }],
      }),
    });
    branchId = created.branch.id;
    console.error(`neon-branch: created ${name} (${branchId})`);
  }

  const { pooled, direct } = await connectionUris(branchId);
  if (!pooled || !direct) fail('Neon did not return both connection URIs');

  // Masked before being emitted, so neither URI can surface in a log line from
  // any later step — they carry the branch password.
  console.log(`::add-mask::${pooled}`);
  console.log(`::add-mask::${direct}`);

  const out = [
    `branch_id=${branchId}`,
    `branch_name=${name}`,
    `database_url=${pooled}`,
    `direct_url=${direct}`,
  ].join('\n');

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `${out}\n`);
  } else {
    console.log(out);
  }
}

/** Deleting an absent branch is success: teardown must be safe to re-run. */
async function remove(pr) {
  const name = `${BRANCH_PREFIX}${pr}`;
  const existing = (await listBranches()).find((branch) => branch.name === name);

  if (!existing) {
    console.error(`neon-branch: ${name} does not exist; nothing to delete`);
    return;
  }

  await api(`/projects/${PROJECT}/branches/${existing.id}`, { method: 'DELETE' });
  console.error(`neon-branch: deleted ${name} (${existing.id})`);
}

/**
 * Branches whose pull request is no longer open. The free plan caps branch
 * count, so teardown-on-close is load-bearing rather than tidiness — and it
 * does not always run: a workflow edited mid-pull-request, a force-push, a
 * cancelled job. This is the backstop.
 */
export function findOrphans(branches, openPrNumbers) {
  const open = new Set(openPrNumbers.map(String));
  return branches
    .filter((branch) => branch.name?.startsWith(BRANCH_PREFIX))
    .filter((branch) => !open.has(branch.name.slice(BRANCH_PREFIX.length)))
    .map((branch) => branch.name);
}

async function orphans(openList) {
  const found = findOrphans(await listBranches(), openList);
  console.log(found.join('\n'));
}

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

// Only run the CLI when executed directly. Tests import findOrphans from this
// file, and an env-var guard would have to be remembered at every import site;
// this cannot be forgotten.
const { pathToFileURL } = await import('node:url');
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (!KEY || !PROJECT) fail('NEON_API_KEY and NEON_PROJECT_ID must be set');

  const pr = flag('pr');
  if (command === 'create') {
    if (!pr) fail('create needs --pr <number>');
    await create(pr);
  } else if (command === 'delete') {
    if (!pr) fail('delete needs --pr <number>');
    await remove(pr);
  } else if (command === 'orphans') {
    await orphans((flag('open') ?? '').split(',').filter(Boolean));
  } else {
    fail(
      `unknown command ${JSON.stringify(command)}; expected create, delete or orphans`,
    );
  }
}
