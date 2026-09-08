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
 *   ensure-base        create the empty `preview-base` branch, once
 *
 * Environment: NEON_API_KEY, NEON_PROJECT_ID, optionally NEON_API_URL and
 * NEON_PREVIEW_PARENT.
 *
 * ---------------------------------------------------------------------------
 * Previews are branched from `preview-base`, never from the default branch.
 *
 * Neon has no "empty branch": every branch is copy-on-write from a parent, and
 * omitting `parent_id` silently uses the project's *default* branch — which is
 * production. That is what this script used to do, so every preview URL was
 * backed by a copy of live accounts and, since previews are publicly
 * reachable with no access gate, that was a real exposure rather than a
 * theoretical one.
 *
 * So the parent is explicit and required. If `preview-base` does not exist,
 * this fails rather than falling back: a preview with no data is an
 * inconvenience, a preview with production's data is an incident.
 *
 * `preview-base` is created once by `ensure-base`, which branches it from the
 * default branch and then empties every table — see docs/operations.md.
 * ---------------------------------------------------------------------------
 */

const API = process.env.NEON_API_URL ?? 'https://console.neon.tech/api/v2';
const PROJECT = process.env.NEON_PROJECT_ID;
const KEY = process.env.NEON_API_KEY;

const BRANCH_PREFIX = 'pr-';

/** The branch every preview is cut from. Never the project's default branch. */
const PARENT_BRANCH = process.env.NEON_PREVIEW_PARENT ?? 'preview-base';
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
    // Resolved before creating, and fatal when absent. Omitting parent_id is
    // not a neutral default — Neon reads it as "the default branch", which is
    // production.
    const parent = (await listBranches()).find((branch) => branch.name === PARENT_BRANCH);
    if (!parent) {
      fail(
        `parent branch "${PARENT_BRANCH}" does not exist. Previews are never ` +
          'branched from the default branch, which holds production data. ' +
          'Create it once with: node infra/neon-branch.mjs ensure-base',
      );
    }

    const created = await api(`/projects/${PROJECT}/branches`, {
      method: 'POST',
      body: JSON.stringify({
        branch: { name, parent_id: parent.id },
        endpoints: [{ type: 'read_write' }],
      }),
    });
    branchId = created.branch.id;
    console.error(`neon-branch: created ${name} from ${PARENT_BRANCH} (${branchId})`);
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

/**
 * Creates `preview-base` and empties it, once.
 *
 * Neon cannot make an empty branch, so this cuts one from the default branch —
 * which does hold production data — and then truncates every table before the
 * branch is ever used. The window in which the copy exists is this function,
 * on a branch nothing is deployed against.
 *
 * `_prisma_migrations` in `public` is deliberately left alone: the schema and
 * its migration history are exactly what a preview wants to inherit. Only the
 * rows go.
 *
 * Re-running is safe and does nothing when the branch already exists, because
 * emptying a base that previews have already been cut from would not affect
 * them anyway — and silently re-truncating a branch someone may have seeded on
 * purpose would be worse than a no-op.
 */
async function ensureBase() {
  const existing = (await listBranches()).find((branch) => branch.name === PARENT_BRANCH);
  if (existing) {
    console.error(`neon-branch: ${PARENT_BRANCH} already exists (${existing.id})`);
    return;
  }

  const created = await api(`/projects/${PROJECT}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: { name: PARENT_BRANCH },
      endpoints: [{ type: 'read_write' }],
    }),
  });
  const branchId = created.branch.id;
  console.error(`neon-branch: created ${PARENT_BRANCH} (${branchId}) — emptying it`);

  const { direct } = await connectionUris(branchId);
  if (!direct) fail('Neon did not return a direct connection URI for the base branch');

  // Prove the URI is not production's before running a TRUNCATE down it.
  //
  // The rest of this function empties every table it can reach. It reaches
  // whatever `connection_uri?branch_id=...` returned, and this script has never
  // run against real Neon — so "the API honoured branch_id" is an assumption,
  // and the cost of it being wrong is the production database. Comparing
  // against the default branch's own URI turns that assumption into a check.
  const defaultBranch = (await listBranches()).find((branch) => branch.default);
  if (defaultBranch) {
    const { direct: defaultDirect } = await connectionUris(defaultBranch.id);
    if (defaultDirect && hostOf(defaultDirect) === hostOf(direct)) {
      fail(
        'refusing to truncate: the connection URI for the new branch is the ' +
          "same host as the default branch's. Neon did not give a separate " +
          'endpoint, and emptying it would empty production. Delete the ' +
          `${PARENT_BRANCH} branch and investigate before retrying.`,
      );
    }
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString: direct });
  await client.connect();
  try {
    // Every table in every module schema, in one statement, so a table added by
    // a future migration is covered without this list being updated. CASCADE
    // because the foreign keys inside a schema would otherwise order it.
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT schemaname, tablename FROM pg_tables
          WHERE schemaname IN
            ('platform','identity','verse','media','insights','notifications','privacy')
        LOOP
          EXECUTE format('TRUNCATE TABLE %I.%I CASCADE', r.schemaname, r.tablename);
        END LOOP;
      END $$;
    `);
  } finally {
    await client.end();
  }

  console.error(`neon-branch: ${PARENT_BRANCH} is empty and ready`);
}

/**
 * The host of a Postgres URI, or null when it cannot be parsed.
 *
 * Compared rather than the whole URI because Neon rotates the password in the
 * string: two URIs for the same endpoint can differ in every character after
 * the host and still point at the same database.
 */
export function hostOf(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return null;
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
  // Naming the one that is missing, and where it lives. The first real run of
  // the preview workflow failed here with the secret set and the variable not,
  // and a message listing both does not tell you which half to go and fix.
  const missing = [];
  if (!KEY)
    missing.push(
      'NEON_API_KEY (Settings -> Secrets and variables -> Actions -> Secrets)',
    );
  if (!PROJECT) {
    missing.push(
      'NEON_PROJECT_ID (same page, Variables tab; the id is in Neon project settings)',
    );
  }
  if (missing.length > 0) fail(`not configured:\n  - ${missing.join('\n  - ')}`);

  const pr = flag('pr');
  if (command === 'create') {
    if (!pr) fail('create needs --pr <number>');
    await create(pr);
  } else if (command === 'delete') {
    if (!pr) fail('delete needs --pr <number>');
    await remove(pr);
  } else if (command === 'orphans') {
    await orphans((flag('open') ?? '').split(',').filter(Boolean));
  } else if (command === 'ensure-base') {
    await ensureBase();
  } else {
    fail(
      `unknown command ${JSON.stringify(command)}; ` +
        'expected create, delete, orphans or ensure-base',
    );
  }
}
