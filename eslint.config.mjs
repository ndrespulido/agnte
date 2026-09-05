import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import next from 'eslint-config-next';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

/**
 * The six modules from docs/architecture.md §1. Adding a module here is what
 * switches its boundary enforcement on, so the list is the source of truth.
 */
const MODULES = ['identity', 'verse', 'media', 'insights', 'notifications', 'privacy'];

const BOUNDARY_MESSAGE =
  'Module boundary (architecture.md §1.1): a module may only be reached through ' +
  'its index.ts. Import "@/modules/<name>", never a path inside it.';

/**
 * Zones for import/no-restricted-paths. Unlike no-restricted-imports, this rule
 * resolves the import to a file path first, so it catches the relative form
 * ("../../verse/domain/x") as well as the aliased one — and it can allow a
 * module to reach its own internals while forbidding everyone else.
 */
const boundaryZones = [
  // 1. No module may reach into another module's internals.
  ...MODULES.flatMap((target) =>
    MODULES.filter((from) => from !== target).map((from) => ({
      target: `./src/modules/${target}`,
      from: `./src/modules/${from}`,
      except: ['./index.ts'],
      message: BOUNDARY_MESSAGE,
    })),
  ),

  // 2. The app layer is thin: it calls module public APIs and nothing deeper.
  ...MODULES.map((from) => ({
    target: './src/app',
    from: `./src/modules/${from}`,
    except: ['./index.ts'],
    message: BOUNDARY_MESSAGE,
  })),

  // 3. shared/ is a dependency of modules, never a consumer of them.
  {
    target: './src/shared',
    from: './src/modules',
    message:
      'shared/ must not depend on a module — that would invert the dependency ' +
      'direction and re-couple the modules through shared code.',
  },

  // 4. Domain is pure: no infrastructure, not even shared infrastructure.
  ...MODULES.map((target) => ({
    target: `./src/modules/${target}/domain`,
    from: './src/shared/infra',
    message:
      'domain/ must not import infrastructure (architecture.md §1). Depend on a ' +
      'port defined in domain/ and let infrastructure/ implement it.',
  })),
];

/** Packages that must never appear in a domain layer. */
const FRAMEWORK_AND_ORM = [
  { name: 'next', message: 'domain/ must not import a framework.' },
  { name: 'react', message: 'domain/ must not import a framework.' },
  { name: 'react-dom', message: 'domain/ must not import a framework.' },
  { name: '@prisma/client', message: 'domain/ must not import an ORM.' },
  { name: 'pg', message: 'domain/ must not import a database driver.' },
];

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,

  {
    settings: {
      // import/no-restricted-paths has to resolve an import to a file path
      // before it can decide which zone it crosses, so the "@/" alias from
      // tsconfig must be resolvable here too.
      'import/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          project: './tsconfig.json',
        }),
      ],
    },
    rules: {
      'import/no-restricted-paths': ['error', { zones: boundaryZones }],

      // The alias form is caught by no-restricted-paths above, but only once a
      // module directory exists on disk. This catches it unconditionally, which
      // matters while modules are still being created.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/modules/*/*', '@/modules/*/*/**'],
              message: BOUNDARY_MESSAGE,
            },
          ],
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Type-aware rules, scoped to source and tests. Config files at the repo root
  // are not in tsconfig, and asking the project service to type them fails.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FRAMEWORK_AND_ORM,
          patterns: [
            { group: ['next/*'], message: 'domain/ must not import a framework.' },
            {
              group: ['@/shared/infra', '@/shared/infra/**'],
              message:
                'domain/ must not import infrastructure. Define a port here and ' +
                'implement it in infrastructure/.',
            },
            { group: ['@/modules/*/*', '@/modules/*/*/**'], message: BOUNDARY_MESSAGE },
          ],
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'import/no-restricted-paths': 'off',
    },
  },
);
