import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The module boundaries in architecture.md §1.1 are only real if the build
 * rejects a violation. This test writes throwaway modules into src/modules,
 * lints them, and asserts on the errors — so a config change that silently
 * stops enforcing the boundary fails here rather than in review.
 *
 * import/no-restricted-paths resolves imports to file paths, so the fixtures
 * have to exist on disk and sit at the paths the zones name.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MODULES_DIR = join(ROOT, 'src', 'modules');

const fixtures: Record<string, string> = {
  'verse/index.ts': `export const verse = 'public surface';\n`,
  'verse/domain/entity.ts': `export const entity = 'internal';\n`,
  'media/index.ts': `export const media = 'public surface';\n`,

  // Violation: reaching past another module's index.ts.
  'media/application/deep-import.ts': `import { entity } from '../../verse/domain/entity';\nexport const used = entity;\n`,

  // Violation: same thing via the path alias.
  'media/application/aliased-deep-import.ts': `import { entity } from '@/modules/verse/domain/entity';\nexport const used = entity;\n`,

  // Violation: a domain layer importing a framework.
  'media/domain/framework-import.ts': `import { NextResponse } from 'next/server';\nexport const used = NextResponse;\n`,

  // Permitted: the public surface of another module.
  'media/application/allowed-import.ts': `import { verse } from '@/modules/verse';\nexport const used = verse;\n`,
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
  for (const [relativePath, contents] of Object.entries(fixtures)) {
    const absolute = join(MODULES_DIR, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }

  const eslint = new ESLint({ cwd: ROOT });
  results = await eslint.lintFiles([join(MODULES_DIR, '**/*.ts')]);
}, 60_000);

afterAll(async () => {
  await rm(join(MODULES_DIR, 'verse'), { recursive: true, force: true });
  await rm(join(MODULES_DIR, 'media'), { recursive: true, force: true });
});

describe('module boundaries', () => {
  it('rejects a relative import past another module index', () => {
    expect(ruleIds('media/application/deep-import.ts')).toContain(
      'import/no-restricted-paths',
    );
  });

  it('rejects the same deep import written through the path alias', () => {
    expect(ruleIds('media/application/aliased-deep-import.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('rejects a framework import inside a domain layer', () => {
    expect(ruleIds('media/domain/framework-import.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('permits importing another module through its public surface', () => {
    expect(resultFor('media/application/allowed-import.ts').messages).toEqual([]);
  });
});
