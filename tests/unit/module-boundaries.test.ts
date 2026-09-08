import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The module boundaries in architecture.md §1.1 are only real if the build
 * rejects a violation. This test writes throwaway files into the source tree,
 * lints them, and asserts on the errors — so a config change that silently
 * stops enforcing the boundary fails here rather than in review.
 *
 * import/no-restricted-paths resolves imports to file paths, so the fixtures
 * have to exist on disk, at paths the zones actually name.
 *
 * ---------------------------------------------------------------------------
 * This test used to write whole fake modules called `verse` and `media` into
 * src/modules and then `rm -rf` those two directories in afterAll. That was
 * harmless for exactly as long as no module by those names existed. When the
 * real `verse` module landed, every test run silently deleted it — including
 * three times in the session that built it, each time looking like the
 * container had lost the files.
 *
 * So the rules now are:
 *
 *   - fixtures are individual files with unmistakable names, never directories;
 *   - they live in directories that already exist, and none is ever removed;
 *   - a fixture path that already exists aborts the run rather than clobbering
 *     whatever is there;
 *   - cleanup unlinks exactly the paths this file created, one by one.
 *
 * The general rule behind all four: a test may not delete anything it did not
 * create, and `rm -rf` of a path built from a name that a real thing could also
 * have is not a cleanup strategy.
 * ---------------------------------------------------------------------------
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MODULES_DIR = join(ROOT, 'src', 'modules');

/**
 * The importing side is `verse`, the target is `identity`. Both are real
 * modules that exist and will keep existing, so nothing has to be conjured —
 * the fixtures import real internal files, which is what the rule is about.
 */
const FIXTURES: Record<string, string> = {
  // Violation: reaching past another module's index.ts, relative form.
  'verse/application/__boundary_fixture_relative.ts':
    `import type { User } from '../../identity/domain/user';\n` +
    `export type Used = User;\n`,

  // Violation: the same thing through the path alias.
  'verse/application/__boundary_fixture_aliased.ts':
    `import type { User } from '@/modules/identity/domain/user';\n` +
    `export type Used = User;\n`,

  // Violation: a domain layer importing a framework.
  'verse/domain/__boundary_fixture_framework.ts':
    `import { NextResponse } from 'next/server';\n` +
    `export const used = NextResponse;\n`,

  // Permitted: another module through its public surface.
  'verse/application/__boundary_fixture_allowed.ts':
    `import { isVerified } from '@/modules/identity';\n` +
    `export const used = isVerified;\n`,
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

let results: ESLint.LintResult[];

const resultFor = (relativePath: string): ESLint.LintResult => {
  const absolute = join(MODULES_DIR, relativePath);
  const found = results.find((r) => r.filePath === absolute);
  if (!found) throw new Error(`No lint result for ${relativePath}`);
  return found;
};

const ruleIds = (relativePath: string): (string | null)[] =>
  resultFor(relativePath).messages.map((m) => m.ruleId);

beforeAll(async () => {
  for (const [relativePath, contents] of Object.entries(FIXTURES)) {
    const absolute = join(MODULES_DIR, relativePath);

    // Refuse to overwrite. A leftover from a crashed run is worth a loud
    // failure; a real file at one of these paths would mean the naming
    // convention has been broken and this test is about to destroy source.
    if (await exists(absolute)) {
      throw new Error(
        `Fixture path already exists: ${relativePath}. ` +
          'Delete it if it is a leftover, or rename the fixture — this test ' +
          'must never write over a file it did not create.',
      );
    }

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }

  const eslint = new ESLint({ cwd: ROOT });
  results = await eslint.lintFiles([join(MODULES_DIR, '**/*.ts')]);
}, 60_000);

afterAll(async () => {
  // Exactly the paths written above, and nothing else. No directory is removed.
  for (const relativePath of Object.keys(FIXTURES)) {
    await rm(join(MODULES_DIR, relativePath), { force: true });
  }
});

describe('module boundaries', () => {
  it('rejects a relative import past another module index', () => {
    expect(ruleIds('verse/application/__boundary_fixture_relative.ts')).toContain(
      'import/no-restricted-paths',
    );
  });

  it('rejects the same deep import written through the path alias', () => {
    expect(ruleIds('verse/application/__boundary_fixture_aliased.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('rejects a framework import inside a domain layer', () => {
    expect(ruleIds('verse/domain/__boundary_fixture_framework.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('permits importing another module through its public surface', () => {
    expect(resultFor('verse/application/__boundary_fixture_allowed.ts').messages).toEqual(
      [],
    );
  });

  it('leaves the real modules alone', async () => {
    // The regression guard for what this file used to do. If a future edit goes
    // back to removing directories, this is what notices.
    expect(await exists(join(MODULES_DIR, 'verse', 'index.ts'))).toBe(true);
    expect(await exists(join(MODULES_DIR, 'identity', 'index.ts'))).toBe(true);
  });
});
